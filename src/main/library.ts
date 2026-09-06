import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_NAME, SEARCH_DEFAULT_LIMIT } from '@shared/constants'
import type {
  AppSettings,
  CandidateRoot,
  CodexSession,
  ExportRequest,
  ImportResult,
  Platform,
  PrivacyNotice,
  RedactionReport,
  ScanIssue,
  ScanProgress,
  ScanRequest,
  ScanResult,
  SearchHit,
  SearchIndexFile,
  SearchRequest,
  SearchResponse,
  SessionSummary,
  StatsOverview
} from '@shared/types'
import { PRIVACY_POINTS } from '@shared/constants'
import { maskHomePaths } from '@shared/paths'
import { renderExport, type RenderedExport } from './exporters'
import { maybeMaskSessionPaths, maybeMaskSummaryPaths } from './redaction/maskPaths'
import { maybeRedactSession, maybeRedactSummary, redactSession } from './redaction/redact'
import { createCollector } from './redaction/report'
import { buildScanRoots, isUnderDir, normalizePathKey, parentDirKey } from './scanner/paths'
import {
  loadFilesDirectly,
  runScan,
  type KnownFile,
  type ScanEngineResult
} from './scanner/scanner'
import type { FileSystemAccess } from './scanner/fsAccess'
import {
  collectSummaryTerms,
  collectTerms,
  emptyIndex,
  mergeIndex,
  queryIndex
} from './search/invertedIndex'
import { parseQuery, type ParsedQuery } from './search/tokenize'
import { locateHits } from './search/locate'
import { computeStats } from './stats/stats'
import type { LocalStore } from './storage/store'
import { toSummary } from './parsers/buildSession'

export interface LibraryDeps {
  store: LocalStore
  fs: FileSystemAccess
  platform: Platform
  env: Record<string, string | undefined>
  homeDir: string | null
  /** 内置示例数据目录（开发时是仓库里的 fixtures/，打包后是 resources/fixtures）。 */
  sampleDir: string | null
}

/**
 * 会话库：主进程里唯一持有会话数据的地方。
 *
 * - 只有摘要会被持久化（session-index.json），事件内容按需从原始文件重新解析；
 * - 送往界面的数据统一在这里打码，渲染进程永远拿不到未打码的密钥；
 * - 任何操作都不会修改用户的原始文件。
 */
/**
 * 内存里最多同时保留几个"完整会话"（含全部事件与原始 JSON）。
 *
 * 单个会话的事件可能有几万条，几个 GB 的日志目录里有上千个会话 ——
 * 全留着必然 OOM。索引里只有摘要，事件按需从原始文件重新解析。
 */
const SESSION_CACHE_LIMIT = 3

/**
 * 降级检索时给用户的两句话。
 *
 * 措辞的要点是让人知道"这次没搜全文"，而不是"没搜到" —— 后者会让用户换一个词
 * 再搜一遍，而真正该做的事是重新扫描一次（或者把开关打开）。
 */
const SEARCH_NOTICE_DISABLED = '全文索引已关闭，这次只搜了标题。'
const SEARCH_NOTICE_MISSING =
  '还没有全文索引（或索引已损坏），这次只搜了标题。重新扫描一次就能建好。'

export class SessionLibrary {
  private index: SessionSummary[] = []
  /**
   * 全文倒排表：内存里的这一份就是 search-index.json 里的那一份。
   *
   * `null` 和空表是两件事，绝不能混：`null` 是"没有能用的表"（还没扫过、文件坏了、
   * 或者用户把开关关了），检索要降级成只搜标题并且说清原因；空表是"表是好的，
   * 里面确实一个会话都没有"。
   *
   * 常驻内存的理由只有一个：第一层查询要守住 674 会话下 200 ms，那条路上不许有
   * 文件读取。表最大 30 MB，是这个应用里唯一一处刻意占内存的地方。
   */
  private searchIndex: SearchIndexFile | null = null
  /** 按访问顺序排列的 LRU 缓存：最早插入的排在最前面。 */
  private readonly cache = new Map<string, CodexSession>()
  private cancellation = { cancelled: false }
  private scanning = false
  /**
   * 正在跑的那次扫描。
   *
   * 必须在主进程里挡住并发扫描，界面上禁用按钮是挡不住的：
   * 列表右上角的刷新、空状态里的"开始自动扫描"、"选择文件夹"走的都是各自的入口，
   * IPC 也可以被同时调用两次。两次扫描同时跑会互相踩：
   * 它们共用一个取消令牌（后来的把前一个的令牌换掉），各自基于同一份旧索引计算，
   * 最后完成的那个把先完成的结果整份覆盖掉。
   */
  private inFlight: { key: string; promise: Promise<ScanResult> } | null = null

  constructor(private readonly deps: LibraryDeps) {}

  /** 界面拿它把设置页里的自定义目录缩写成 `~`（那些路径是用户现场输入的）。 */
  get homeDir(): string | null {
    return this.deps.homeDir
  }

  /** 放进 LRU 缓存，并淘汰最久没用的。 */
  private remember(session: CodexSession): void {
    this.cache.delete(session.id)
    this.cache.set(session.id, session)
    while (this.cache.size > SESSION_CACHE_LIMIT) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }
  }

  private touch(sessionId: string): CodexSession | undefined {
    const session = this.cache.get(sessionId)
    if (!session) return undefined
    this.cache.delete(sessionId)
    this.cache.set(sessionId, session)
    return session
  }

  async init(): Promise<void> {
    this.index = await this.deps.store.getIndex()
    // 读不出来就是 null，不会抛 —— 那一层把"文件不在、JSON 坏了、下标越界"
    // 全部收敛成了 null。启动不能因为一张可以重建的表而失败。
    this.searchIndex = await this.deps.store.getSearchIndex()
  }

  getSettings(): Promise<AppSettings> {
    return this.deps.store.getSettings()
  }

  getAppState(): Promise<{ firstRunCompleted: boolean; lastScanAt: string | null }> {
    return this.deps.store.getState()
  }

  async markFirstRunCompleted(): Promise<void> {
    await this.deps.store.updateState({ firstRunCompleted: true })
  }

  /**
   * 改设置。
   *
   * 只有一项带副作用：全文索引开关由开变关的那一刻，磁盘上那张表立刻删掉，
   * 不等下次扫描。用户关它的理由只有一个 —— 不想让这份正文留在磁盘上；
   * 那么"关掉之后就没有了"必须是当下为真的陈述，而不是一句承诺。
   *
   * 反向（关变开）不自动扫描：那是几百个文件的全量重解析，不该由点一下开关触发。
   * 界面上照常搜，只是会收到"重新扫描一次就能建好"那句提示。
   */
  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const before = await this.getSettings()
    const after = await this.deps.store.updateSettings(patch)

    if (before.buildSearchIndex && !after.buildSearchIndex) {
      this.searchIndex = null
      await this.deps.store.clearSearchIndex()
    }

    return after
  }

  async getCandidateRoots(): Promise<CandidateRoot[]> {
    const settings = await this.getSettings()
    return buildScanRoots({
      platform: this.deps.platform,
      env: this.deps.env,
      useBuiltinDirs: settings.useBuiltinDirs,
      extraDirs: settings.extraScanDirs
    })
  }

  getPrivacyNotice(): PrivacyNotice {
    return {
      title: `${APP_NAME}：数据只保存在本机`,
      points: [...PRIVACY_POINTS],
      storageLocation: this.deps.store.directory
    }
  }

  /**
   * 送往界面之前的最后一道加工：先挡密钥，再把文字里的用户主目录换成 `~`。
   *
   * 两件事都在这里做，是因为这是"数据离开主进程"的唯一出口 ——
   * 摊到各个字段上去各配一份展示副本的做法漏过太多次了（标题、命令、命令输出、
   * 会话标题各漏一轮）。路径字段不受影响，界面还要靠它们定位文件。
   */
  private async forDisplay(): Promise<{
    redact: boolean
    hidePaths: boolean
    paths: { homeDir: string | null; platform: Platform }
  }> {
    const settings = await this.getSettings()
    return {
      redact: settings.redactSensitive,
      hidePaths: !settings.showFullPaths,
      paths: { homeDir: this.deps.homeDir, platform: this.deps.platform }
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const settings = await this.getSettings()
    const { redact, hidePaths, paths } = await this.forDisplay()
    const hidden = new Set(settings.hiddenSessionIds)

    return this.index
      .filter((summary) => !hidden.has(summary.id))
      .map((summary) => maybeRedactSummary(summary, redact))
      .map((summary) => maybeMaskSummaryPaths(summary, hidePaths, paths))
  }

  async getSession(sessionId: string): Promise<CodexSession | null> {
    const { redact, hidePaths, paths } = await this.forDisplay()
    const session = this.touch(sessionId) ?? (await this.loadRaw(sessionId))
    if (session === null) return null

    return maybeMaskSessionPaths(maybeRedactSession(session, redact), hidePaths, paths)
  }

  /**
   * 审计上面那次打码：只交「打掉了什么、什么没打」，不交任何会话内容。
   *
   * 取数走的是和 `getSession` 一样的路（缓存里的原始会话优先，没有就读盘），因为
   * 报告要说的正是「刚才那份会话被怎么处理的」。**打码结果当场丢掉** —— 这条路径
   * 唯一的产物是报告，会话本体一个字符都不往外走。
   *
   * 会话不存在时返回 `null`，不返回一份 `totalHits: 0` 的空报告：「这个会话没有」和
   * 「这个会话里没有密钥」在面板上是两句完全不同的话。
   */
  async auditSession(sessionId: string): Promise<RedactionReport | null> {
    const { redact, hidePaths, paths } = await this.forDisplay()
    const session = this.touch(sessionId) ?? (await this.loadRaw(sessionId))
    if (session === null) return null

    const collector = createCollector()
    redactSession(session, collector)
    // `redact` 在这里是报告里的一个**字段**，不是审计的开关。开关关着的时候这份报告的
    // 意思变成「你现在要分享的是原文，如果打开开关会打掉这些」—— 那正是最该看它的时刻。
    const report = collector.summarize(session.id, redact)
    if (!hidePaths) return report

    return {
      ...report,
      groups: report.groups.map((group) => ({
        ...group,
        // 只洗上下文。`keyName` 是键名（`api_key`、`Cookie`），里面没有路径可洗。
        samples: group.samples.map((sample) => ({
          ...sample,
          maskedContext: maskHomePaths(sample.maskedContext, paths)
        }))
      })),
      // 残留是整份报告里**唯一**显示原文的一段（它本来就没被打码，遮起来是自欺）。
      // 漏掉这一步，这个面板就成了全应用唯一一个漏出真实用户名的地方 —— 和上面防的是
      // 同一类 bug，只是低了一层。分数是**洗之前**算的（可疑度不该被显示口径改变），
      // 显示的是**洗之后**的。
      residuals: report.residuals.map((residual) => {
        // 截断与否必须在洗之前判：`report.ts` 那一刀（切到 REDACTION_RESIDUAL_MAX_TEXT）
        // 是唯一会造成「只显示开头」的地方，此刻 `length` 与 `text` 都还没被这一层动过。
        const truncated = residual.length > residual.text.length
        const text = maskHomePaths(residual.text, paths)
        return {
          ...residual,
          text,
          // 洗主目录会把 `C:\Users\某某` 换成 `~`，`text` 因此变短而 `length` 不动 ——
          // 一条只有 80 字符、根本没被截断的残留于是被说成「共 80 字符，只显示开头」。
          // 少掉的那几个字符是洗掉的，不是截掉的，那句话是假的。
          // 没截断就让 length 跟着缩到相等，界面自然不再提；真截断了就原样保留，
          // 「共 N 字符」说的仍是截断前的真实长度。
          length: truncated ? residual.length : text.length
        }
      })
    }
  }

  cancelScan(): void {
    this.cancellation.cancelled = true
  }

  get isScanning(): boolean {
    return this.scanning
  }

  /**
   * 同一次扫描请求的指纹。用来区分"重复点了同一个按钮"和"要扫的其实不是一个地方"。
   */
  private static requestKey(request: ScanRequest | undefined): string {
    const roots = [...(request?.roots ?? [])].sort().join('|')
    return `${request?.merge === false ? 'replace' : 'merge'}#${roots}`
  }

  async scan(
    request: ScanRequest | undefined,
    onProgress: (progress: ScanProgress) => void
  ): Promise<ScanResult> {
    const key = SessionLibrary.requestKey(request)

    if (this.inFlight) {
      // 同一个请求（多半是连点了两下）——直接等着那一次的结果，不重复跑。
      if (this.inFlight.key === key) return this.inFlight.promise
      // 要扫的地方不一样：不能悄悄拿另一次的结果糊弄用户，明确说清楚。
      return this.busyResult(request)
    }

    const promise = this.runScan(request, onProgress).finally(() => {
      this.inFlight = null
    })
    this.inFlight = { key, promise }
    return promise
  }

  /** 扫描进行中时对冲突请求的答复。 */
  private async busyResult(request: ScanRequest | undefined): Promise<ScanResult> {
    const now = new Date()
    const roots: CandidateRoot[] = (request?.roots ?? []).map((path) => ({
      path,
      label: '你选择的文件夹',
      origin: 'custom' as const
    }))

    return {
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 0,
      roots,
      sessions: await this.listSessions(),
      issues: [
        {
          path: roots[0]?.path ?? '',
          displayPath: roots[0]?.path ?? '',
          kind: 'busy',
          reason: '上一次扫描还在进行，这一次没有开始。',
          suggestion: '等当前扫描结束（或点"取消"停掉它）之后再试一次。'
        }
      ],
      cancelled: true,
      progress: {
        phase: 'cancelled',
        currentPath: '',
        dirsVisited: 0,
        filesScanned: 0,
        candidatesFound: 0,
        sessionsFound: 0,
        percent: 0,
        message: '上一次扫描还在进行。'
      }
    }
  }

  /**
   * 本次扫描没看到这个文件 —— 能断定它真的不在磁盘上了吗？
   *
   * 只有两种情况算数：文件所在的那个目录本次被**完整列过**一遍，
   * 或者它头上某一级目录已确认整棵不存在。
   *
   * 「没看到」和「不存在」差得很远，而扫描半途而废的方式多得是：目录被权限挡住、
   * 目录数或候选数触顶提前收工、超过 maxDepth 没往里走、命中忽略名单。
   * 这些情况下 result.cancelled 都是 false，可磁盘上的实情我们根本没看清。
   * 原来只要「在扫描根目录之下」就敢删，于是用户仅仅是调低了搜索深度、
   * 或者某个子目录读不动，好好的索引条目就被判成"文件已删除"清掉了。
   */
  private provablyGone(sourceFile: string, result: ScanEngineResult): boolean {
    const platform = this.deps.platform
    if (result.enumeratedDirKeys.has(parentDirKey(sourceFile, platform))) return true

    const key = normalizePathKey(sourceFile, platform)
    return result.absentDirKeys.some((absent) => isUnderDir(key, absent))
  }

  private async runScan(
    request: ScanRequest | undefined,
    onProgress: (progress: ScanProgress) => void
  ): Promise<ScanResult> {
    const settings = await this.getSettings()
    const startedAt = new Date()
    this.cancellation = { cancelled: false }
    this.scanning = true

    const roots: CandidateRoot[] =
      request?.roots && request.roots.length > 0
        ? request.roots.map((path) => ({ path, label: '你选择的文件夹', origin: 'custom' as const }))
        : await this.getCandidateRoots()

    const merge = request?.merge !== false
    const hiddenPaths = new Set(
      settings.hiddenSources.map((path) => normalizePathKey(path, this.deps.platform))
    )

    /**
     * 开扫这一刻的索引。
     *
     * 只用来两件事：决定哪些文件可以复用、以及最后判断哪些旧条目过期了。
     * **不能**拿它当最终结果的底稿 —— 扫描要跑几十秒到几分钟，
     * 这期间用户完全可以导入文件或清空索引（走的是另外的 IPC 入口）。
     * 索引的每个 mutator 都是整份重新赋值，所以这个引用会稳定指向旧数组。
     */
    const snapshot = this.index

    // 扫描过程中只往这里塞摘要；完整会话用完即弃，绝不累积。
    const produced = new Map<string, SessionSummary>()

    /**
     * 本次新解析出来的会话词条，攒着最后并进倒排表。
     *
     * 开关在开扫之前读一次存进局部变量，不在回调里现读：扫描要跑几十秒，
     * 中途改设置不该让这次的表变成半份 —— 前一半会话有词条、后一半没有，
     * 而表本身看不出哪一半缺了。
     */
    const buildSearchIndex = settings.buildSearchIndex
    const producedTerms = new Map<string, ReadonlySet<string>>()

    /**
     * 表里已经有词条的那些会话。
     *
     * 复用一个文件的摘要意味着 `onSession` 压根不会被调到，词条也就无从收集。
     * 所以"能不能复用"这件事，除了文件本身没变，还得加一个条件：它的词条已经在
     * 表里了。少了这个条件，"重新扫描一次就能建好"就是一句空话 —— 表坏掉、被
     * 用户清掉、或者上一次扫描被取消的那部分，都会因为文件没变而被永久跳过。
     */
    const indexedSessionIds = new Set(this.searchIndex?.sessionIds ?? [])

    // 上次索引过、且文件大小与修改时间都没变的文件，可以直接复用，不必重新解析。
    const knownByPath = new Map<string, KnownFile>()
    for (const summary of snapshot) {
      const key = normalizePathKey(summary.sourceFile, this.deps.platform)
      const existing = knownByPath.get(key)
      if (existing) {
        existing.summaries.push(summary)
        continue
      }
      knownByPath.set(key, {
        fileSizeBytes: summary.fileSizeBytes,
        fileModifiedAt: summary.fileModifiedAt,
        summaries: [summary]
      })
    }

    const keep = (summary: SessionSummary): void => {
      if (hiddenPaths.has(normalizePathKey(summary.sourceFile, this.deps.platform))) return
      produced.set(summary.id, summary)
    }

    try {
      const result = await runScan({
        roots,
        settings,
        fs: this.deps.fs,
        homeDir: this.deps.homeDir,
        platform: this.deps.platform,
        cancellation: this.cancellation,
        onProgress,
        lookupKnown: (candidate) => {
          const known = knownByPath.get(normalizePathKey(candidate.path, this.deps.platform)) ?? null
          if (known === null || !buildSearchIndex) return known
          // 见上面 indexedSessionIds 的那段：词条还没进表的文件必须重新解析一遍。
          return known.summaries.every((summary) => indexedSessionIds.has(summary.id))
            ? known
            : null
        },
        onReused: (summaries) => {
          for (const summary of summaries) keep(summary)
          // 这里刻意不收词条：复用的会话本来就在上一张表里，`mergeIndex` 会把它们
          // 的 postings 原样带过去（只重映射下标）。再收一遍等于把整份表重建一次，
          // 而增量扫描的全部意义就是不做这件事。
        },
        onSession: (session) => {
          keep(toSummary(session) as SessionSummary)
          // 词条只能在这一刻收：事件此刻还在内存里，出了这个回调就没了 ——
          // 表里不留正向索引，事后想补只能把文件重新解析一遍。
          //
          // 跟着 `keep` 的判断走（`produced` 里有才收）：隐藏来源的会话不进列表，
          // 也就不该进表 —— 否则它虽然不在界面上，正文还躺在磁盘的那张表里。
          if (buildSearchIndex && produced.has(session.id)) {
            producedTerms.set(session.id, collectTerms(session))
          }
          // 这里刻意不调用 remember()：扫描出来的会话立刻变成垃圾，
          // 用户真正点开某个会话时会重新解析那一个文件。
        }
      })

      // 哪些旧条目被本次扫描证伪了？
      //
      // 只有扫描顺利跑完才谈这件事：中途取消时信息不完整，宁可留着旧条目。
      // 判断对象只限开扫时就在索引里的条目 —— 扫描期间新导入的文件本次压根没看过，
      // 没有立场给它下结论。
      const staleIds = new Set<string>()
      if (!result.cancelled) {
        for (const summary of snapshot) {
          // merge === false 的意思就是「拿这次的结果替换掉旧索引」，旧条目一律作废。
          if (!merge) {
            staleIds.add(summary.id)
            continue
          }

          const key = normalizePathKey(summary.sourceFile, this.deps.platform)

          // 用户把这个来源隐藏了 —— 文件在不在都一样，索引里不该再留着它。
          if (hiddenPaths.has(key)) {
            staleIds.add(summary.id)
            continue
          }

          // 文件被重新解析过，但这个会话这次没再出现（内容变了）→ 是过期条目。
          if (result.refreshedFileKeys.has(key) && !produced.has(summary.id)) {
            staleIds.add(summary.id)
            continue
          }

          if (result.seenFileKeys.has(key)) continue
          if (this.provablyGone(summary.sourceFile, result)) staleIds.add(summary.id)
        }
      }

      // 落盘时以**此刻**的索引为底，而不是开扫时的快照。
      //
      // 快照整份写回去，等于把用户在扫描期间做的事悄悄撤销掉：导入的会话凭空消失、
      // 清空过的索引又整份长回来。改成增量之后，回到列表里的只会是本次真的
      // 在磁盘上看到的东西，不会有一条来自那份已经过时的快照。
      const next = new Map(this.index.map((summary) => [summary.id, summary]))
      for (const id of staleIds) {
        next.delete(id)
        this.cache.delete(id)
      }
      for (const [id, summary] of produced) next.set(id, summary)

      this.index = [...next.values()].sort((a, b) => sortKey(b) - sortKey(a))
      await this.deps.store.saveIndex(this.index)

      const finishedAt = new Date()

      /*
       * 倒排表跟着会话索引一起过期，用的是同一个 staleIds 和同一个 produced。
       *
       * 绝不在这里重新判断一遍"哪些文件真的没了"—— 那个判断是上面 provablyGone
       * 那一串条件，重算一遍必然和会话索引对不齐，而对不齐的症状是搜出来一个
       * 点不开的会话，或者一个明明在列表里的会话怎么都搜不到。
       *
       * 取消时整次不写：producedTerms 里只有已经扫到的那部分会话，把它并进去等于
       * 拿半次扫描的结果当全量。staleIds 此时也是空的（上面那个 if 里才填），
       * 于是"什么都不做、旧表原样留着"既是最省事的，也是唯一正确的选择。
       */
      if (buildSearchIndex && !result.cancelled) {
        this.searchIndex = mergeIndex({
          previous: this.searchIndex ?? emptyIndex(),
          removed: staleIds,
          added: producedTerms,
          // 与 lastScanAt 同一个时刻：界面上"索引建于"和"上次扫描于"是同一件事，
          // 各读一次时钟只会让它们差出几毫秒来。
          builtAt: finishedAt.toISOString()
        })
        await this.deps.store.saveSearchIndex(this.searchIndex)
      }

      await this.deps.store.updateState({ lastScanAt: finishedAt.toISOString() })

      return {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        roots,
        sessions: await this.listSessions(),
        issues: result.issues,
        cancelled: result.cancelled,
        progress: result.progress
      }
    } finally {
      this.scanning = false
    }
  }

  async importFiles(filePaths: readonly string[]): Promise<ImportResult> {
    if (filePaths.length === 0) {
      return { ok: true, cancelled: true, sessions: [], issues: [] }
    }

    const settings = await this.getSettings()
    const loaded = await loadFilesDirectly({
      filePaths,
      fs: this.deps.fs,
      homeDir: this.deps.homeDir,
      platform: this.deps.platform,
      maxFileSizeBytes: settings.maxFileSizeMb * 1024 * 1024
    })

    // 手动导入的文件，即使之前被隐藏过也要重新显示出来。
    const importedIds = new Set(loaded.sessions.map((session) => session.id))
    if (settings.hiddenSessionIds.some((id) => importedIds.has(id))) {
      await this.updateSettings({
        hiddenSessionIds: settings.hiddenSessionIds.filter((id) => !importedIds.has(id))
      })
    }

    const summaries = await this.absorb(loaded.sessions, true)
    const importedSummaries = summaries.filter((summary) => importedIds.has(summary.id))

    return {
      ok: loaded.sessions.length > 0,
      sessions: importedSummaries,
      issues: loaded.issues
    }
  }

  /** 载入随应用打包的虚构示例会话，用于第一次体验完整流程。 */
  async loadSampleData(): Promise<ImportResult> {
    const dir = this.deps.sampleDir
    if (!dir) {
      return {
        ok: false,
        sessions: [],
        issues: [],
        error: '找不到内置示例数据目录。'
      }
    }

    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      return {
        ok: false,
        sessions: [],
        issues: [],
        error: `读取示例目录失败：${error instanceof Error ? error.message : String(error)}`
      }
    }

    const filePaths = names
      .filter((name) => name.endsWith('.json') || name.endsWith('.jsonl'))
      .map((name) => join(dir, name))

    return this.importFiles(filePaths)
  }

  async forgetSession(sessionId: string): Promise<SessionSummary[]> {
    const settings = await this.getSettings()
    if (!settings.hiddenSessionIds.includes(sessionId)) {
      await this.updateSettings({ hiddenSessionIds: [...settings.hiddenSessionIds, sessionId] })
    }
    this.index = this.index.filter((summary) => summary.id !== sessionId)
    this.cache.delete(sessionId)
    await this.deps.store.saveIndex(this.index)
    return this.listSessions()
  }

  /**
   * 清空本地索引。
   *
   * 「已隐藏的会话」名单也要一起清掉。设置页对用户的承诺是
   * "清空索引不会删除你的原始文件 —— 重新扫描就能再找回来"，
   * 而只清索引的话，之前从列表里移除过的会话即使被重新扫到，
   * 也会继续被这份名单挡在外面，那句话就成了空话。
   *
   * 倒排表也要一起删。漏掉它的后果很具体：界面上会话全没了，磁盘上却还留着一份
   * 含全部会话正文的表 —— 而那正是按这个按钮想消除的东西。
   */
  async clearIndex(): Promise<SessionSummary[]> {
    this.index = []
    this.cache.clear()
    await this.deps.store.saveIndex(this.index)

    this.searchIndex = null
    await this.deps.store.clearSearchIndex()

    const settings = await this.getSettings()
    if (settings.hiddenSessionIds.length > 0) {
      await this.updateSettings({ hiddenSessionIds: [] })
    }

    return this.listSessions()
  }

  /**
   * 跨会话搜索。分两层，`request.sessionId` 决定走不走第二层。
   *
   * **第一层**（不给 `sessionId`）只查表，只回答"哪些会话里有这些词"：不碰文件系统、
   * 不解析任何会话 —— "674 会话下查询 < 200 ms"那条线全靠它，`hits` 是空数组。
   *
   * **第二层**（给了 `sessionId`）在那一个会话里定位到具体事件，代价是把那个文件重新
   * 解析一遍。一次只一个，绝不顺手把候选都定位好。
   *
   * 三条降级路，每条都得带一句能让人知道下一步做什么的话：开关关了、还没有表
   * （或者表坏了）、表被体积上限裁过。前两条只搜标题，第三条搜的是全文、只是可能不全。
   * 静默降级是最坏的选择 —— 用户看到的只是"搜不到"，而这三种情况该做的事完全不同。
   */
  async searchSessions(request: SearchRequest): Promise<SearchResponse> {
    const settings = await this.getSettings()
    const parsed = parseQuery(request.query)

    let table: SearchIndexFile
    let degraded: boolean
    let notice: string | null

    if (!settings.buildSearchIndex) {
      table = this.titleOnlyIndex()
      degraded = true
      notice = SEARCH_NOTICE_DISABLED
    } else if (this.searchIndex === null) {
      table = this.titleOnlyIndex()
      degraded = true
      notice = SEARCH_NOTICE_MISSING
    } else {
      table = this.searchIndex
      degraded = false
      notice =
        table.droppedTerms > 0
          ? `索引超出体积上限，丢掉了 ${table.droppedTerms} 个高频词，结果可能不全。`
          : null
    }

    const result = queryIndex(table, parsed)
    const hidden = new Set(settings.hiddenSessionIds)

    return {
      query: request.query,
      terms: result.terms,
      unmatched: result.unmatched,
      sessionIds: this.rankSessionIds(
        result.sessionIds,
        hidden,
        request.limit ?? SEARCH_DEFAULT_LIMIT
      ),
      hits:
        request.sessionId === undefined
          ? []
          : await this.locateIn(request.sessionId, parsed, result.terms),
      degraded,
      notice
    }
  }

  /**
   * 第二层：把这一个会话解析出来，找出命中的具体位置。
   *
   * 走 `getSession` 而不是自己读文件，图的是它已经有的两件事：3 槽 LRU 加"只取要的
   * 那一个会话"的加载逻辑，以及打码与路径替换 —— 片段里的字必须和时间线上看到的
   * 一模一样，否则关掉「显示完整路径」之后，搜索结果反倒会把用户名露出来。
   *
   * 这么做有个能说清的代价：被路径替换掉的那一截（用户名、`Users`）在第一层的表里
   * 是有的，第二层却找不到，于是"列出来了但命中 0 处"。让片段和时间线对不上比这更糟。
   *
   * 文件在应用外面被删了就交空数组：第一层的候选来自磁盘上的表，它可能比现实旧一步。
   */
  private async locateIn(
    sessionId: string,
    parsed: ParsedQuery,
    expanded: readonly string[]
  ): Promise<SearchHit[]> {
    const session = await this.getSession(sessionId)
    if (session === null) return []

    // 用户打的词和索引扩展出来的词一起找。
    // 少了扩展出来的：搜 `modules` 时第一层靠 `node_modules` 把这个会话筛出来了，
    // 点进去却是"命中 0 处"。少了用户打的：降级路上表里只有标题那几个词，扩展不出
    // 任何东西，而这一层压根不需要表就能干活。
    const terms = [...new Set([...parsed.terms, ...expanded])]
    return locateHits(session, { terms, phrase: parsed.phrase })
  }

  /**
   * 只有摘要的一张临时表：标题、项目名、文件名那几个字段。
   *
   * 降级检索走的是**同一个** `queryIndex`，而不是另写一套"包含判断"。两套匹配规则
   * 的下场是同一个词降级前后结果不一样（前缀算不算命中、中文按不按 bigram 切），
   * 而用户完全看不出为什么。几百条摘要建这张表是毫秒级的，而且不落盘。
   */
  private titleOnlyIndex(): SearchIndexFile {
    const added = new Map<string, ReadonlySet<string>>()
    for (const summary of this.index) added.set(summary.id, collectSummaryTerms(summary))
    return mergeIndex({
      previous: emptyIndex(),
      removed: new Set<string>(),
      added,
      builtAt: ''
    })
  }

  /**
   * 把查表结果排成列表里的顺序，再按 limit 截断。
   *
   * 顺序直接沿用 `this.index` 的下标 —— 它已经按 sortKey 排好，与用户在列表里看到的
   * 顺序天然一致；在这里另起一次排序只是多一个会跑偏的地方。`queryIndex` 交出来的是
   * 表内顺序，那个顺序对用户没有任何意义。
   *
   * 顺手挡掉两类 id：已隐藏的会话，以及表里有、索引里已经没有的会话。两者都是真实
   * 存在的状态（"从索引中移除"过的那个会话就同时是这两种），而搜出来的结果里出现一条
   * 点不开的条目，比搜不到更难解释。
   */
  private rankSessionIds(
    sessionIds: readonly string[],
    hidden: ReadonlySet<string>,
    limit: number
  ): string[] {
    const position = new Map<string, number>()
    this.index.forEach((summary, at) => {
      if (!hidden.has(summary.id)) position.set(summary.id, at)
    })

    return sessionIds
      .filter((id) => position.has(id))
      .sort((left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0))
      .slice(0, limit)
  }

  async getStats(now?: Date): Promise<StatsOverview> {
    const sessions = await this.listSessions()
    return computeStats(sessions, now ?? new Date())
  }

  async renderExport(request: ExportRequest): Promise<RenderedExport | null> {
    const cached = this.touch(request.sessionId)
    const session = cached ?? (await this.loadRaw(request.sessionId))
    if (!session) return null

    return renderExport({
      session,
      format: request.format,
      options: request.options,
      homeDir: this.deps.homeDir,
      platform: this.deps.platform
    })
  }

  /**
   * 重新解析某个会话所在的文件，只取出要的那一个（未打码，供内部使用）。
   *
   * **只取要的那一个**是这里的关键。一个文件里可能装着几十个会话
   * （Codex 的 process_manager 状态文件实测有 70 个），要是把解析出来的全部
   * 塞进 LRU 缓存，缓存上限只有 3，想要的那个会在取用之前就被挤掉 ——
   * 界面于是报"原始文件可能已被移动或删除"，而文件其实一直都在。
   * 顺带也省掉了同时把几十份完整事件留在内存里的开销。
   */
  private async loadRaw(sessionId: string): Promise<CodexSession | null> {
    const summary = this.index.find((entry) => entry.id === sessionId)
    if (!summary) return null

    const settings = await this.getSettings()
    const loaded = await loadFilesDirectly({
      filePaths: [summary.sourceFile],
      fs: this.deps.fs,
      homeDir: this.deps.homeDir,
      platform: this.deps.platform,
      maxFileSizeBytes: settings.maxFileSizeMb * 1024 * 1024
    })

    const wanted = loaded.sessions.find((session) => session.id === sessionId)
    if (!wanted) {
      // 文件真的没了，或者内容变得认不出这个会话了 —— 别让它继续挂在列表里。
      await this.forgetFile(summary.sourceFile)
      return null
    }

    this.remember(wanted)
    return wanted
  }

  /**
   * 把某个文件在索引里的全部条目忘掉。
   *
   * 一个会话打不开，说明我们对它所在文件的记忆已经过期（文件被删了、
   * 或者内容变得认不出来）。会话 id 是从文件内容算出来的，一条对不上
   * 往往意味着整份都对不上，所以整份忘掉最实在。
   *
   * 更要紧的是：下一次扫描靠"大小与修改时间没变"来决定能不能复用旧条目。
   * 只删掉点不开的那一条，剩下的残缺记忆会一直被复用下去，那个会话就再也回不来了。
   * 整份清掉之后这个文件下次必定被重新解析。
   *
   * 和 forgetSession 的区别：这里**不**写进 hiddenSessionIds ——
   * 那份名单代表"用户主动删掉的会话"。文件要是哪天又回来了，下次扫描会重新收录。
   */
  private async forgetFile(sourceFile: string): Promise<void> {
    const target = normalizePathKey(sourceFile, this.deps.platform)
    const kept: SessionSummary[] = []
    const gone = new Set<string>()

    for (const summary of this.index) {
      if (normalizePathKey(summary.sourceFile, this.deps.platform) === target) {
        this.cache.delete(summary.id)
        gone.add(summary.id)
        continue
      }
      kept.push(summary)
    }

    if (kept.length === this.index.length) return
    this.index = kept
    await this.deps.store.saveIndex(this.index)

    // 倒排表也得跟着忘 —— 这条路不走 runScan，那边的过期逻辑帮不上忙。
    // 漏掉这里的症状是搜出一个已经不在索引里的会话，点开一片空白。
    await this.mergeSearchIndex({ removed: gone, added: new Map() })
  }

  /** 把新解析出的会话并入索引与缓存。 */
  private async absorb(sessions: readonly CodexSession[], merge: boolean): Promise<SessionSummary[]> {
    const settings = await this.getSettings()
    const hiddenPaths = new Set(
      settings.hiddenSources.map((path) => normalizePathKey(path, this.deps.platform))
    )

    const next = new Map<string, SessionSummary>()
    if (merge) {
      for (const summary of this.index) next.set(summary.id, summary)
    } else {
      this.cache.clear()
    }

    // 导入这条路和扫描一样要收词条，而且这里更简单：事件就在手上。
    const addedTerms = new Map<string, ReadonlySet<string>>()

    for (const session of sessions) {
      if (hiddenPaths.has(normalizePathKey(session.sourceFile, this.deps.platform))) continue
      // 手动导入的量很小，可以顺手放进缓存（remember 内部有上限）。
      this.remember(session)
      next.set(session.id, toSummary(session) as SessionSummary)
      if (settings.buildSearchIndex) addedTerms.set(session.id, collectTerms(session))
    }

    const dropped = new Set(merge ? [] : this.index.map((summary) => summary.id))

    this.index = [...next.values()].sort((a, b) => sortKey(b) - sortKey(a))
    await this.deps.store.saveIndex(this.index)
    // merge === false 的意思是"拿这次的结果替换掉索引"，表也照此办理：
    // 旧条目全作废，只留这一批。
    await this.mergeSearchIndex({ removed: dropped, added: addedTerms })
    return this.listSessions()
  }

  /**
   * 把倒排表跟着索引改掉，然后落盘。
   *
   * 三个入口用它（导入、忘掉一个文件，以及经由它们的示例数据），扫描收尾那一处例外
   * —— 那里要复用扫描自己算出来的 staleIds，并且要在取消时整次跳过。落盘只有这一处
   * 与那一处，加第四个入口的人不至于两边都漏。
   *
   * 开关关着时什么都不做：那种情况下磁盘上本来就不该有这个文件。
   */
  private async mergeSearchIndex(input: {
    removed: ReadonlySet<string>
    added: ReadonlyMap<string, ReadonlySet<string>>
  }): Promise<void> {
    const settings = await this.getSettings()
    if (!settings.buildSearchIndex) return
    if (input.removed.size === 0 && input.added.size === 0) return

    this.searchIndex = mergeIndex({
      previous: this.searchIndex ?? emptyIndex(),
      removed: input.removed,
      added: input.added,
      builtAt: new Date().toISOString()
    })
    await this.deps.store.saveSearchIndex(this.searchIndex)
  }
}

function sortKey(summary: SessionSummary): number {
  const candidates = [summary.endedAt, summary.startedAt, summary.fileModifiedAt, summary.indexedAt]
  for (const candidate of candidates) {
    if (!candidate) continue
    const parsed = Date.parse(candidate)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

export type { ScanIssue }
