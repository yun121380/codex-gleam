import {
  CONTENT_PREVIEW_LIMIT,
  DELTA_RECORD_PATTERN,
  MIRROR_MAX_LOOKBACK,
  MIRROR_TIME_WINDOW_MS,
  NOISE_RECORD_TYPES
} from '@shared/constants'
import type { CodexEvent, CodexEventType, FileChange, FileChangeKind, TestSummary } from '@shared/types'
import {
  asNumber,
  asString,
  coerceTimestamp,
  firstDefined,
  firstString,
  flattenTextContent,
  isRecord,
  safeJsonParse
} from '@shared/validators'
import type { NormalizeContext, NormalizedResult, ParsedRecord } from './types'
import { buildUnifiedDiff, parsePatchText } from './patch'
import { isTestCommand, parseTestOutput } from './testOutput'
import { durationFromText, exitCodeFromText, hasHardFailureMarker, parseToolScript } from './toolScript'
import { UsageCollector } from './usage'

/**
 * 把任意形状的记录统一成 CodexEvent。
 *
 * 设计原则：
 *   - 单条记录解析失败绝不影响其他记录（每条都包在 try/catch 里）；
 *   - 认不出的类型归为 unknown，但原始内容 100% 保留在 raw 里；
 *   - 所有字段提取都走"多候选键名"，因为不同版本的字段名并不一致；
 *   - 纯 harness 噪音（用量计数、条目回播）整条丢弃 —— 保留它们等于毁掉时间线。
 */

const WRAPPER_KEYS = ['payload', 'data', 'event', 'item', 'msg', 'body', 'response', 'entry'] as const

const NOISE_TYPE_SET = new Set(NOISE_RECORD_TYPES)

const OUTER_ONLY_KEYS = new Set([
  'timestamp',
  'time',
  'ts',
  'created_at',
  'createdat',
  'date',
  'type',
  'record_type',
  'recordtype',
  'kind',
  'id',
  'seq',
  'sequence',
  'index',
  'level',
  'dir',
  'direction',
  'source',
  'version',
  'call_id',
  'callid'
])

const TIMESTAMP_KEYS = [
  'timestamp',
  'time',
  'ts',
  'created_at',
  'createdAt',
  'created',
  'date',
  'started_at',
  'startedAt',
  'at'
] as const

const CWD_KEYS = [
  'working_directory',
  'workingDirectory',
  'cwd',
  'workspace',
  'workspace_path',
  'workspacePath',
  'project_dir',
  'projectDir',
  'root',
  'repo_path'
] as const

const COMMAND_KEYS = [
  'command',
  'cmd',
  'command_line',
  'commandLine',
  'script',
  'shell_command',
  'argv',
  'args'
] as const

const OUTPUT_KEYS = [
  'output',
  'stdout',
  'aggregated_output',
  'aggregatedOutput',
  'formatted_output',
  'result',
  'stderr',
  'text',
  'content',
  'message'
] as const

const EXIT_CODE_KEYS = ['exit_code', 'exitCode', 'code', 'status', 'returncode', 'return_code'] as const

const PATH_KEYS = [
  'path',
  'file',
  'filename',
  'file_path',
  'filePath',
  'target',
  'target_file',
  'uri'
] as const

const TYPE_MAP: Record<string, CodexEventType> = {
  // 会话起点 / 元信息
  session_start: 'session_start',
  session_meta: 'session_start',
  session_configured: 'session_start',
  session: 'session_start',
  turn_context: 'session_start',
  state: 'session_start',
  meta: 'session_start',
  metadata: 'session_start',

  // 用户
  user_message: 'user_message',
  user: 'user_message',
  user_input: 'user_message',
  user_turn: 'user_message',
  human: 'user_message',
  prompt: 'user_message',

  // 助手
  assistant_message: 'assistant_message',
  assistant: 'assistant_message',
  agent_message: 'assistant_message',
  agent: 'assistant_message',
  model_response: 'assistant_message',
  response: 'assistant_message',

  // 思考过程（单独一类，默认折叠）
  reasoning: 'reasoning',
  agent_reasoning: 'reasoning',
  thinking: 'reasoning',
  thought: 'reasoning',
  chain_of_thought: 'reasoning',

  // 工具调用
  tool_call: 'tool_call',
  tool_calls: 'tool_call',
  tool_use: 'tool_call',
  function_call: 'tool_call',
  custom_tool_call: 'tool_call',
  mcp_tool_call: 'tool_call',
  mcp_tool_call_begin: 'tool_call',
  web_search_call: 'tool_call',
  web_search_begin: 'tool_call',
  tool_search_call: 'tool_call',
  image_generation_call: 'tool_call',
  view_image_tool_call: 'tool_call',
  dynamic_tool_call_request: 'tool_call',

  // 命令
  local_shell_call: 'shell_command',
  exec_command_begin: 'shell_command',
  exec_command: 'shell_command',
  shell_command: 'shell_command',
  shell: 'shell_command',
  command: 'shell_command',
  bash: 'shell_command',

  // 命令输出 / 工具结果
  function_call_output: 'command_output',
  custom_tool_call_output: 'command_output',
  local_shell_call_output: 'command_output',
  tool_result: 'command_output',
  tool_output: 'command_output',
  exec_command_end: 'command_output',
  mcp_tool_call_end: 'command_output',
  web_search_end: 'command_output',
  tool_search_output: 'command_output',
  image_generation_end: 'command_output',
  dynamic_tool_call_response: 'command_output',
  command_output: 'command_output',
  output: 'command_output',

  // 文件
  file_read: 'file_read',
  read_file: 'file_read',
  view_file: 'file_read',
  read: 'file_read',
  file_write: 'file_write',
  write_file: 'file_write',
  create_file: 'file_write',
  write: 'file_write',
  create: 'file_write',
  file_edit: 'file_edit',
  edit_file: 'file_edit',
  edit: 'file_edit',
  update: 'file_edit',
  apply_patch: 'file_edit',
  patch: 'file_edit',
  patch_apply_begin: 'file_edit',
  // 有些会话里 patch_apply_end 是文件改动的**唯一**记录（没有对应的 begin），
  // 所以不能整类丢弃；重复的那些交给内容去重处理。
  patch_apply_end: 'file_edit',
  file_change: 'file_edit',

  // Diff
  git_diff: 'git_diff',
  turn_diff: 'git_diff',
  diff: 'git_diff',

  // 测试
  test_start: 'test_start',
  test_run: 'test_start',
  test_result: 'test_result',
  test_results: 'test_result',
  test: 'test_result',

  // 错误
  error: 'error',
  stream_error: 'error',
  turn_aborted: 'error',
  task_failed: 'error',
  exception: 'error',
  fatal: 'error'
}

const SHELL_TOOL_NAMES = /^(shell|bash|sh|zsh|exec|execute|run|run_command|local_shell|container\.exec|terminal)$/i
const PATCH_TOOL_NAMES = /(apply_patch|patch|edit|write|create_file|str_replace)/i
const READ_TOOL_NAMES = /(read_file|view|cat|open_file|read)/i

function normalizeToken(value: unknown): string {
  const text = asString(value)
  if (text === null) return ''
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
}

interface Unwrapped {
  inner: Record<string, unknown>
  outerType: string
  timestamp: string | null
  callId: string | null
  /** 从最外层到最内层依次经过的类型标记。 */
  typeChain: string[]
}

/**
 * 剥掉外层包装。Codex 的滚动日志常见形状：
 *   { timestamp, type: "response_item", payload: { type: "message", role, content } }
 */
function unwrap(record: Record<string, unknown>): Unwrapped {
  let current = record
  let outerType = normalizeToken(firstDefined(record, ['type', 'record_type', 'kind', 'event_type']))
  let timestamp = coerceTimestamp(firstDefined(record, TIMESTAMP_KEYS))
  let callId = firstString(record, ['call_id', 'callId', 'tool_call_id', 'toolCallId', 'id'])
  /**
   * 剥壳过程中经过的所有类型标记。
   *
   * 噪音判定必须看整条链：`event_msg → item_completed → item{type:custom_tool_call}`
   * 剥到最里层后类型已经变成 custom_tool_call，只看最终类型就会把这条重复播报
   * 当成一次真实的工具调用。
   */
  const typeChain: string[] = outerType === '' ? [] : [outerType]

  for (let depth = 0; depth < 4; depth += 1) {
    const wrapperKey = WRAPPER_KEYS.find((key) => isRecord(current[key]))
    if (!wrapperKey) break

    // 只有当外层确实"只是个信封"时才剥开。
    const hasOwnContent = ['role', 'content', 'command', 'message', 'text'].some(
      (key) => current[key] !== undefined && current[key] !== null
    )
    if (hasOwnContent) break

    const otherKeys = Object.keys(current).filter(
      (key) => key !== wrapperKey && !OUTER_ONLY_KEYS.has(key.toLowerCase())
    )
    if (otherKeys.length > 2) break

    const next = current[wrapperKey] as Record<string, unknown>
    timestamp = timestamp ?? coerceTimestamp(firstDefined(next, TIMESTAMP_KEYS))
    callId = callId ?? firstString(next, ['call_id', 'callId', 'tool_call_id'])
    const innerType = normalizeToken(firstDefined(next, ['type', 'record_type', 'kind', 'event_type']))
    if (innerType !== '') {
      outerType = innerType
      typeChain.push(innerType)
    }
    current = next
  }

  return { inner: current, outerType, timestamp, callId, typeChain }
}

function truncate(text: string, limit = CONTENT_PREVIEW_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（内容较长，已截断。完整内容见"原始数据"）`
}

function firstLine(text: string, limit = 70): string {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '')
  if (!line) return ''
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/**
 * 认出「以用户身份发出、其实是 Codex 自己塞进去的上下文」。
 *
 * Codex Desktop 每开一个会话都会先以 role=user 发一段 `<recommended_plugins>`
 * （可安装插件清单），随后还会不断补 `<environment_context>`（日期、时区、
 * 工作区根目录）。这些都不是人说的话：把它们当成"你说"，时间线开头永远是
 * 一大串插件名，标题也永远是 `<recommended_plugins>`。
 *
 * 判据是整段文本被一个 snake_case 标签包住。实测 150 个真实会话里的 902 段注入内容
 * （recommended_plugins / environment_context / turn_aborted / multi_agent_mode /
 * model_switch / collaboration_mode / skills_instructions / codex_delegation …）
 * 全都带成对的闭合标签，而人写的消息没有一条是这个形状。
 * 用形状而不是固定清单来判断，Codex 以后新加的注入块也能自动认出来。
 */
export function injectedContextTag(text: string): string | null {
  const trimmed = text.trimStart()
  const opening = /^<([a-z][a-z0-9_]*)>/.exec(trimmed)
  if (!opening) return null
  const tag = opening[1] as string
  return trimmed.includes(`</${tag}>`) ? tag : null
}

/**
 * 委派给子智能体的任务：`<codex_delegation><input>真正的指令</input>…`。
 *
 * 这一条和其他注入块不一样 —— 对一个子会话来说，`<input>` 里就是它这趟要做的事，
 * 是这个会话最该显示、也最该当标题的内容。所以只剥掉外壳，把指令留下。
 */
function delegationInput(text: string): string | null {
  const match = /<input>([\s\S]*?)<\/input>/.exec(text)
  const inner = match?.[1]?.trim()
  return inner === undefined || inner === '' ? null : inner
}

/** 命令可能是字符串，也可能是 ["bash","-lc","npm test"] 这样的数组。 */
export function extractCommand(source: unknown): string | null {
  const value = firstDefined(source, COMMAND_KEYS)
  if (value === undefined) return null

  if (typeof value === 'string') return value.trim() === '' ? null : value

  if (Array.isArray(value)) {
    const parts = value.map((entry) => asString(entry) ?? '').filter((entry) => entry !== '')
    if (parts.length === 0) return null

    const shell = (parts[0] ?? '').toLowerCase()
    const isShellWrapper = /(^|[\\/])(bash|sh|zsh|dash|cmd(\.exe)?|powershell(\.exe)?|pwsh)$/.test(shell)
    const flagIndex = parts.findIndex((part) => /^(-lc|-c|-ic|\/c|\/k|-Command|-command)$/.test(part))
    if (isShellWrapper && flagIndex >= 0 && parts.length > flagIndex + 1) {
      return parts.slice(flagIndex + 1).join(' ')
    }
    return parts.join(' ')
  }

  if (isRecord(value)) {
    const nested = extractCommand(value)
    if (nested) return nested
    const flattened = flattenTextContent(value)
    return flattened.trim() === '' ? null : flattened
  }

  return null
}

const NESTED_CONTAINERS = ['metadata', 'meta', 'result', 'info'] as const

/**
 * 先在顶层找，再到 metadata / meta / result / info 里找。
 * Codex 的命令输出常把退出码和耗时塞在 metadata 里。
 */
function nestedNumber(source: unknown, keys: readonly string[]): number | null {
  const direct = asNumber(firstDefined(source, keys))
  if (direct !== null) return direct

  if (isRecord(source)) {
    for (const key of NESTED_CONTAINERS) {
      const nested = source[key]
      if (isRecord(nested)) {
        const value = asNumber(firstDefined(nested, keys))
        if (value !== null) return value
      }
    }
  }
  return null
}

function extractExitCode(source: unknown): number | null {
  return nestedNumber(source, EXIT_CODE_KEYS)
}

/**
 * 有些实现把整个输出对象序列化成字符串塞进 output 字段：
 *   { "output": "{\"output\":\"...\",\"metadata\":{\"exit_code\":1}}" }
 * 这里把它展开，退出码和耗时才拿得到。
 */
function unwrapOutputEnvelope(source: Record<string, unknown>): Record<string, unknown> {
  const raw = source.output
  if (typeof raw !== 'string') return source
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return source

  const parsed = safeJsonParse(trimmed)
  if (!parsed.ok || !isRecord(parsed.value)) return source
  return { ...parsed.value, ...source }
}

function extractOutputText(source: unknown): string {
  if (typeof source === 'string') return source
  if (!isRecord(source)) return flattenTextContent(source)

  for (const key of OUTPUT_KEYS) {
    const value = source[key]
    if (value === undefined || value === null) continue

    if (typeof value === 'string') {
      // 有些实现把输出再套一层 JSON 字符串。
      const trimmed = value.trim()
      if (trimmed.startsWith('{') && trimmed.includes('"output"')) {
        const parsed = safeJsonParse(trimmed)
        if (parsed.ok && isRecord(parsed.value)) {
          const inner = extractOutputText(parsed.value)
          if (inner.trim() !== '') return inner
        }
      }
      if (trimmed !== '') return value
      continue
    }

    if (Array.isArray(value)) {
      const flattened = flattenContentParts(value)
      if (flattened.trim() !== '') return flattened
      continue
    }

    const flattened = flattenTextContent(value)
    if (flattened.trim() !== '') return flattened
  }

  return ''
}

/**
 * 展开 `[{type:'input_text',text:'…'}, {type:'input_image',image_url:'…'}]` 这种内容数组。
 *
 * 图片元素没有文本，直接交给 flattenTextContent 会被静默丢掉 —— 于是用户看到的输出
 * 就"少了一截"。这里给它留一个明确的占位说明。
 */
function flattenContentParts(parts: readonly unknown[]): string {
  const pieces: string[] = []

  for (const part of parts) {
    if (typeof part === 'string') {
      if (part.trim() !== '') pieces.push(part)
      continue
    }
    if (!isRecord(part)) continue

    const kind = normalizeToken(firstDefined(part, ['type', 'kind']))
    if (kind.includes('image')) {
      pieces.push('［这一步还包含一张图片，本应用不显示图片内容］')
      continue
    }
    if (kind.includes('audio') || kind.includes('file')) {
      pieces.push('［这一步还包含一个附件］')
      continue
    }

    const text = flattenTextContent(part)
    if (text.trim() !== '') pieces.push(text)
  }

  return pieces.join('\n')
}

function toChangeKind(token: string): FileChangeKind {
  if (token.includes('add') || token.includes('create') || token.includes('write')) return 'write'
  if (token.includes('delete') || token.includes('remove')) return 'delete'
  if (token.includes('move') || token.includes('rename')) return 'rename'
  if (token.includes('read') || token.includes('view')) return 'read'
  if (token.includes('update') || token.includes('edit') || token.includes('patch')) return 'edit'
  return 'unknown'
}

function changeFromEntry(path: string, entry: unknown, fallbackKind: FileChangeKind): FileChange {
  const change: FileChange = {
    path,
    displayPath: path,
    kind: fallbackKind,
    additions: 0,
    deletions: 0
  }

  if (!isRecord(entry)) return change

  // Codex 的 changes 形状：{ "<path>": { "update": { "unified_diff": "..." } } }
  for (const [actionKey, actionValue] of Object.entries(entry)) {
    const kind = toChangeKind(normalizeToken(actionKey))
    if (kind === 'unknown') continue
    change.kind = kind
    if (isRecord(actionValue)) {
      const diff = firstString(actionValue, ['unified_diff', 'unifiedDiff', 'diff', 'patch'])
      const before = firstString(actionValue, ['before', 'old_content', 'oldContent', 'original'])
      const after = firstString(actionValue, ['after', 'new_content', 'newContent', 'content'])
      if (diff) change.diff = diff
      if (before !== null) change.before = before
      if (after !== null) change.after = after
    } else if (typeof actionValue === 'string' && kind === 'write') {
      change.after = actionValue
    }
  }

  const diff = firstString(entry, ['unified_diff', 'unifiedDiff', 'diff', 'patch'])
  if (diff && !change.diff) change.diff = diff
  const before = firstString(entry, ['before', 'old_content', 'oldContent', 'original', 'old_string'])
  const after = firstString(entry, ['after', 'new_content', 'newContent', 'content', 'new_string'])
  if (before !== null && change.before === undefined) change.before = before
  if (after !== null && change.after === undefined) change.after = after

  const explicitKind = normalizeToken(firstDefined(entry, ['kind', 'action', 'change_type', 'operation']))
  if (explicitKind !== '') {
    const kind = toChangeKind(explicitKind)
    if (kind !== 'unknown') change.kind = kind
  }

  if (!change.diff && change.before !== undefined && change.after !== undefined) {
    change.diff = buildUnifiedDiff(path, change.before, change.after)
  }

  if (change.diff) {
    const lines = change.diff.split(/\r?\n/)
    change.additions = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
    change.deletions = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length
  } else if (change.after !== undefined && change.before === undefined) {
    change.additions = change.after.split(/\r?\n/).length
  }

  return change
}

/** 从记录里尽可能挖出文件改动信息。 */
export function extractFileChanges(source: unknown, fallbackKind: FileChangeKind = 'edit'): FileChange[] {
  if (!isRecord(source)) return []
  const changes: FileChange[] = []

  const changesField = firstDefined(source, ['changes', 'file_changes', 'fileChanges', 'edits', 'files'])

  if (isRecord(changesField)) {
    for (const [path, entry] of Object.entries(changesField)) {
      changes.push(changeFromEntry(path, entry, fallbackKind))
    }
  } else if (Array.isArray(changesField)) {
    for (const entry of changesField) {
      if (typeof entry === 'string') {
        changes.push(changeFromEntry(entry, null, fallbackKind))
        continue
      }
      const path = firstString(entry, PATH_KEYS)
      if (path) changes.push(changeFromEntry(path, entry, fallbackKind))
    }
  }

  // 纯文本补丁 / diff
  const patchText = firstString(source, [
    'patch',
    'diff',
    'unified_diff',
    'unifiedDiff',
    'input',
    'patch_text'
  ])
  if (patchText) {
    for (const change of parsePatchText(patchText)) changes.push(change)
  }

  // 单文件形状：{ path, content } / { path, diff }
  if (changes.length === 0) {
    const path = firstString(source, PATH_KEYS)
    if (path) changes.push(changeFromEntry(path, source, fallbackKind))
  }

  // 去重（同一路径合并）。
  const merged = new Map<string, FileChange>()
  for (const change of changes) {
    if (change.path.trim() === '') continue
    const existing = merged.get(change.path)
    if (!existing) {
      merged.set(change.path, change)
      continue
    }
    existing.additions += change.additions
    existing.deletions += change.deletions
    if (!existing.diff && change.diff) existing.diff = change.diff
    if (existing.before === undefined && change.before !== undefined) existing.before = change.before
    if (existing.after === undefined && change.after !== undefined) existing.after = change.after
  }

  return [...merged.values()]
}

function extractStructuredTest(source: unknown): TestSummary | null {
  if (!isRecord(source)) return null
  const container = isRecord(source.test)
    ? source.test
    : isRecord(source.tests)
      ? source.tests
      : isRecord(source.summary)
        ? source.summary
        : source

  const passed = asNumber(firstDefined(container, ['passed', 'pass', 'passes', 'succeeded', 'ok']))
  const failed = asNumber(firstDefined(container, ['failed', 'fail', 'failures', 'failing', 'errors']))
  const skipped = asNumber(firstDefined(container, ['skipped', 'skip', 'pending', 'ignored', 'todo']))

  if (passed === null && failed === null && skipped === null) return null

  const summary: TestSummary = {
    passed: passed ?? 0,
    failed: failed ?? 0,
    skipped: skipped ?? 0,
    failures: []
  }

  const framework = firstString(container, ['framework', 'runner', 'tool'])
  if (framework) summary.framework = framework

  const total = asNumber(firstDefined(container, ['total', 'count']))
  if (total !== null) summary.total = total

  const duration = asNumber(firstDefined(container, ['duration_ms', 'durationMs', 'duration']))
  if (duration !== null) summary.durationMs = duration

  const failureList = firstDefined(container, ['failures', 'failed_tests', 'failedTests'])
  if (Array.isArray(failureList)) {
    for (const entry of failureList) {
      if (typeof entry === 'string') {
        summary.failures.push({ name: entry })
        continue
      }
      const name = firstString(entry, ['name', 'title', 'test', 'full_name'])
      if (!name) continue
      const message = firstString(entry, ['message', 'error', 'reason', 'detail'])
      summary.failures.push(message ? { name, message } : { name })
    }
  }

  return summary
}

function resolveTypeFromShape(inner: Record<string, unknown>, role: string): CodexEventType | null {
  if (role === 'user' || role === 'human') return 'user_message'
  if (role === 'assistant' || role === 'agent' || role === 'model') return 'assistant_message'
  if (role === 'system' || role === 'developer') return 'session_start'
  if (role === 'tool' || role === 'function') return 'command_output'

  if (extractCommand(inner) !== null) return 'shell_command'
  if (firstDefined(inner, ['stdout', 'stderr', 'exit_code', 'exitCode']) !== undefined) {
    return 'command_output'
  }
  if (firstDefined(inner, ['diff', 'unified_diff', 'patch']) !== undefined) return 'git_diff'
  if (firstDefined(inner, ['changes', 'file_changes', 'edits']) !== undefined) return 'file_edit'
  if (firstDefined(inner, ['error', 'exception', 'stack']) !== undefined) return 'error'
  if (firstDefined(inner, PATH_KEYS) !== undefined) {
    // 有前后全文 → 修改；只有内容 → 写入。
    if (firstDefined(inner, ['before', 'old_content', 'old_string']) !== undefined) return 'file_edit'
    if (firstDefined(inner, ['content', 'after', 'new_content']) !== undefined) return 'file_write'
  }
  return null
}

/** 归一化单条记录。返回 0—n 个事件。 */
export function normalizeRecord(record: ParsedRecord, ctx: NormalizeContext): CodexEvent[] {
  const { value, line } = record
  if (!isRecord(value)) {
    // 纯字符串行也可能有意义（例如纯文本日志混进来）。
    const text = asString(value)
    if (text === null || text.trim() === '') return []
    return [
      baseEvent(ctx, {
        type: 'unknown',
        title: firstLine(text) || '一条记录',
        content: truncate(text),
        raw: value,
        sourceLine: line,
        timestamp: null
      })
    ]
  }

  const { inner, outerType, timestamp, callId, typeChain } = unwrap(value)
  const role = normalizeToken(firstDefined(inner, ['role', 'author', 'speaker', 'sender']))
  const innerType = normalizeToken(firstDefined(inner, ['type', 'record_type', 'kind', 'event_type']))

  const typeToken = innerType !== '' ? innerType : outerType

  // 用量数字和模型名必须在噪音判定之前捞走：token_count / task_started 恰好都在
  // 噪音名单上，等下面那个 if 把它们丢掉就没有第二次机会了。放在这里还顺带解决了
  // 另一半问题 —— 一个调用点同时看得见被丢弃的用量记录和活下来的 turn_context
  // （模型名写在那里）。采集器自己吞掉一切异常，这一行不会让解析失败。
  ctx.noteUsage?.(inner)

  // 纯噪音整条丢弃。放在最前面：这类记录能占到全部记录的一半以上，
  // 早一步丢掉既让时间线可读，也省下大量内存。
  // 流式增量片段同理 —— 完整内容另有一条记录。
  //
  // 判定看整条剥壳链，而不只是最终类型：item_completed 的壳里装着一个
  // 完整的 custom_tool_call 副本，只看最终类型会把它当成真实调用。
  if (
    typeChain.some((token) => NOISE_TYPE_SET.has(token)) ||
    NOISE_TYPE_SET.has(typeToken) ||
    DELTA_RECORD_PATTERN.test(typeToken)
  ) {
    ctx.noteNoise?.()
    return []
  }

  let type: CodexEventType | undefined = TYPE_MAP[typeToken]

  if (typeToken === 'message' || typeToken === 'chat' || typeToken === '') {
    type = resolveTypeFromShape(inner, role) ?? undefined
  }
  if (!type) {
    type = resolveTypeFromShape(inner, role) ?? 'unknown'
  }

  const toolName =
    firstString(inner, ['name', 'tool_name', 'toolName', 'tool', 'function', 'function_name']) ??
    undefined

  // 工具调用要按工具名细分：shell 工具其实是执行命令，patch 工具其实是改文件。
  if (type === 'tool_call' && toolName) {
    if (SHELL_TOOL_NAMES.test(toolName)) type = 'shell_command'
    else if (PATCH_TOOL_NAMES.test(toolName)) type = 'file_edit'
    else if (READ_TOOL_NAMES.test(toolName)) type = 'file_read'
  }

  // arguments 常常是一段 JSON 字符串，先展开，后面的字段提取才拿得到 command。
  const argumentsField = firstDefined(inner, ['arguments', 'args', 'input', 'parameters'])
  let expanded: Record<string, unknown> = inner
  let toolScript: ReturnType<typeof parseToolScript> | null = null

  if (typeof argumentsField === 'string') {
    const parsed = safeJsonParse(argumentsField)
    if (parsed.ok && isRecord(parsed.value)) {
      expanded = { ...parsed.value, ...inner }
    } else {
      // 不是 JSON —— 有些 harness 直接塞一段调用 tools.* 的代码进来，
      // 真正的命令和补丁都藏在里面。
      const script = parseToolScript(argumentsField)
      if (script.looksLikeToolScript) toolScript = script
    }
  } else if (isRecord(argumentsField)) {
    expanded = { ...argumentsField, ...inner }
  }

  // 工具脚本决定了这一步到底在做什么：改文件 > 执行命令 > 调用工具。
  if (toolScript) {
    if (toolScript.patches.length > 0) type = 'file_edit'
    else if (toolScript.commands.length > 0) type = 'shell_command'
    else if (type !== 'file_read') type = 'tool_call'
  }

  if (type === 'unknown') {
    const refined = resolveTypeFromShape(expanded, role)
    if (refined) type = refined
  }

  const workingDirectory =
    firstString(expanded, CWD_KEYS) ?? firstString(inner, CWD_KEYS) ?? ctx.workingDirectory

  const event = baseEvent(ctx, {
    type,
    title: '',
    content: '',
    raw: value,
    sourceLine: line,
    timestamp
  })

  event.workingDirectory = workingDirectory
  if (role !== '') event.role = role
  if (toolName) event.toolName = toolName
  if (callId) event.callId = callId

  const fallbackTitle = FALLBACK_TITLES[type]

  switch (type) {
    case 'session_start': {
      const model = firstString(expanded, ['model', 'model_name', 'engine'])
      const parts: string[] = []
      if (workingDirectory) parts.push(`项目目录：${workingDirectory}`)
      if (model) parts.push(`模型：${model}`)
      const instructions = firstString(expanded, ['instructions', 'system_prompt', 'systemPrompt'])
      const text = flattenTextContent(expanded.content)
      if (text.trim() !== '') parts.push(text)
      else if (instructions) parts.push(instructions)
      event.title = '会话开始'
      event.content = truncate(parts.join('\n'))
      break
    }

    case 'user_message':
    case 'assistant_message':
    case 'reasoning': {
      let text = flattenTextContent(
        firstDefined(inner, ['content', 'message', 'text', 'reasoning', 'summary']) ?? inner
      )

      // 以用户身份发出、其实是 Codex 自己塞的上下文：归到「会话开始」那一类，
      // 免得时间线上冒出一条根本不是人说的「你说」。
      const injected = type === 'user_message' ? injectedContextTag(text) : null
      if (injected !== null) {
        const delegated = injected === 'codex_delegation' ? delegationInput(text) : null
        if (delegated === null) {
          event.type = 'session_start'
          event.title = `Codex 附加的上下文（${injected}）`
          event.content = truncate(text)
          break
        }
        // 委派任务：外壳丢掉，指令留下 —— 那才是这个子会话真正要做的事。
        text = delegated
      }

      event.content = truncate(text)
      const preview = firstLine(text)
      if (type === 'user_message') {
        event.title = preview === '' ? '你的消息' : preview
      } else if (type === 'reasoning') {
        event.title = preview === '' ? '思考过程' : preview
      } else {
        event.title = preview === '' ? 'Codex 回复' : preview
      }
      break
    }

    case 'shell_command':
    case 'test_start': {
      // 工具脚本里可能有多条命令（Promise.all 并发执行）。
      const command = toolScript
        ? toolScript.commands.join('\n')
        : extractCommand(expanded) ?? ''
      event.command = command
      event.title = command === '' ? fallbackTitle : firstLine(command, 110)

      const explanation = firstString(expanded, ['explanation', 'reason', 'justification', 'description'])
      const extra: string[] = [command]
      if (toolScript && toolScript.commands.length > 1) {
        extra.unshift(`这一步并发执行了 ${toolScript.commands.length} 条命令：`)
      }
      if (explanation) extra.push(`\n说明：${explanation}`)
      event.content = truncate(extra.join('\n').trim())
      if (isTestCommand(command)) event.type = 'test_start'
      break
    }

    case 'command_output': {
      const source = unwrapOutputEnvelope(expanded)
      const text = extractOutputText(source)
      // 结构化字段里没有退出码时，退回到从输出文本里找（\"exit code: 1\" 之类）。
      const exitCode = extractExitCode(source) ?? exitCodeFromText(text)
      event.content = truncate(text)
      event.exitCode = exitCode
      if (exitCode !== null) event.success = exitCode === 0
      const explicitSuccess =
        typeof source.success === 'boolean'
          ? source.success
          : typeof inner.success === 'boolean'
            ? inner.success
            : null
      if (explicitSuccess !== null) event.success = explicitSuccess
      // 完全没有退出码时，只认无歧义的失败标记，其余保持"未记录"。
      if (event.success === null && hasHardFailureMarker(text)) event.success = false

      const durationMs = nestedNumber(source, ['duration_ms', 'durationMs'])
      const durationSeconds = nestedNumber(source, ['duration_seconds', 'durationSeconds'])
      if (durationMs !== null) event.durationMs = durationMs
      else if (durationSeconds !== null) event.durationMs = Math.round(durationSeconds * 1000)
      else {
        const fromText = durationFromText(text)
        if (fromText !== null) event.durationMs = fromText
      }
      event.title =
        exitCode === null
          ? '命令输出'
          : exitCode === 0
            ? '命令输出（成功）'
            : `命令输出（失败，退出码 ${exitCode}）`
      break
    }

    case 'file_read': {
      const changes = extractFileChanges(expanded, 'read')
      const path = changes[0]?.path ?? firstString(expanded, PATH_KEYS) ?? ''
      event.relatedFiles = changes.length > 0 ? changes.map((change) => change.path) : path ? [path] : []
      event.title = path === '' ? '读取文件' : `读取 ${path}`
      event.content = truncate(flattenTextContent(firstDefined(expanded, ['content', 'text', 'output']) ?? ''))
      break
    }

    case 'file_write':
    case 'file_edit':
    case 'git_diff': {
      const fallbackKind: FileChangeKind = type === 'file_write' ? 'write' : 'edit'
      const changes = toolScript?.patches.length
        ? toolScript.patches
        : extractFileChanges(expanded, fallbackKind)

      /*
       * 一条声称"改了文件"、却没说改了哪个文件的记录，其实是上一步的执行结果
       * （典型例子是 patch_apply_end：只带 success 和一行 stdout）。
       * 按结果展示才对 —— 否则时间线上会多出一条什么都没说的"修改文件"。
       */
      if (changes.length === 0) {
        const resultText = extractOutputText(expanded)
        if (resultText.trim() !== '') {
          event.type = 'command_output'
          event.content = truncate(resultText)
          const ok = typeof expanded.success === 'boolean' ? expanded.success : null
          if (ok !== null) event.success = ok
          event.title = firstLine(resultText, 70) || '执行结果'
          break
        }
      }

      event.fileChanges = changes
      event.relatedFiles = changes.map((change) => change.path)
      const additions = changes.reduce((sum, change) => sum + change.additions, 0)
      const deletions = changes.reduce((sum, change) => sum + change.deletions, 0)
      if (changes.length === 0) {
        event.title = fallbackTitle
      } else if (changes.length === 1) {
        event.title = `${type === 'file_write' ? '写入' : '修改'} ${changes[0]?.path ?? ''}`
      } else {
        event.title = `${type === 'file_write' ? '写入' : '修改'} ${changes.length} 个文件`
      }
      const summaryLine =
        changes.length > 0 ? `共 ${changes.length} 个文件，+${additions} / -${deletions} 行` : ''
      const body = changes
        .map((change) => change.diff ?? '')
        .filter((entry) => entry.trim() !== '')
        .join('\n\n')
      event.content = truncate([summaryLine, body].filter((entry) => entry !== '').join('\n\n'))
      const failure = firstString(expanded, ['error', 'failure', 'message'])
      if (failure && /fail|error|错误/i.test(failure)) {
        event.success = false
        event.content = truncate(`${failure}\n\n${event.content}`)
      }
      break
    }

    case 'test_result': {
      const text = extractOutputText(expanded)
      const summary = extractStructuredTest(expanded) ?? parseTestOutput(text)
      if (summary) {
        event.test = summary
        event.success = summary.failed === 0
        event.title = `测试结果：${summary.passed} 通过 / ${summary.failed} 失败${
          summary.skipped > 0 ? ` / ${summary.skipped} 跳过` : ''
        }`
      } else {
        event.title = '测试结果'
      }
      event.content = truncate(text)
      break
    }

    case 'error': {
      const text =
        firstString(expanded, ['error', 'message', 'reason', 'detail', 'description']) ??
        flattenTextContent(expanded)
      const stack = firstString(expanded, ['stack', 'traceback', 'stack_trace'])
      event.success = false
      event.title = firstLine(text) || '出错了'
      event.content = truncate([text, stack].filter((entry) => entry && entry !== '').join('\n\n'))
      break
    }

    case 'tool_call': {
      if (toolScript) {
        // 认得出具体调用了哪个工具时，标题就写那个工具，而不是笼统的 exec。
        const named = toolScript.calls.map((call) => call.toolName).filter((name): name is string => !!name)
        const unique = [...new Set(named)]
        event.title =
          unique.length === 0
            ? toolName
              ? `调用工具：${toolName}`
              : '调用工具'
            : unique.length === 1
              ? `调用工具：${unique[0]}`
              : `调用 ${unique.length} 个工具：${unique.join('、')}`
        event.content = truncate(typeof argumentsField === 'string' ? argumentsField : safeStringify(expanded))
        break
      }
      const text = flattenTextContent(firstDefined(expanded, ['arguments', 'input', 'content']) ?? expanded)
      event.title = toolName ? `调用工具：${toolName}` : '调用工具'
      event.content = truncate(text === '' ? safeStringify(expanded) : text)
      break
    }

    default: {
      const text = flattenTextContent(inner)
      event.title = typeToken === '' ? '其他记录' : `其他记录（${typeToken}）`
      event.content = truncate(text === '' ? safeStringify(value) : text)
      break
    }
  }

  // 兜底：内容为空时至少把原始 JSON 摆出来，避免界面上一片空白。
  if (event.content.trim() === '') {
    event.content = truncate(safeStringify(value))
  }
  if (event.title.trim() === '') {
    event.title = FALLBACK_TITLES[event.type]
  }

  const relatedFromChanges = event.fileChanges?.map((change) => change.path) ?? []
  const relatedFromFields = collectPaths(expanded)
  event.relatedFiles = unique([...event.relatedFiles, ...relatedFromChanges, ...relatedFromFields])

  return [event]
}

const FALLBACK_TITLES: Record<CodexEventType, string> = {
  session_start: '会话开始',
  user_message: '你的消息',
  assistant_message: 'Codex 回复',
  reasoning: '思考过程',
  tool_call: '调用工具',
  shell_command: '执行命令',
  command_output: '命令输出',
  file_read: '读取文件',
  file_write: '写入文件',
  file_edit: '修改文件',
  git_diff: '代码差异',
  test_start: '开始测试',
  test_result: '测试结果',
  error: '出错了',
  unknown: '其他记录'
}

function collectPaths(source: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const key of PATH_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '' && !value.includes('\n')) paths.push(value)
  }
  const list = firstDefined(source, ['files', 'paths', 'file_paths'])
  if (Array.isArray(list)) {
    for (const entry of list) {
      const text = asString(entry)
      if (text && text.trim() !== '') paths.push(text)
      else {
        const nested = firstString(entry, PATH_KEYS)
        if (nested) paths.push(nested)
      }
    }
  }
  return paths
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))]
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function baseEvent(
  ctx: NormalizeContext,
  init: {
    type: CodexEventType
    title: string
    content: string
    raw: unknown
    sourceLine: number
    timestamp: string | null
  }
): CodexEvent {
  return {
    id: ctx.nextId(),
    timestamp: init.timestamp,
    type: init.type,
    title: init.title,
    content: init.content,
    sourceFile: ctx.filePath,
    workingDirectory: ctx.workingDirectory,
    relatedFiles: [],
    // 展示用路径统一由 buildSession 在最后一步算好（那里才拿得到 homeDir）。
    displayWorkingDirectory: null,
    displayRelatedFiles: [],
    success: null,
    // 扫描阶段不保留原始 JSON：1000+ 个会话同时留着它会撑爆内存。
    raw: ctx.keepRaw === false ? null : init.raw,
    parserId: ctx.parserId,
    sourceLine: init.sourceLine
  }
}

/**
 * 把命令与它的输出配对：
 *   - 输出里的退出码决定命令是否成功；
 *   - 测试命令的输出会被升级成 test_result；
 *   - 有 call_id 时按 id 精确匹配，没有就按"最近一条未配对的命令"。
 */
const COMMAND_LIKE_TYPES = new Set<CodexEventType>(['shell_command', 'test_start', 'tool_call'])

/**
 * 配对成功后，把输出的标题换成"它是哪条命令的输出"。
 * 否则时间线上会出现「命令输出 / 命令输出（成功）」这种重复。
 */
function retitleOutput(event: CodexEvent): void {
  const command = firstLine(event.command ?? '', 70)
  if (command === '') return

  const status =
    event.success === true
      ? '成功'
      : event.success === false
        ? event.exitCode === null || event.exitCode === undefined
          ? '失败'
          : `失败，退出码 ${event.exitCode}`
        : '结果未记录'

  event.title = `${command}（${status}）`
}

export function linkCommandOutputs(events: CodexEvent[]): void {
  /** 所有带 call_id 的事件，用于精确配对。 */
  const byCallId = new Map<string, CodexEvent>()
  /** 还没配到输出的命令，按出现顺序当栈用（没有 call_id 时的兜底）。 */
  const pending: CodexEvent[] = []

  for (const event of events) {
    if (event.callId && !byCallId.has(event.callId)) byCallId.set(event.callId, event)

    if (COMMAND_LIKE_TYPES.has(event.type)) {
      pending.push(event)
      continue
    }

    if (event.type !== 'command_output') continue

    const found = event.callId ? byCallId.get(event.callId) : undefined
    const target = found && found !== event ? found : undefined

    // 配到的不是命令（例如 apply_patch 的执行结果）：把成败传过去就够了，
    // 它不该被算成一条"命令"。
    if (target && !COMMAND_LIKE_TYPES.has(target.type)) {
      event.linkedCommandId = target.id
      if (event.success !== null && target.success === null) target.success = event.success
      continue
    }

    let command = target
    if (!command) {
      // 带 call_id 却配不上任何事件时不做兜底猜测，
      // 否则会覆盖掉某条已经配对好的命令的结果。
      if (event.callId) continue
      command = pending.pop()
    }
    if (!command) continue

    if (target) {
      if (event.callId) byCallId.delete(event.callId)
      const index = pending.indexOf(target)
      if (index >= 0) pending.splice(index, 1)
    }

    event.linkedCommandId = command.id
    if (!event.command && command.command) event.command = command.command
    if (event.workingDirectory === null) event.workingDirectory = command.workingDirectory
    retitleOutput(event)

    if (event.success !== null) command.success = event.success
    else if (command.success === null && event.exitCode !== null && event.exitCode !== undefined) {
      command.success = event.exitCode === 0
    }

    if (command.timestamp && event.timestamp && event.durationMs == null) {
      const delta = Date.parse(event.timestamp) - Date.parse(command.timestamp)
      if (Number.isFinite(delta) && delta >= 0 && delta < 86_400_000) event.durationMs = delta
    }

    const commandText = event.command ?? command.command ?? ''
    if (isTestCommand(commandText)) {
      command.type = 'test_start'
      const summary = parseTestOutput(event.content)
      if (summary) {
        event.type = 'test_result'
        event.test = summary
        event.success = summary.failed === 0
        command.success = summary.failed === 0
        event.title = `测试结果：${summary.passed} 通过 / ${summary.failed} 失败${
          summary.skipped > 0 ? ` / ${summary.skipped} 跳过` : ''
        }`
      }
    }
  }
}

/** 归一化整批记录。任何单条记录出错都只会被记账，不会中断整体解析。 */
export function normalizeRecords(
  records: readonly ParsedRecord[],
  ctx: NormalizeContext
): NormalizedResult {
  const events: CodexEvent[] = []
  let skipped = 0
  let dropped = 0

  let wasNoise: boolean
  const usage = new UsageCollector()
  const recordCtx: NormalizeContext = {
    ...ctx,
    noteNoise: () => {
      wasNoise = true
    },
    noteUsage: (record) => usage.note(record)
  }

  for (const record of records) {
    try {
      wasNoise = false
      const produced = normalizeRecord(record, recordCtx)
      if (wasNoise) dropped += 1
      else if (produced.length === 0) skipped += 1
      for (const event of produced) events.push(event)
    } catch (error) {
      skipped += 1
      events.push(
        baseEvent(ctx, {
          type: 'unknown',
          title: '这条记录读不懂',
          content: `这条记录的结构无法识别：${
            error instanceof Error ? error.message : String(error)
          }\n原始内容已完整保留在下方"原始数据"里。`,
          raw: record.value,
          sourceLine: record.line,
          timestamp: null
        })
      )
    }
  }

  const deduped = collapseMirroredMessages(events)
  linkCommandOutputs(deduped)
  return {
    events: collapseSessionStarts(deduped),
    skipped,
    dropped,
    usage: usage.summary()
  }
}

/**
 * 允许按"内容完全一致"去重的类型白名单。
 *
 * 消息与思考过程：同一句话连着出现两次只可能是重复记录。
 * 文件改动：同一个补丁连着出现两次也只可能是重复记录 ——
 * 真的第二次应用同一个补丁会失败，diff 不会一模一样。
 *
 * **命令与命令输出刻意不在其中**：Codex 完全可能连着跑两次同样的命令
 * （改动前后各跑一次测试就是最典型的例子），那两步都真实发生过。
 */
const MIRRORABLE_TYPES = new Set<CodexEventType>([
  'user_message',
  'assistant_message',
  'reasoning',
  'file_edit',
  'file_write',
  'git_diff'
])

/**
 * 没有时间戳可比时，仍然按"紧挨着"判定重复。
 *
 * 这是给那些不写时间戳的日志留的兜底路径 —— 有时间戳时以时间窗口为准。
 */
const MIRROR_ADJACENT_WINDOW = 3

function timeOf(event: CodexEvent): number | null {
  if (!event.timestamp) return null
  const parsed = Date.parse(event.timestamp)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * 合并被重复记录的事件。
 *
 * 有些 harness 有两条并行的记录通道：一条是给界面看的通知（`event_msg`），
 * 一条是正式记录（`response_item`），同一件事会被写两遍。
 * 实测一个会话 8807 个事件里有 1435 对重复 —— 时间线上每句话都出现两次。
 *
 * **两条镜像记录不一定挨着。** 实测里它们中间常常隔着这一回合的思考、回复和
 * 若干条 turn_context，最远隔了 48 条事件；只看紧邻的三条，绝大多数都漏掉了。
 * 所以判据换成时间：镜像记录的时间戳几乎相同（实测最大差 2.44 秒），
 * 而用户真的把同一句话说两遍，中间至少隔着一次回复（实测最小差 3.22 秒）。
 *
 * 保留原来的"紧邻"判定作为兜底，这样没有时间戳的日志行为不变。
 */
export function collapseMirroredMessages(events: readonly CodexEvent[]): CodexEvent[] {
  const result: CodexEvent[] = []

  for (const event of events) {
    if (!MIRRORABLE_TYPES.has(event.type) || event.content.trim() === '') {
      result.push(event)
      continue
    }

    const at = timeOf(event)
    const from = Math.max(0, result.length - MIRROR_MAX_LOOKBACK)
    let mirrored = false

    for (let index = result.length - 1; index >= from; index -= 1) {
      const previous = result[index]
      if (!previous) continue

      const adjacent = index >= result.length - MIRROR_ADJACENT_WINDOW
      if (!adjacent) {
        // 当前事件没有时间戳时无从比较，退回"只看紧邻几条"。
        if (at === null) break
        // 越过时间窗口就可以停了：更早的事件只会隔得更远。
        // 中间偶尔混进没有时间戳的事件时跳过它，不要因此中断整轮回看。
        const previousAt = timeOf(previous)
        if (previousAt !== null && Math.abs(at - previousAt) > MIRROR_TIME_WINDOW_MS) break
      }

      if (previous.type === event.type && previous.content === event.content) {
        mirrored = true
        break
      }
    }

    if (!mirrored) result.push(event)
  }

  return result
}

/**
 * 「会话开始」只保留第一条。
 *
 * 真实日志里每个回合都会重发一次 turn_context / 系统提示，实测 12 个文件产生了
 * 149 条「会话开始」，散落在时间线各处，看起来就像会话被反复重启。
 * 后续记录里的项目目录仍然会被吸收到第一条上，信息不丢。
 */
export function collapseSessionStarts(events: readonly CodexEvent[]): CodexEvent[] {
  let kept: CodexEvent | null = null
  const result: CodexEvent[] = []

  for (const event of events) {
    if (event.type !== 'session_start') {
      result.push(event)
      continue
    }

    if (kept === null) {
      kept = event
      result.push(event)
      continue
    }

    // 丢弃重复的那条，但把它带来的新信息补到保留的那条上。
    if (kept.workingDirectory === null && event.workingDirectory !== null) {
      kept.workingDirectory = event.workingDirectory
    }
    if (kept.content.trim() === '' && event.content.trim() !== '') {
      kept.content = event.content
    }
  }

  return result
}
