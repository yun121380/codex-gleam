import { EVENT_TYPE_META } from '@shared/constants'
import type {
  CodexEvent,
  CodexSession,
  ExportOptions,
  FileChange,
  Platform,
  TestSummary
} from '@shared/types'
import { maybeMaskSessionPaths } from '../redaction/maskPaths'
import { redactSession } from '../redaction/redact'
import { toDisplayPath } from '../scanner/paths'

/**
 * 导出前先把会话整理成一份"报告模型"。
 * Markdown / HTML / JSON 三种导出共用同一个模型，保证内容一致。
 */

export interface ReportCommand {
  timestamp: string | null
  command: string
  exitCode: number | null
  success: boolean | null
  durationMs: number | null
  output: string | null
}

export interface ReportFileChange {
  path: string
  kind: FileChange['kind']
  additions: number
  deletions: number
  diff: string | null
}

export interface ReportTest {
  timestamp: string | null
  summary: TestSummary
}

export interface ReportMessage {
  timestamp: string | null
  text: string
}

export interface ReportError {
  timestamp: string | null
  title: string
  content: string
}

export interface ReportTimelineEntry {
  index: number
  timestamp: string | null
  type: CodexEvent['type']
  typeLabel: string
  title: string
  success: boolean | null
}

export interface ReportModel {
  appName: string
  generatedAt: string
  session: {
    id: string
    title: string
    projectName: string
    projectPath: string | null
    sourceFile: string
    startedAt: string | null
    endedAt: string | null
    durationMs: number
    confidence: string
    confidenceScore: number
    parserId: string
    fileSizeBytes: number
  }
  counts: {
    events: number
    userMessages: number
    assistantMessages: number
    commands: number
    failedCommands: number
    changedFiles: number
    testsPassed: number
    testsFailed: number
    errors: number
  }
  userMessages: ReportMessage[]
  assistantMessages: ReportMessage[]
  commands: ReportCommand[]
  fileChanges: ReportFileChange[]
  tests: ReportTest[]
  errors: ReportError[]
  timeline: ReportTimelineEntry[]
  warnings: { reason: string; suggestion: string }[]
  options: ExportOptions
  raw: unknown
}

export interface BuildReportContext {
  homeDir: string | null
  platform: Platform
  now?: Date
  appName: string
}

const CONFIDENCE_TEXT: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低'
}

export function buildReportModel(
  input: CodexSession,
  options: ExportOptions,
  context: BuildReportContext
): ReportModel {
  /*
   * 报告是要发出去的文件，所以正文也得过这一道 —— 命令输出、错误信息、
   * 测试失败详情里全都可能带着 C:\Users\用户名\…，光把路径字段缩写成 ~ 不够。
   */
  const session = maybeMaskSessionPaths(
    options.redactSensitive ? redactSession(input) : input,
    !options.showFullPaths,
    { homeDir: context.homeDir, platform: context.platform }
  )
  const now = context.now ?? new Date()

  const showPath = (target: string | null | undefined): string => {
    if (!target) return ''
    return toDisplayPath(target, {
      showFullPaths: options.showFullPaths,
      homeDir: context.homeDir,
      platform: context.platform
    })
  }

  const userMessages: ReportMessage[] = []
  const assistantMessages: ReportMessage[] = []
  const commands: ReportCommand[] = []
  /**
   * 命令事件 id → 报告里对应的那条命令。
   *
   * 输出该归给哪条命令，解析阶段（linkCommandOutputs）已经判断好了，
   * 结论就写在 event.linkedCommandId 上 —— 它既按 call_id 精确匹配，
   * 也在没有 call_id 时按"最近一条未配对的命令"兜底。
   * 导出这里只要照着查表，不要自己再猜一遍。
   */
  const commandByEventId = new Map<string, ReportCommand>()
  const fileChangeMap = new Map<string, ReportFileChange>()
  const tests: ReportTest[] = []
  const errors: ReportError[] = []
  const timeline: ReportTimelineEntry[] = []

  session.events.forEach((event, index) => {
    timeline.push({
      index,
      timestamp: event.timestamp,
      type: event.type,
      typeLabel: EVENT_TYPE_META[event.type].label,
      title: event.title,
      success: event.success
    })

    switch (event.type) {
      case 'user_message':
        if (event.content.trim() !== '') {
          userMessages.push({ timestamp: event.timestamp, text: event.content })
        }
        break

      case 'assistant_message':
        if (event.content.trim() !== '') {
          assistantMessages.push({ timestamp: event.timestamp, text: event.content })
        }
        break

      case 'shell_command':
      case 'test_start': {
        const entry: ReportCommand = {
          timestamp: event.timestamp,
          command: event.command ?? event.title,
          exitCode: event.exitCode ?? null,
          success: event.success,
          durationMs: event.durationMs ?? null,
          output: null
        }
        commands.push(entry)
        commandByEventId.set(event.id, entry)
        break
      }

      case 'command_output': {
        const outputText = options.includeCommandOutput ? event.content : null
        const linked =
          event.linkedCommandId === undefined
            ? undefined
            : commandByEventId.get(event.linkedCommandId)

        if (linked && linked.output === null) {
          linked.output = outputText
          if (linked.exitCode === null) linked.exitCode = event.exitCode ?? null
          if (linked.success === null) linked.success = event.success
          if (linked.durationMs === null) linked.durationMs = event.durationMs ?? null
          break
        }

        /*
         * 配到的目标不是一条命令（典型是 apply_patch 的执行结果，它被配到那次
         * 文件改动上）—— 那就不该出现在"命令"一节里，改动本身已经在文件差异那节了。
         * 强行塞进来只会变成一条"（未记录命令）"的噪音，还可能被误读成真跑过命令。
         */
        if (event.linkedCommandId !== undefined) break

        // 谁都没配上的输出：解析阶段两种配对都试过了仍然落单，单独列一条。
        commands.push({
          timestamp: event.timestamp,
          command: event.command ?? '（未记录命令）',
          exitCode: event.exitCode ?? null,
          success: event.success,
          durationMs: event.durationMs ?? null,
          output: outputText
        })
        break
      }

      case 'file_write':
      case 'file_edit':
      case 'git_diff': {
        for (const change of event.fileChanges ?? []) {
          const path = showPath(change.path)
          const existing = fileChangeMap.get(path)
          if (existing) {
            existing.additions += change.additions
            existing.deletions += change.deletions
            if (!existing.diff && change.diff) existing.diff = change.diff
            continue
          }
          fileChangeMap.set(path, {
            path,
            kind: change.kind,
            additions: change.additions,
            deletions: change.deletions,
            diff: change.diff ?? null
          })
        }
        break
      }

      case 'test_result': {
        if (event.test) tests.push({ timestamp: event.timestamp, summary: event.test })

        /*
         * 测试结果同时也是那条测试命令的结果。
         * 不回填的话，命令表里的 `npm test` 会写着"结果未记录"，
         * 而测试那一节明明已经写清了通过多少、失败多少 —— 同一份报告自相矛盾。
         */
        const linked =
          event.linkedCommandId === undefined
            ? undefined
            : commandByEventId.get(event.linkedCommandId)
        if (linked) {
          if (linked.output === null && options.includeCommandOutput) linked.output = event.content
          if (linked.exitCode === null) linked.exitCode = event.exitCode ?? null
          if (linked.success === null) linked.success = event.success
          if (linked.durationMs === null) linked.durationMs = event.durationMs ?? null
        }
        break
      }

      case 'error':
        errors.push({ timestamp: event.timestamp, title: event.title, content: event.content })
        break

      default:
        break
    }
  })

  return {
    appName: context.appName,
    generatedAt: now.toISOString(),
    session: {
      id: session.id,
      title: session.title,
      projectName: session.projectName,
      projectPath: session.projectPath ? showPath(session.projectPath) : null,
      sourceFile: showPath(session.sourceFile),
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs: session.durationMs,
      confidence: CONFIDENCE_TEXT[session.confidence] ?? session.confidence,
      confidenceScore: session.confidenceScore,
      parserId: session.parserId,
      fileSizeBytes: session.fileSizeBytes
    },
    counts: {
      events: session.eventCount,
      userMessages: session.userMessageCount,
      assistantMessages: session.assistantMessageCount,
      commands: session.commandCount,
      failedCommands: session.failedCommandCount,
      changedFiles: session.changedFileCount,
      testsPassed: session.testsPassed,
      testsFailed: session.testsFailed,
      errors: session.errorCount
    },
    userMessages,
    assistantMessages,
    commands,
    fileChanges: [...fileChangeMap.values()],
    tests,
    errors,
    timeline,
    warnings: session.warnings.map((warning) => ({
      reason: warning.reason,
      suggestion: warning.suggestion
    })),
    options,
    raw: options.includeRawJson ? session.events.map((event) => event.raw) : null
  }
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知'
  if (ms < 1000) return '不到 1 秒'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '未记录时间'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '未记录时间'
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function describeChangeKind(kind: FileChange['kind']): string {
  switch (kind) {
    case 'write':
      return '新建/覆盖'
    case 'edit':
      return '修改'
    case 'delete':
      return '删除'
    case 'rename':
      return '重命名'
    case 'read':
      return '读取'
    default:
      return '改动'
  }
}
