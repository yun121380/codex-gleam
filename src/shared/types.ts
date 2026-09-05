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
