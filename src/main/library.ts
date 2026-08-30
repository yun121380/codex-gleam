import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_NAME } from '@shared/constants'
import type {
  AppSettings,
  CandidateRoot,
  CodexSession,
  ExportRequest,
  ImportResult,
  Platform,
  PrivacyNotice,
  ScanIssue,
  ScanProgress,
  ScanRequest,
  ScanResult,
  SessionSummary,
  StatsOverview
} from '@shared/types'
import { PRIVACY_POINTS } from '@shared/constants'
import { renderExport, type RenderedExport } from './exporters'
import { maybeMaskSessionPaths, maybeMaskSummaryPaths } from './redaction/maskPaths'
import { maybeRedactSession, maybeRedactSummary } from './redaction/redact'
import { buildScanRoots, isUnderDir, normalizePathKey, parentDirKey } from './scanner/paths'
import {
  loadFilesDirectly,
  runScan,
  type KnownFile,
  type ScanEngineResult
} from './scanner/scanner'
import type { FileSystemAccess } from './scanner/fsAccess'
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

export class SessionLibrary {
  private index: SessionSummary[] = []
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

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.deps.store.updateSettings(patch)
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
        lookupKnown: (candidate) =>
          knownByPath.get(normalizePathKey(candidate.path, this.deps.platform)) ?? null,
        onReused: (summaries) => {
          for (const summary of summaries) keep(summary)
        },
        onSession: (session) => {
          keep(toSummary(session) as SessionSummary)
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
   */
  async clearIndex(): Promise<SessionSummary[]> {
    this.index = []
    this.cache.clear()
    await this.deps.store.saveIndex(this.index)

    const settings = await this.getSettings()
    if (settings.hiddenSessionIds.length > 0) {
      await this.updateSettings({ hiddenSessionIds: [] })
    }

    return this.listSessions()
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

    for (const summary of this.index) {
      if (normalizePathKey(summary.sourceFile, this.deps.platform) === target) {
        this.cache.delete(summary.id)
        continue
      }
      kept.push(summary)
    }

    if (kept.length === this.index.length) return
    this.index = kept
    await this.deps.store.saveIndex(this.index)
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

    for (const session of sessions) {
      if (hiddenPaths.has(normalizePathKey(session.sourceFile, this.deps.platform))) continue
      // 手动导入的量很小，可以顺手放进缓存（remember 内部有上限）。
      this.remember(session)
      next.set(session.id, toSummary(session) as SessionSummary)
    }

    this.index = [...next.values()].sort((a, b) => sortKey(b) - sortKey(a))
    await this.deps.store.saveIndex(this.index)
    return this.listSessions()
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
