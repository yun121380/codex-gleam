import { createHash } from 'node:crypto'
import type {
  CodexEvent,
  CodexSession,
  ConfidenceLevel,
  Platform,
  ScanIssue
} from '@shared/types'
import { baseName, toDisplayPath } from '../scanner/paths'
import { EMPTY_THREAD_TITLES, lookupThreadTitle, type ThreadTitles } from '../scanner/threadTitles'
import { injectedContextTag, normalizeRecords } from './normalize'
import type { SessionDraft } from './types'

export interface BuildSessionArgs {
  draft: SessionDraft
  filePath: string
  fileSizeBytes: number
  modifiedMs: number
  parserId: string
  confidence: ConfidenceLevel
  confidenceScore: number
  warnings: readonly ScanIssue[]
  homeDir: string | null
  platform: Platform
  /** Codex 自己维护的会话名（session_index.jsonl）。读不到时传空表即可。 */
  threadTitles?: ThreadTitles
  /** false 表示只为算摘要，不保留每条记录的原始 JSON（省内存）。 */
  keepRaw?: boolean
  /**
   * 是否要求这份文件在结构上确实是一次会话（见 hasMeaningfulEvents）。
   *
   * 批量扫描时开启：光靠词频，一份提到了 conversation / session / shell 的
   * 崩溃报告或状态文件也能拿到满分指纹，只有看结构才分得清。
   * 用户明确\"导入这个文件\"时关闭 —— 那时他已经替我们做了判断。
   */
  requireMeaningfulEvents?: boolean
}

/** 稳定的会话 id：同一个文件的同一个会话，每次扫描都得到同样的 id。 */
export function sessionIdFor(filePath: string, draftKey: string): string {
  return createHash('sha1').update(`${filePath}#${draftKey}`).digest('hex').slice(0, 16)
}

function firstTimestamp(events: readonly CodexEvent[]): string | null {
  for (const event of events) {
    if (event.timestamp) return event.timestamp
  }
  return null
}

function lastTimestamp(events: readonly CodexEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const timestamp = events[index]?.timestamp
    if (timestamp) return timestamp
  }
  return null
}

/**
 * 从第一条**真正是人说的**消息里取标题。
 *
 * `injectedContextTag` 已经把 Codex 自己塞的上下文归到别的类型上了，所以走到这里的
 * user_message 基本都是人说的。这里再挡一道，是为了兜住那些没有闭合标签、
 * 或者由别的 harness 注入的变体。
 */
function deriveTitle(events: readonly CodexEvent[], fallback: string): string {
  const firstUserMessage = events.find(
    (event) =>
      event.type === 'user_message' &&
      event.content.trim() !== '' &&
      injectedContextTag(event.content) === null
  )
  const source = firstUserMessage?.content ?? ''
  const line = source
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '' && !entry.startsWith('#'))

  if (!line) return fallback
  return truncateTitle(line)
}

function truncateTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > 60 ? `${cleaned.slice(0, 60)}…` : cleaned
}

const COMMAND_TYPES = new Set<CodexEvent['type']>(['shell_command', 'test_start'])

/** 一问一答的对话。有它就一定是会话 —— 没有别的东西会长成这样。 */
const DIALOGUE_TYPES = new Set<CodexEvent['type']>(['user_message', 'assistant_message'])

/**
 * "动作或结果"类事件：Codex 真的做了点什么。
 *
 * 单独出现说明不了什么 —— 一份记录着若干条命令的状态文件也长这样。
 * 只有和「会话开始」一起出现，才算是一次有头有尾的协作。
 */
const ACTION_TYPES = new Set<CodexEvent['type']>([
  'reasoning',
  'tool_call',
  'shell_command',
  'command_output',
  'file_read',
  'file_write',
  'file_edit',
  'git_diff',
  'test_start',
  'test_result',
  'error'
])

/**
 * 这份文件到底是不是"一次会话"？只在批量扫描时用来挡假阳性。
 *
 * 判据：**有对话** 或者 **有会话开始 + 至少一个动作**。
 *
 * 光有动作不算，这一条是实测逼出来的：Codex 自己的
 * `process_manager/chat_processes.json` 是一个进程状态数组，每条带着
 * command 和 conversationId，于是被拆成 70 个"会话"排进列表，
 * 事件全是 shell_command；`skills/…/humaneval-loki-results.json`
 * 那样的跑分结果文件也会混进来。它们的共同点是既没有一句对话，
 * 也没有一条会话元信息。
 *
 * 实测这条判据在 674 个会话上的效果：603 个真实滚动日志全部保留
 * （包括 2 个只有「会话开始 + 出错」的空会话），71 个假阳性全部挡住。
 */
export function hasMeaningfulEvents(events: readonly CodexEvent[]): boolean {
  if (events.some((event) => DIALOGUE_TYPES.has(event.type))) return true

  const hasSessionMeta = events.some((event) => event.type === 'session_start')
  return hasSessionMeta && events.some((event) => ACTION_TYPES.has(event.type))
}

/**
 * 把定位到的会话草稿变成完整会话（含统计）。
 * 事件为空时返回 null —— 调用方会把它记成"文件里没有会话内容"。
 */
export function buildSession(args: BuildSessionArgs): CodexSession | null {
  const {
    draft,
    filePath,
    fileSizeBytes,
    modifiedMs,
    parserId,
    confidence,
    confidenceScore,
    warnings,
    homeDir,
    platform,
    threadTitles = EMPTY_THREAD_TITLES,
    keepRaw = true,
    requireMeaningfulEvents = false
  } = args

  let counter = 0
  // dropped（主动丢弃的噪音）刻意不产生警告：那是正常的过滤，不是解析失败。
  const { events, skipped } = normalizeRecords(draft.records, {
    filePath,
    parserId,
    workingDirectory: draft.meta.workingDirectory ?? null,
    keepRaw,
    nextId: () => {
      counter += 1
      return `${sessionIdFor(filePath, draft.key)}-${counter}`
    }
  })

  if (events.length === 0) return null
  if (requireMeaningfulEvents && !hasMeaningfulEvents(events)) return null

  const workingDirectory =
    draft.meta.workingDirectory ??
    events.find((event) => event.workingDirectory !== null)?.workingDirectory ??
    null

  // 展示用路径在这里一次算好：只有这一层同时拿得到事件、homeDir 和 platform。
  const display = (target: string): string =>
    toDisplayPath(target, { showFullPaths: false, homeDir, platform })

  for (const event of events) {
    if (event.workingDirectory === null) event.workingDirectory = workingDirectory
    event.displayWorkingDirectory =
      event.workingDirectory === null ? null : display(event.workingDirectory)
    event.displayRelatedFiles = event.relatedFiles.map(display)
    if (event.fileChanges) {
      for (const change of event.fileChanges) {
        change.displayPath = display(change.path)
      }
    }
  }

  const startedAt = draft.meta.startedAt ?? firstTimestamp(events)
  const endedAt = lastTimestamp(events) ?? draft.meta.endedAt ?? startedAt

  const durationMs =
    startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : 0

  const commandEvents = events.filter((event) => COMMAND_TYPES.has(event.type))
  /**
   * 没配到命令、但自己带着命令文本的输出也算一条命令。
   *
   * 这里必须要求 command 非空：日志里还有网页搜索、MCP 工具等等的结果，
   * 它们同样是 command_output，但把它们算进"执行了多少条命令"是错的。
   */
  const orphanOutputs = events.filter(
    (event) =>
      event.type === 'command_output' &&
      event.linkedCommandId === undefined &&
      (event.command ?? '').trim() !== ''
  )
  const commandCount = commandEvents.length + orphanOutputs.length
  const failedCommandCount =
    commandEvents.filter((event) => event.success === false).length +
    orphanOutputs.filter((event) => event.success === false).length

  const changedFiles = new Set<string>()
  for (const event of events) {
    if (event.type !== 'file_write' && event.type !== 'file_edit' && event.type !== 'git_diff') continue
    const paths = event.fileChanges?.map((change) => change.path) ?? event.relatedFiles
    for (const path of paths) {
      if (path.trim() !== '') changedFiles.add(path)
    }
  }

  let testsPassed = 0
  let testsFailed = 0
  for (const event of events) {
    if (!event.test) continue
    testsPassed += event.test.passed
    testsFailed += event.test.failed
  }

  const errorCount = events.filter((event) => event.type === 'error').length

  const eventTypeCounts: Partial<Record<CodexEvent['type'], number>> = {}
  for (const event of events) {
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1
  }

  const fileName = baseName(filePath)
  const projectPath = workingDirectory

  /*
   * 标题按可靠程度依次回退：
   *   1. 文件里写明的标题；
   *   2. Codex 自己给这个会话起的名字（session_index.jsonl）—— 最准，但只覆盖一部分会话；
   *   3. 第一条真正是人说的消息；
   *   4. 文件名。
   *
   * 每一路都过一遍 truncateTitle：有的文件会把一整篇文档塞进 summary 字段，
   * 原样拿来当标题会把列表撑变形。
   */
  const codexThreadTitle = lookupThreadTitle(threadTitles, {
    sessionId: draft.meta.sessionId ?? draft.key,
    fileName
  })
  const title =
    truncateTitle(draft.meta.title ?? '') ||
    truncateTitle(codexThreadTitle ?? '') ||
    deriveTitle(events, fileName)
  const projectName =
    draft.meta.projectName ??
    (projectPath ? baseName(projectPath) : null) ??
    '未归类项目'

  const allWarnings: ScanIssue[] = [...warnings]
  if (skipped > 0) {
    allWarnings.push({
      path: filePath,
      displayPath: toDisplayPath(filePath, { showFullPaths: false, homeDir, platform }),
      kind: 'partial-records',
      reason: `有 ${skipped} 条记录结构无法识别，已跳过。`,
      suggestion: '其余内容不受影响。如果这个会话看起来缺了东西，可以在详情里查看"原始数据"。'
    })
  }

  return {
    id: sessionIdFor(filePath, draft.key),
    title,
    projectName: projectName.trim() === '' ? '未归类项目' : projectName,
    projectPath,
    sourceFile: filePath,
    displaySourceFile: toDisplayPath(filePath, { showFullPaths: false, homeDir, platform }),
    fileSizeBytes,
    startedAt,
    endedAt,
    durationMs,
    eventCount: events.length,
    userMessageCount: events.filter((event) => event.type === 'user_message').length,
    assistantMessageCount: events.filter((event) => event.type === 'assistant_message').length,
    commandCount,
    failedCommandCount,
    changedFileCount: changedFiles.size,
    changedFiles: [...changedFiles],
    testsPassed,
    testsFailed,
    errorCount,
    hasFailures: failedCommandCount > 0 || testsFailed > 0 || errorCount > 0,
    hasCodeChanges: changedFiles.size > 0,
    confidence,
    confidenceScore,
    parserId,
    eventTypeCounts,
    warnings: allWarnings,
    indexedAt: new Date().toISOString(),
    fileModifiedAt: Number.isFinite(modifiedMs) ? new Date(modifiedMs).toISOString() : null,
    agent: {
      threadId: draft.meta.sessionId ?? null,
      parentThreadId: draft.meta.agent?.parentThreadId ?? null,
      nickname: draft.meta.agent?.nickname ?? null,
      role: draft.meta.agent?.role ?? null,
      taskPath: draft.meta.agent?.taskPath ?? null
    },
    events
  }
}

/** 只保留摘要字段，用于左侧列表与本地索引（不含事件，体积小）。 */
export function toSummary(session: CodexSession): Omit<CodexSession, 'events'> {
  const { events: _events, ...summary } = session
  return summary
}
