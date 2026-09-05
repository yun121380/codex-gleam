import type { CodexEvent, UsageSummary } from '@shared/types'
import type { DetectedFormat } from '../scanner/fingerprint'

/** 一条已成功 JSON.parse 的记录（JSONL 的一行，或 JSON 数组的一项）。 */
export interface ParsedRecord {
  value: unknown
  /** JSONL 行号（从 1 开始）；JSON 文件里是数组下标。 */
  line: number
}

/** 解析失败的行。会变成用户可见的警告，但不会导致整个会话失败。 */
export interface BadRecord {
  line: number
  error: string
  preview: string
}

export interface ParserInput {
  filePath: string
  fileName: string
  format: DetectedFormat
  fileSizeBytes: number
  modifiedMs: number
  /** JSON 文件的根值（JSONL 为 undefined）。 */
  root?: unknown
  /** JSONL 逐行记录（JSON 文件为 undefined）。 */
  records?: ParsedRecord[]
  badRecords: BadRecord[]
  truncated: boolean
}

/** 从原始文件中"定位"出的一个会话，尚未归一化为事件。 */
export interface SessionDraft {
  /** 同一文件内区分多个会话用的 key。 */
  key: string
  records: ParsedRecord[]
  meta: DraftMeta
}

export interface DraftMeta {
  sessionId?: string | null
  title?: string | null
  workingDirectory?: string | null
  model?: string | null
  startedAt?: string | null
  endedAt?: string | null
  projectName?: string | null
  /** 多智能体信息：这个会话是不是某个父会话派出去的子代理。 */
  agent?: AgentMeta
  /** 会话级别的原始元数据，展示在"原始数据"里。 */
  raw?: unknown
}

export interface AgentMeta {
  parentThreadId?: string | null
  nickname?: string | null
  role?: string | null
  taskPath?: string | null
}

export interface SessionParser {
  id: string
  name: string
  /** 返回 0 表示不适用；数值越大越优先被选中。 */
  score(input: ParserInput): number
  locate(input: ParserInput): SessionDraft[]
}

export interface NormalizeContext {
  filePath: string
  parserId: string
  /** 会话级工作目录，事件里没写时作为兜底。 */
  workingDirectory: string | null
  /** 生成稳定事件 id 的序号发生器。 */
  nextId: () => string
  /**
   * 是否保留每条记录的原始 JSON。
   *
   * 打开单个会话时需要（详情面板的"原始数据"要用），
   * 但批量扫描只为算摘要，保留它会让内存翻好几倍 —— 那时传 false。
   */
  keepRaw?: boolean
  /**
   * 当前记录被判定为纯噪音而丢弃时调用。
   *
   * 「故意丢弃的噪音」和「读不懂的记录」必须分开计数：
   * 前者是正常的，后者才需要在界面上提醒用户。
   */
  noteNoise?: () => void
  /**
   * 每条记录（含即将被当噪音丢弃的那些）都会经过这里，用来把用量数字和模型名捞走。
   *
   * 拿到的是剥壳之后的对象，与 normalizeRecord 自己看到的是同一份。
   */
  noteUsage?: (record: unknown) => void
}

export interface NormalizedResult {
  events: CodexEvent[]
  /** 结构完全读不懂、被跳过的记录数。会提示给用户。 */
  skipped: number
  /** 判定为纯噪音而主动丢弃的记录数。属于正常行为，不提示。 */
  dropped: number
  /** 会话用量。null = 这批记录里没有任何用量数字，界面上要说"未记录"。 */
  usage: UsageSummary | null
}
