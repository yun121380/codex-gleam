/**
 * 拾光 —— 全局领域模型。
 *
 * 这些类型同时被主进程（读取/解析文件）和渲染进程（展示）使用。
 * 它们是唯一的"事实来源"：任何 Codex 会话文件，无论原始格式多奇怪，
 * 最终都会被适配器转换成这里定义的 CodexSession + CodexEvent。
 */

export type Platform = 'win32' | 'darwin' | 'linux'

/**
 * 统一后的事件类型。解析器无法归类时使用 `unknown`，绝不丢弃数据。
 *
 * `reasoning`（Codex 的思考过程）不在最初的规格清单里，是实测真实日志后加的：
 * 一个会话里思考记录能占到近一半，把它们混在回复里会让时间线没法看，
 * 所以单独成类、默认折叠。
 */
export type CodexEventType =
  | 'session_start'
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'tool_call'
  | 'shell_command'
  | 'command_output'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'git_diff'
  | 'test_start'
  | 'test_result'
  | 'error'
  | 'unknown'

/** 识别可信度。用于在界面上告诉用户"这个文件有多像 Codex 会话"。 */
export type ConfidenceLevel = 'high' | 'medium' | 'low'

export type FileChangeKind = 'read' | 'write' | 'edit' | 'delete' | 'rename' | 'unknown'

export interface FileChange {
  /** 原始路径（可能是绝对路径）。 */
  path: string
  /** 用于界面展示的路径，可能被缩短或打码。 */
  displayPath: string
  kind: FileChangeKind
  /** 统一 diff 文本（如果日志里有）。 */
  diff?: string
  /** 修改前后的完整内容（如果日志里有）。 */
  before?: string
  after?: string
  additions: number
  deletions: number
}

export interface TestFailureDetail {
  name: string
  message?: string
}

export interface TestSummary {
  framework?: string
  passed: number
  failed: number
  skipped: number
  total?: number
  durationMs?: number
  failures: TestFailureDetail[]
}

/** 时间线上的一个事件。所有字段都是"尽力而为"的：日志里没有就是 null。 */
export interface CodexEvent {
  id: string
  /** ISO 8601 字符串；日志里没有时间戳时为 null。 */
  timestamp: string | null
  type: CodexEventType
  /**
   * 一句话标题，直接展示给用户。
   *
   * 里面可能夹着绝对路径（`读取 C:\Users\alice\proj\a.ts`、或一整条 shell 命令）。
   * 关闭「显示完整路径」时主进程会在送出前把主目录换成 `~`，见 redaction/maskPaths。
   */
  title: string
  /** 主要文本内容（对话正文、命令输出、错误信息……）。 */
  content: string
  sourceFile: string
  workingDirectory: string | null
  relatedFiles: string[]
  /**
   * 关闭「显示完整路径」时用来展示的路径（用户主目录已换成 `~`）。
   *
   * 渲染进程拿不到 homeDir，没法自己做这件事 —— 所以由主进程一并算好，
   * 和 FileChange.displayPath、SessionSummary.displaySourceFile 一个路子。
   * 界面必须用这两个字段，直接显示 workingDirectory / relatedFiles 会泄露用户名。
   */
  displayWorkingDirectory: string | null
  displayRelatedFiles: string[]
  /** true 成功 / false 失败 / null 不适用或未知。 */
  success: boolean | null
  /** 未能识别的原始数据全部保留在这里，界面可折叠查看。 */
  raw: unknown

  // ---- 可选的结构化补充信息 ----
  role?: string
  toolName?: string
  /** 工具调用 id，用于把命令和它的输出配对。 */
  callId?: string
  /** 命令输出事件被成功配对到的命令事件 id。 */
  linkedCommandId?: string
  command?: string
  exitCode?: number | null
  durationMs?: number | null
  fileChanges?: FileChange[]
  test?: TestSummary
  /** 产出该事件的适配器 id，便于排查解析问题。 */
  parserId?: string
  /** 事件在原文件中的行号（JSONL）或索引，便于定位。 */
  sourceLine?: number
}

export type IssueKind =
  | 'skipped-large'
  | 'unreadable'
  | 'parse-failed'
  | 'not-a-session'
  | 'partial-records'
  | 'empty'
  /** 上一次扫描还没结束，这一次被拒绝了。 */
  | 'busy'

/** 解析或扫描过程中的问题。必须告诉用户：哪个文件、为什么、能做什么。 */
export interface ScanIssue {
  path: string
  displayPath: string
  kind: IssueKind
  /** 失败原因（中文，面向小白）。 */
  reason: string
  /** 建议的下一步操作（中文）。 */
  suggestion: string
}

/**
 * 用量数字在日志里是累计的还是每轮的增量。
 *
 * 这不是配置项，是**从数据本身看出来的**结论：字段名（total_token_usage /
 * last_token_usage）在不同 Codex 版本里语义相反，认名字必然认错。
 */
export type UsageBasis = 'cumulative' | 'delta'

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number | null
  totalTokens: number
  /** 记下用了哪条规则，便于排错和界面提示 */
  basis: UsageBasis
  /** 按模型拆分；日志里没写模型名时只有一条 'unknown' */
  byModel: Array<{ model: string; totalTokens: number }>
  /** task_started 里的 model_context_window，用来算上下文占用率 */
  contextWindow: number | null
}

export interface SessionSummary {
  id: string
  title: string
  projectName: string
  projectPath: string | null
  sourceFile: string
  displaySourceFile: string
  fileSizeBytes: number
  startedAt: string | null
  endedAt: string | null
  durationMs: number
  eventCount: number
  userMessageCount: number
  assistantMessageCount: number
  commandCount: number
  failedCommandCount: number
  changedFileCount: number
  changedFiles: string[]
  testsPassed: number
  testsFailed: number
  errorCount: number
  hasFailures: boolean
  hasCodeChanges: boolean
  confidence: ConfidenceLevel
  confidenceScore: number
  parserId: string
  /** 各类事件的数量，让统计页面无需载入全部事件即可汇总。 */
  eventTypeCounts: Partial<Record<CodexEventType, number>>
  /** 部分记录解析失败时的提示，不影响会话可用性。 */
  warnings: ScanIssue[]
  /** 索引写入时间，用于排序与缓存失效判断。 */
  indexedAt: string
  fileModifiedAt: string | null
  /**
   * 多智能体信息。
   *
   * Codex 派子代理并行干活时，每个子代理写自己的一份日志，而它们收到的是
   * 同一段任务描述 —— 于是标题也一模一样。实测一个父会话下最多挂了 114 个，
   * 列表里就是一百多行长得完全一样的条目。
   *
   * 好在 Codex 把父子关系明明白白写在 session_meta 里，不用靠标题去猜。
   */
  agent: AgentInfo
  /**
   * 会话用量。
   *
   * null 表示这份日志里一个用量数字都没有 —— 界面上要照实说"未记录"。
   * 显示 0 会被读成"这次几乎没花钱"，那是谎报，比不报更糟。
   */
  usage: UsageSummary | null
}

export interface AgentInfo {
  /** Codex 自己的会话 id（rollout 里的 session_id），用来把子代理挂到父会话下。 */
  threadId: string | null
  /** 派出这个子代理的父会话 id；为 null 表示它自己就是一次普通会话。 */
  parentThreadId: string | null
  /** Codex 给子代理起的代号，例如 Kepler、Turing。展开分组时靠它区分。 */
  nickname: string | null
  /** 子代理的角色，实测取值有 explorer 与 worker。 */
  role: string | null
  /** 子代理的任务路径，例如 /root/voice_slice，比代号更能说明它在干什么。 */
  taskPath: string | null
}

export interface CodexSession extends SessionSummary {
  events: CodexEvent[]
}

export type RootOrigin = 'builtin' | 'custom' | 'imported' | 'sample'

export interface CandidateRoot {
  path: string
  /** 面向用户的中文说明，例如"Codex 主目录"。 */
  label: string
  origin: RootOrigin
  /** 生成该路径所依赖的环境变量，便于测试与排错。 */
  basedOn?: string
}

export type ScanPhase = 'idle' | 'walking' | 'parsing' | 'done' | 'cancelled' | 'error'

export interface ScanProgress {
  phase: ScanPhase
  currentPath: string
  dirsVisited: number
  filesScanned: number
  candidatesFound: number
  sessionsFound: number
  /** 0—100，尽力估算，仅用于进度条。 */
  percent: number
  message: string
}

export interface ScanResult {
  startedAt: string
  finishedAt: string
  durationMs: number
  roots: CandidateRoot[]
  sessions: SessionSummary[]
  issues: ScanIssue[]
  cancelled: boolean
  progress: ScanProgress
}

export interface AppSettings {
  /** 用户自定义的额外扫描目录。 */
  extraScanDirs: string[]
  /** 是否包含内置候选目录。 */
  useBuiltinDirs: boolean
  maxDepth: number
  maxFileSizeMb: number
  /** 低于此分数的文件不算会话（0—1）。 */
  confidenceThreshold: number
  redactSensitive: boolean
  showFullPaths: boolean
  theme: 'dark' | 'light'
  playbackIntervalMs: number
  /** 用户手动"从索引中移除"的文件，重新扫描时不再加入。 */
  hiddenSources: string[]
  /** 被移除的单个会话 id（同一文件里的其他会话不受影响）。 */
  hiddenSessionIds: string[]
  /**
   * 每百万输入 token 的单价。null = 没填，界面只显示 token 数不显示金额。
   *
   * 本应用不预置价格表：写死的价格会过期，而过期的价格比没有价格更糟。
   */
  pricePerMillionInput: number | null
  /** 每百万输出 token 的单价。 */
  pricePerMillionOutput: number | null
  /** 单价的货币符号，纯显示用。空字符串就不写单位。 */
  priceCurrency: string
  /**
   * resume 命令模板，占位符 `{dir}` 与 `{threadId}` 从会话里填。
   *
   * 空字符串 = 跟随平台默认（见 `renderer/lib/resumeCommand.ts`）。默认值依赖平台，
   * 而 `DEFAULT_SETTINGS` 是个拿不到平台的静态对象，所以这里存"空"，
   * 真正的默认值在知道平台的地方解析。
   */
  resumeTemplate: string
  /**
   * 建立全文搜索索引。
   *
   * 关掉后搜索降级为只搜标题，且磁盘上不留这份文本 —— 这是它存在的意义：
   * 索引会把全部会话的正文（打码之后的）落到磁盘上，那是今天的
   * `session-index.json` 没有的东西，所以得给一个能彻底关掉的开关。
   */
  buildSearchIndex: boolean
}

export interface ExportOptions {
  includeCommandOutput: boolean
  includeRawJson: boolean
  showFullPaths: boolean
  redactSensitive: boolean
}

export type ExportFormat = 'markdown' | 'html' | 'json'

export interface ExportRequest {
  sessionId: string
  format: ExportFormat
  options: ExportOptions
}

export interface ExportResult {
  ok: boolean
  filePath?: string
  cancelled?: boolean
  error?: string
  byteLength?: number
}

export interface CountedItem {
  label: string
  count: number
}

export interface DayBucket {
  date: string
  sessions: number
  commands: number
}

export interface StatsOverview {
  totalSessions: number
  sessionsLast7Days: number
  totalEvents: number
  totalCommands: number
  failedCommands: number
  changedFileCount: number
  uniqueChangedFileCount: number
  testsPassed: number
  testsFailed: number
  totalDurationMs: number
  averageSessionDurationMs: number
  topProjects: CountedItem[]
  topFileTypes: CountedItem[]
  byDay: DayBucket[]
  eventTypeCounts: Partial<Record<CodexEventType, number>>
  generatedAt: string
}

export interface Bootstrap {
  firstRun: boolean
  settings: AppSettings
  platform: Platform
  appVersion: string
  electronVersion: string
  /** 已缓存的会话索引，启动即可显示，无需重新扫描。 */
  sessions: SessionSummary[]
  builtinRoots: CandidateRoot[]
  /**
   * 用户主目录，界面用它把显示出来的路径缩写成 `~`。
   *
   * 会话数据里的路径由主进程一并算好了展示版（displaySourceFile / displayTitle …），
   * 但设置页里的自定义扫描目录是用户现场敲进去的 —— 主进程没法提前算，
   * 算了也会在下一次输入时立刻过期，只能把主目录给界面让它自己缩。
   */
  homeDir: string | null
  sampleDataAvailable: boolean
  isPackaged: boolean
}

export interface ScanRequest {
  /** 指定则只扫描这些目录；否则使用设置中的候选目录。 */
  roots?: string[]
  /** 是否与已有索引合并（false 表示替换）。 */
  merge?: boolean
}

export interface ImportResult {
  ok: boolean
  cancelled?: boolean
  sessions: SessionSummary[]
  issues: ScanIssue[]
  error?: string
}

export interface PrivacyNotice {
  title: string
  points: string[]
  storageLocation: string
}

// ---------------------------------------------------------------------------
// 跨会话搜索
// ---------------------------------------------------------------------------

/**
 * 落盘的倒排表。
 *
 * postings 存的是 `sessionIds` 里的下标，不是会话 id 本身：674 个会话、每个 id
 * 36 字符，一个高频词的 postings 就要 24 KB；换成下标是 1—3 个字符。代价是增量
 * 更新时要做一次下标重映射（见 `main/search/invertedIndex.ts` 的 mergeIndex）。
 *
 * 这里**没有**正向索引（会话 → 词）。删一个会话时不需要它：扫一遍倒排表、把指向
 * 它的下标抹掉即可。多存一份就多一份会过期的记忆。
 *
 * 表里的词条一律来自**打码之后**的文本，与 `redactSensitive` 那个开关无关 ——
 * 那个开关管"给界面看什么"，管不到"往磁盘写什么"。
 */
export interface SearchIndexFile {
  /** 格式版本。对不上就整份丢掉重建，不做逐版本迁移 —— 它随时能从原始文件重建。 */
  version: number
  /** 会话 id，postings 里的下标指向这里。 */
  sessionIds: string[]
  /** 词 → 出现过这个词的会话下标，升序、无重复。 */
  terms: Record<string, number[]>
  /** 超预算被丢掉的词条数。> 0 时界面要说"结果可能不全"。 */
  droppedTerms: number
  /** 建成时间，ISO 字符串。只用于界面展示，不参与失效判断。 */
  builtAt: string
}

export interface SearchRequest {
  query: string
  /**
   * 给了就是第二层：只在这一个会话里定位，会解析这个文件。
   * 不给就是第一层：只查倒排表，不碰任何文件，这是 < 200 ms 的那条路。
   */
  sessionId?: string
  /** 候选会话数上限。 */
  limit?: number
}

export interface SearchHit {
  sessionId: string
  eventId: string
  /** 事件在 `session.events` 里的下标，界面直接拿它设 cursor。 */
  eventIndex: number
  eventType: CodexEventType
  /** 命中所在字段的中文标签，例如"命令"、"输出"。 */
  field: string
  /** 已打码、已裁剪的上下文片段。 */
  snippet: string
  /** 片段里要高亮的区间，[起, 止)，相对 snippet 的下标。 */
  ranges: Array<[number, number]>
}

export interface SearchResponse {
  query: string
  /** 实际参与检索的词条（扩展之后）。界面可以据此解释"为什么这条也算命中"。 */
  terms: string[]
  /** 打进查询但索引里一个都没扩展出来的词。不能悄悄当它不存在。 */
  unmatched: string[]
  /** 第一层结果：候选会话 id，按现有排序键（新的在前）。 */
  sessionIds: string[]
  /** 第二层结果。第一层查询时是空数组。 */
  hits: SearchHit[]
  /** 走了降级路径（索引缺失 / 损坏 / 开关关着）。 */
  degraded: boolean
  /** 降级或结果可能不全时给用户的一句话；正常时为 null。 */
  notice: string | null
}

/**
 * 键名或值为什么**没**被打码。
 *
 * 每一条都指得出 `main/redaction/patterns.ts` 里的某一行判断 —— 这是这份报告
 * 「可反驳」的全部含义：用户看到 `author` 被排除，能自己去代码里对出是哪一条
 * 规则干的，而不是只能相信面板。
 *
 * 注意这里**没有**「已经打过码了」这一条。第 5 个阶段看到的 `Authorization:
 * [已打码]` 是第 3 个阶段刚打的，把它报成「被判为不是密钥」会把事实说反。
 */
export type KeptReason =
  /** 键名是计数或配置项：`input_tokens`、`keyboard`、`monkey` —— TOKEN_METRIC_PATTERN。 */
  | 'metric-name'
  /** 沾了敏感词但词形不符：`author` 里的 auth —— SENSITIVE_KEY_PATTERN 的两个词边界。 */
  | 'name-not-matched'
  /** 值不足 4 个字符：源码里的 `password: str` —— shouldMaskValue 的长度下限。 */
  | 'value-too-short'
  /** 值是占位符或模板：`<your-key>`、`{{TOKEN}}` —— shouldMaskValue 的 /^[[<({]/。 */
  | 'value-is-template'
  /** 值是 true / false / 数字 / n-a 之类 —— NON_SECRET_VALUE_PATTERN。 */
  | 'value-not-secret'

/**
 * 一处命中。
 *
 * `maskedContext` 是**打码之后**那份文本里切出来的片段，绝不携带原值 ——
 * 一个为打码而生的审计面板如果把它找到的密钥回显出来，它自己就是泄露口。
 */
export interface RedactionHit {
  /**
   * 哪条规则打的。六种取值：
   * `known-secret:<模式名>`（如 `known-secret:openai`）、`cookie-line`、
   * `auth-scheme`、`cli-flag`、`key-value`、`sensitive-key`。
   */
  rule: string
  /** 触发它的键名。第 1、3 阶段不看键名，所以是 null。 */
  keyName: string | null
  /** 命中落在哪条事件上。会话标题与摘要里的告警不属于任何一步，是 null。 */
  eventId: string | null
  /** 打码后的上下文片段，最长 REDACTION_CONTEXT_LENGTH。 */
  maskedContext: string
}

export interface RedactionRuleGroup {
  rule: string
  /** 精确计数，**不受**样例上限影响。 */
  count: number
  /**
   * 最多 REDACTION_REPORT_MAX_SAMPLES 条。
   *
   * `samples.length < count` 就是被截断了 —— 别把 `samples.length` 当成命中数。
   */
  samples: RedactionHit[]
}

export interface RedactionKeptEntry {
  keyName: string
  reason: KeptReason
  count: number
}

/**
 * 一个高熵片段**长得像**什么。
 *
 * 这十种形态是「已知的排除形态」，落进任何一种都会被乘一个小于 1 的系数压下去，
 * 但**一条都不会被丢掉** —— 真密钥恰好长得像 UUID 的时候，降权只是把它排后面，
 * 删除是把它彻底藏起来，而藏起来的那一条正是这一段存在的全部理由。
 *
 * 写成联合类型而不是 string，是为了让渲染层那张 `Record<ResidualShape, string>`
 * 成为编译期的穷尽检查：加了第十一种形态却忘了配中文说法，`pnpm typecheck` 直接红。
 */
export type ResidualShape =
  /** 40 位（或 7—64 位）纯十六进制：git 提交号。 */
  | 'git-sha'
  /** `sha256-` / `sha384-` / `sha512-` 开头：锁文件里的完整性校验值。 */
  | 'integrity-hash'
  /** 标准 8-4-4-4-12。 */
  | 'uuid'
  /** 含 `/` 且不止一段：POSIX 路径。Windows 路径被分词器切碎，到不了这里。 */
  | 'path'
  /** 只有数字和 `.`、`,`、`_`、`-`：时间戳、版本号、长数列。 */
  | 'numeric'
  /** 全小写加连接符：minified 标识符、长包名。 */
  | 'lower-words'
  /** 点分的大小写混排标识符：`Microsoft.Extensions.Logging` 这类代码里的名字。 */
  | 'dotted-name'
  /** `call_` 开头：会话格式自己发的工具调用 id，不是任何人给的凭据。 */
  | 'call-id'
  /** 前面紧挨着 `base64,`：内嵌图片之类的 data URI。 */
  | 'data-uri'
  /** 超过 512 字符：真密钥没这么长，PEM 块另有 private-key-block 规则管。 */
  | 'long-blob'

/**
 * 一条可疑残留：五个打码阶段全都没碰过它，但它看起来像密钥。
 *
 * 和 `RedactionHit` **方向相反**：这里存的是原文。理由不同于那边 ——
 * 残留本来就没被打码，此刻已经明明白白躺在时间线上，面板把它遮起来是自欺。
 * 唯一被改写过的是用户主目录，见 `library.auditSession`。
 */
export interface RedactionResidual {
  /**
   * 片段原文，最长 REDACTION_RESIDUAL_MAX_TEXT。
   *
   * `showFullPaths` 关着时，里面的主目录已经换成了 `~`。
   */
  text: string
  /**
   * 原文的**真实**长度，可能大于 `text.length`。
   *
   * 打分用的是这个数；两者不等时界面会说「共 N 字符，只显示开头」。
   */
  length: number
  /** 可疑度，0—100 的整数。整数是为了排序可复现：不比较浮点。 */
  score: number
  /** 落在哪种已知排除形态里。null 表示没落进任何一种，也就是没被降权。 */
  shape: ResidualShape | null
  /**
   * 这个片段在整个会话里出现几次。
   *
   * 常常是 2 的倍数：同一个串在事件正文和 `raw` 原始数据里各算一次。
   * 这是实话，不是重复计数的 bug。
   */
  count: number
  /** 第一次出现在哪条事件上。来自会话标题或摘要时是 null。 */
  eventId: string | null
}

export interface RedactionReport {
  sessionId: string
  /**
   * 打码开关当前是开还是关。
   *
   * 关着时这份报告的意思变成「你现在要分享的是原文，如果打开开关会打掉这些」——
   * 那正是最该看它的时刻，所以开关关着时审计照跑。
   */
  redactEnabled: boolean
  /** 所有分组的 count 之和。 */
  totalHits: number
  /** 按 count 降序，同 count 时按 rule 字典序（让输出可复现）。 */
  groups: RedactionRuleGroup[]
  /** 按 count 降序，最多 REDACTION_REPORT_MAX_KEPT 条。 */
  kept: RedactionKeptEntry[]
  /** kept 没列全（超过条数上限，或不同组合超过 REDACTION_REPORT_MAX_KEPT_KEYS）。 */
  keptTruncated: boolean
  /**
   * 可疑残留，按 score 降序、同分按 text 码点升序，最多 REDACTION_RESIDUAL_TOP 条。
   *
   * 这**不是**告警列表：里面没有阈值，短是因为固定只列这么多条。
   * `totalHits` 也不含它们 —— 残留不是命中，算进去会让「打掉了 N 处」变成假话。
   */
  residuals: RedactionResidual[]
  /** 排名表里不同片段的条数。`residualsPruned` 为 false 时它就是精确总数。 */
  residualsTotal: number
  /**
   * 排名表撞过上限，真实的不同片段比 `residualsTotal` 多。
   *
   * 想给出精确总数得把见过的每个片段都记住，而那正是上限要避免的开销。
   * 所以撞上限时界面换一句话说，而不是把一个算不准的数说得像准的。
   * 前 20 条**不受影响**，依然是精确的前 20 条 —— 论证见 `report.ts` 的剪枝那一段。
   */
  residualsPruned: boolean
}

// ---------------------------------------------------------------------------
// 离线自检
// ---------------------------------------------------------------------------

/** 一次被拦下来的网络请求。 */
export interface BlockedRequest {
  /** 被拦下来的地址，原样记录。 */
  url: string
  /** 拦下来的时刻，ISO 时间戳。 */
  at: string
  /**
   * 这次请求是应用自己发起的，还是用户按「你自己试」触发的。
   *
   * 归因**必须**在拦截那一刻做完并存进这条记录里，不能事后猜：只有那一刻监视器
   * 手里才握着「用户刚刚授权过哪个地址」这个证据。事后看着一条地址去猜它像不像
   * 用户填的，那不是证据，那是替应用找借口。
   */
  origin: 'app' | 'probe'
}

/** 这次运行的拦截情况。应用一关就没了 —— 它报的是「这次运行」，不是历史。 */
export interface InterceptLog {
  /**
   * 应用自身发起、而后被拦截的请求数。**这就是那个「应为 0」的指标。**
   *
   * 它和 `probeBlocked` 分开算，是因为演示一次拦截就把这个数弄脏的话，
   * 这个数就再也没人看了。
   */
  appBlocked: number
  /** 用户按「你自己试」触发、而后被拦截的请求数。 */
  probeBlocked: number
  /**
   * 最近被拦下来的若干条，两类混排、各自带 `origin`，最多 SELF_CHECK_MAX_BLOCKED 条。
   *
   * **计数不受这个上限影响**：清单是给人看的样本，上面那两个数才是精确的。
   * 和 `RedactionRuleGroup` 那里 `samples.length` 不等于 `count` 是同一个道理。
   */
  recent: BlockedRequest[]
  /** 清单撞过上限，被拦下来的比列出来的多。 */
  recentTruncated: boolean
}

/** 「你自己试」的受理结果。 */
export interface ProbeArmResult {
  /** 受理了没有。 */
  ok: boolean
  /** 受理成功时是那个地址，失败时是 null。 */
  url: string | null
  /**
   * 没受理的原因，一句中文。
   *
   * 它是契约的一部分而不是日志：这句话要直接显示给用户看，
   * 告诉他为什么这个地址演示不了拦截、该换成什么样的。
   */
  reason: string | null
}

/**
 * 构建期校验证据，来自 `build/generated/build-evidence.json`。
 *
 * 每个字段都可空：`scripts/buildEvidence.mjs` 的每条失败路径都写 null，
 * 契约得照实反映这件事，而不是假装它总能拿到。
 */
export interface BuildEvidence {
  schemaVersion: number | null
  /** 构建时的提交号。 */
  gitSha: string | null
  /** 构建时跑过多少条测试。 */
  testCount: number | null
  /** 在哪个平台上构建的。 */
  platform: string | null
  /** 构建时刻，ISO 时间戳。 */
  builtAt: string | null
}

/**
 * 完整依赖树证据，来自 `build/generated/dependency-tree.json`。
 *
 * **原始嵌套树不进这份报告**：`pnpm list --depth Infinity` 那份结构界面渲染不了，
 * 拍平成「有哪些包、各是什么版本」才是人能核对的东西。想看全的，原始文件照旧
 * 原样随包发出，自己去 `resources/generated/` 读。
 */
export interface DependencyEvidence {
  /** 生成时刻，ISO 时间戳。 */
  generatedAt: string | null
  /** 去重后的包数，**截断之前**的真实条数。 */
  packageCount: number
  /** 已去重、已排序，最多 SELF_CHECK_MAX_PACKAGES 条。 */
  packages: Array<{ name: string; version: string }>
  /** 列表撞过上限，`packageCount` 比 `packages.length` 大。 */
  packagesTruncated: boolean
}

/** 读一次自检报告。 */
export interface SelfCheckRequest {
  /**
   * 顺便授权这个地址走一次「你自己试」。
   *
   * 不带就只是读一份报告；带上就先授权、再读一份报告，受理结果在
   * `SelfCheckReport.probeArm` 里带回去。一个频道两层活，和 `sessions:search` 同一个路子。
   */
  armProbe?: string
}

/** 一份离线自检报告。全部来自这次运行的真实对象与真实计数，没有一处是从文档里抄的。 */
export interface SelfCheckReport {
  /** 开发模式还是打包后运行。 */
  mode: 'dev' | 'packaged'
  intercept: InterceptLog
  csp: {
    /**
     * 这次运行**真的加过的那条**响应头。
     *
     * 开发模式下是 null —— 那道头被 `if (!options.isDev)` 挡着，根本没装。
     * 它不是「常量的值」：把常量拿出来当「当前生效」，页面就比护栏更乐观了。
     */
    responseHeader: string | null
    /** 这条头真的加过几次。 */
    appliedCount: number
  }
  tls: {
    /** 验证器装上了没有。 */
    installed: boolean
    /** 验证器恒定返回的那个判决值，来自 `TLS_UNTRUSTED_VERDICT`。 */
    verdict: number
    /**
     * 验证器被问过几次。
     *
     * **正常情况下这个数一直是 0**，因为本应用不发起 TLS 连接。
     * 0 是预期，不是「没接上线」。
     */
    calls: number
  }
  build: BuildEvidence | null
  dependencies: DependencyEvidence | null
  /** 这次没带 `armProbe` 时是 null。 */
  probeArm: ProbeArmResult | null
  /**
   * 读构建期证据时出的岔子，逐条中文原因。
   *
   * 空数组表示没岔子 —— 注意「没岔子」和「没证据」是两件事：开发模式下压根没有
   * 那个目录，那不是岔子，页面自己会说。
   */
  evidenceIssues: string[]
}
