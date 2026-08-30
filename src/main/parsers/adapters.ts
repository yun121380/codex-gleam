import { asString, coerceTimestamp, firstDefined, firstString, isRecord } from '@shared/validators'
import type {
  AgentMeta,
  DraftMeta,
  ParsedRecord,
  ParserInput,
  SessionDraft,
  SessionParser
} from './types'

/** 常见的"记录数组"字段名。不同版本 Codex / 导出工具用的名字都不一样。 */
const RECORD_ARRAY_KEYS = [
  'events',
  'messages',
  'turns',
  'items',
  'records',
  'history',
  'entries',
  'conversation',
  'transcript',
  'steps',
  'log',
  'logs'
] as const

const SESSION_ID_KEYS = [
  'session_id',
  'sessionId',
  'conversation_id',
  'conversationId',
  'thread_id',
  'threadId',
  'rollout_id',
  'id'
] as const

const TITLE_KEYS = ['title', 'name', 'summary', 'topic', 'label', 'description'] as const

const CWD_KEYS = [
  'working_directory',
  'workingDirectory',
  'cwd',
  'workspace',
  'workspace_path',
  'project_dir',
  'projectDir',
  'repo_path'
] as const

function readMeta(source: unknown): DraftMeta {
  if (!isRecord(source)) return {}

  const nested = ['session', 'meta', 'metadata', 'session_meta', 'info', 'header'].map((key) =>
    isRecord(source[key]) ? (source[key] as Record<string, unknown>) : null
  )
  const layers = [source, ...nested.filter((layer): layer is Record<string, unknown> => layer !== null)]

  const pick = (keys: readonly string[]): string | null => {
    for (const layer of layers) {
      const value = firstString(layer, keys)
      if (value !== null) return value
    }
    return null
  }

  const startedAt = (() => {
    for (const layer of layers) {
      const value = coerceTimestamp(
        firstDefined(layer, ['started_at', 'startedAt', 'created_at', 'createdAt', 'timestamp', 'time'])
      )
      if (value) return value
    }
    return null
  })()

  const gitLayer = layers.find((layer) => isRecord(layer.git))
  const projectFromGit = gitLayer && isRecord(gitLayer.git) ? firstString(gitLayer.git, ['repository_url', 'repo', 'name']) : null

  return {
    sessionId: pick(SESSION_ID_KEYS),
    title: pick(TITLE_KEYS),
    workingDirectory: pick(CWD_KEYS),
    model: pick(['model', 'model_name', 'engine']),
    startedAt,
    endedAt: (() => {
      for (const layer of layers) {
        const value = coerceTimestamp(firstDefined(layer, ['ended_at', 'endedAt', 'finished_at', 'updated_at']))
        if (value) return value
      }
      return null
    })(),
    projectName: pick(['project', 'project_name', 'projectName']) ?? projectFromGit,
    raw: source
  }
}

/**
 * 读出多智能体信息。
 *
 * 单独一个函数、而不是并进 readMeta，是因为这些字段藏在 payload 里，
 * 而 readMeta 的取值层级里刻意没有 payload —— 一旦加进去，projectName、
 * startedAt 这些字段的取值来源也会跟着变，那是另一回事了。
 *
 * Codex 的 session_meta 长这样（只列相关字段）：
 *   { session_id, thread_source: "subagent", parent_thread_id, agent_nickname: "Kepler",
 *     agent_role: "explorer", agent_path: "/root/voice_slice" }
 */
function readAgentMeta(source: unknown): AgentMeta | undefined {
  if (!isRecord(source)) return undefined

  const payload = isRecord(source.payload) ? source.payload : null
  const layers = payload === null ? [source] : [source, payload]

  const pick = (keys: readonly string[]): string | null => {
    for (const layer of layers) {
      const value = firstString(layer, keys)
      if (value !== null) return value
    }
    return null
  }

  const agent: AgentMeta = {
    parentThreadId: pick(['parent_thread_id', 'parentThreadId']),
    nickname: pick(['agent_nickname', 'agentNickname']),
    role: pick(['agent_role', 'agentRole']),
    taskPath: pick(['agent_path', 'agentPath'])
  }

  const known = Object.values(agent).some((value) => value !== null)
  return known ? agent : undefined
}

function findRecordArray(source: Record<string, unknown>): { key: string; records: unknown[] } | null {
  for (const key of RECORD_ARRAY_KEYS) {
    const value = source[key]
    if (Array.isArray(value) && value.length > 0) return { key, records: value }
  }
  return null
}

function toParsedRecords(values: readonly unknown[], offset = 0): ParsedRecord[] {
  return values.map((value, index) => ({ value, line: offset + index + 1 }))
}

function looksLikeSessionContainer(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (findRecordArray(value) !== null) return true
  return firstString(value, SESSION_ID_KEYS) !== null && firstString(value, TITLE_KEYS) !== null
}

/** 从一条记录里找出它声明的会话 id（只认明确的会话字段，不认普通 id）。 */
function explicitSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null
  const direct = firstString(value, [
    'session_id',
    'sessionId',
    'conversation_id',
    'conversationId',
    'rollout_id'
  ])
  if (direct) return direct

  const outerType = asString(firstDefined(value, ['type', 'record_type'])) ?? ''

  for (const key of ['payload', 'session', 'meta', 'metadata', 'data']) {
    const nested = value[key]
    if (isRecord(nested)) {
      const found = firstString(nested, [
        'session_id',
        'sessionId',
        'conversation_id',
        'conversationId',
        'rollout_id'
      ])
      if (found) return found

      /*
       * 会话元信息行通常自带 id 字段。
       *
       * 类型标记可能写在里层，也可能只写在外层 —— 早期版本的 Codex 就是后者：
       *   { "type": "session_meta", "payload": { "id": "…", "parent_thread_id": "…" } }
       * 里层压根没有 type，payload 里也没有 session_id，只有一个 id。
       * 只看里层的类型，这些文件的会话 id 就永远认不出来（实测有 48 个文件因此
       * 丢掉了 id，连带它们的父子关系也认不出来）。
       */
      const nestedType = asString(firstDefined(nested, ['type', 'record_type'])) ?? ''
      if (/session/i.test(nestedType) || /session/i.test(outerType)) {
        const id = firstString(nested, ['id'])
        if (id) return id
      }
    }
  }

  if (/session/i.test(outerType)) {
    const id = firstString(value, ['id'])
    if (id) return id
  }

  return null
}

/**
 * 这条记录声明自己是从哪些会话派生出来的。
 *
 * 分叉出来的会话（子代理、续写）会把来源会话的历史一起抄进自己的文件，
 * 其中就包括来源会话的那条 session_meta。不认出这层关系，那条被抄进来的
 * 元信息就会被当成"文件里的第二个会话"，还会把整个文件的身份抢过去。
 */
function ancestorIdsOf(value: unknown): string[] {
  if (!isRecord(value)) return []
  const payload = isRecord(value.payload) ? value.payload : null
  const layers = payload === null ? [value] : [value, payload]

  const ids: string[] = []
  for (const layer of layers) {
    for (const key of ['forked_from_id', 'forkedFromId', 'parent_thread_id', 'parentThreadId']) {
      const id = firstString(layer, [key])
      if (id) ids.push(id)
    }
  }
  return ids
}

/**
 * 按会话切分记录。
 *
 * 用"粘性 id"：遇到明确声明会话 id 的记录就切换当前会话，其余记录归属当前会话。
 * 这样既能正确处理"一个文件里拼接了多个会话"，也不会因为只有首行带 id 就错误拆分。
 *
 * 例外是**来源会话**：分叉出来的文件会把来源会话的历史（含它的 session_meta）
 * 抄在后面，那不是另一个会话，只是这一个会话的前情。
 */
export function groupRecordsBySession(records: readonly ParsedRecord[]): SessionDraft[] {
  const drafts: SessionDraft[] = []
  let current: SessionDraft | null = null
  let ancestors = new Set<string>()

  for (const record of records) {
    const declared = explicitSessionId(record.value)
    const replayedAncestor = declared !== null && ancestors.has(declared)

    if (
      declared !== null &&
      !replayedAncestor &&
      (current === null || (current.key !== declared && current.records.length > 0))
    ) {
      const meta = readMeta(record.value)
      const agent = readAgentMeta(record.value)
      current = {
        key: declared,
        records: [],
        meta: { ...meta, sessionId: declared, ...(agent === undefined ? {} : { agent }) }
      }
      ancestors = new Set(ancestorIdsOf(record.value))
      drafts.push(current)
    }

    if (current === null) {
      current = { key: 'session-1', records: [], meta: readMeta(record.value) }
      drafts.push(current)
    }

    current.records.push(record)
  }

  // 一个会话至少要有一条结构化记录；只有零散字符串/数字的分组是噪音，不该变成会话。
  return drafts.filter((draft) => draft.records.some((record) => isRecord(record.value)))
}

export const jsonlEventParser: SessionParser = {
  id: 'jsonl-events',
  name: '逐行 JSON 事件日志（.jsonl）',
  score(input) {
    if (!input.records || input.records.length === 0) return 0
    return 90
  },
  locate(input) {
    const records = input.records ?? []
    if (records.length === 0) return []
    return groupRecordsBySession(records)
  }
}

export const jsonSessionObjectParser: SessionParser = {
  id: 'json-session-object',
  name: 'JSON 会话对象（含 messages / events / turns）',
  score(input) {
    if (!isRecord(input.root)) return 0
    if (Array.isArray((input.root as Record<string, unknown>).sessions)) return 88
    return findRecordArray(input.root as Record<string, unknown>) ? 85 : 0
  },
  locate(input) {
    const root = input.root as Record<string, unknown>

    // 形状一：{ sessions: [ {...}, {...} ] }
    const sessions = root.sessions
    if (Array.isArray(sessions)) {
      const drafts: SessionDraft[] = []
      sessions.forEach((session, index) => {
        if (!isRecord(session)) return
        const found = findRecordArray(session)
        const meta = readMeta(session)
        drafts.push({
          key: meta.sessionId ?? `session-${index + 1}`,
          records: found ? toParsedRecords(found.records) : [{ value: session, line: index + 1 }],
          meta
        })
      })
      if (drafts.length > 0) return drafts
    }

    // 形状二：{ session_id, messages: [...] }
    const found = findRecordArray(root)
    if (!found) return []
    const meta = readMeta(root)
    return [
      {
        key: meta.sessionId ?? 'session-1',
        records: toParsedRecords(found.records),
        meta
      }
    ]
  }
}

export const jsonSessionArrayParser: SessionParser = {
  id: 'json-session-array',
  name: 'JSON 会话数组（一个文件多个会话）',
  score(input) {
    if (!Array.isArray(input.root)) return 0
    const sample = input.root.slice(0, 5)
    const containers = sample.filter((entry) => looksLikeSessionContainer(entry)).length
    return containers >= Math.max(1, Math.ceil(sample.length / 2)) ? 80 : 0
  },
  locate(input) {
    const root = input.root as unknown[]
    const drafts: SessionDraft[] = []

    root.forEach((entry, index) => {
      if (!isRecord(entry)) return
      const found = findRecordArray(entry)
      const meta = readMeta(entry)
      drafts.push({
        key: meta.sessionId ?? `session-${index + 1}`,
        records: found ? toParsedRecords(found.records) : [{ value: entry, line: index + 1 }],
        meta
      })
    })

    return drafts
  }
}

export const jsonEventArrayParser: SessionParser = {
  id: 'json-event-array',
  name: 'JSON 事件数组',
  score(input) {
    if (!Array.isArray(input.root)) return 0
    const records = input.root.filter((entry) => isRecord(entry))
    return records.length > 0 ? 55 : 0
  },
  locate(input) {
    const root = input.root as unknown[]
    return groupRecordsBySession(toParsedRecords(root))
  }
}

/**
 * 兜底适配器：在任意深度里找出"最像事件列表"的数组。
 * 用于结构完全陌生的文件 —— 宁可解析出一部分，也不要整份失败。
 */
export const deepSearchParser: SessionParser = {
  id: 'json-deep-search',
  name: '深度探测适配器',
  score(input) {
    if (input.root === undefined) return 0
    return 20
  },
  locate(input) {
    const best = findDeepestRecordArray(input.root)
    if (!best) return []
    const meta = isRecord(input.root) ? readMeta(input.root) : {}
    return [
      {
        key: meta.sessionId ?? 'session-1',
        records: toParsedRecords(best),
        meta
      }
    ]
  }
}

function findDeepestRecordArray(root: unknown): unknown[] | null {
  let best: unknown[] | null = null
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || current.depth > 6) continue
    const { value, depth } = current

    if (Array.isArray(value)) {
      const objects = value.filter((entry) => isRecord(entry))
      if (objects.length > 0 && (best === null || objects.length > best.length)) {
        best = value
      }
      for (const entry of value.slice(0, 50)) queue.push({ value: entry, depth: depth + 1 })
      continue
    }

    if (isRecord(value)) {
      for (const entry of Object.values(value)) queue.push({ value: entry, depth: depth + 1 })
    }
  }

  return best
}

/**
 * 保证同一个文件里的 draft key 互不相同。
 *
 * 会话 id 由「文件路径 + draft key」算出来，一旦两个 draft 用了同一个 key，
 * 后一个会在索引里把前一个覆盖掉 —— 实测一台机器上就有 22 个会话这样丢失。
 * 重复时追加 #2、#3，既能去重，又保持每次扫描结果稳定。
 */
export function dedupeDraftKeys(drafts: readonly SessionDraft[]): SessionDraft[] {
  const used = new Set<string>()

  return drafts.map((draft) => {
    const base = draft.key === '' ? 'session' : draft.key
    if (!used.has(base)) {
      used.add(base)
      return draft.key === base ? draft : { ...draft, key: base }
    }

    let suffix = 2
    while (used.has(`${base}#${suffix}`)) suffix += 1
    const key = `${base}#${suffix}`
    used.add(key)
    return { ...draft, key }
  })
}

export const ALL_PARSERS: readonly SessionParser[] = [
  jsonlEventParser,
  jsonSessionObjectParser,
  jsonSessionArrayParser,
  jsonEventArrayParser,
  deepSearchParser
]

/** 选出得分最高的适配器。全部不适用时返回 null。 */
export function pickParser(input: ParserInput): SessionParser | null {
  let best: SessionParser | null = null
  let bestScore = 0

  for (const parser of ALL_PARSERS) {
    const score = parser.score(input)
    if (score > bestScore) {
      bestScore = score
      best = parser
    }
  }

  return best
}
