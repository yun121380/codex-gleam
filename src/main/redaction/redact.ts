import {
  DEPTH_LIMIT_PLACEHOLDER,
  REDACTION_MAX_DEPTH,
  REDACTION_PLACEHOLDER
} from '@shared/constants'
import type { CodexEvent, CodexSession, SessionSummary } from '@shared/types'
import { isRecord } from '@shared/validators'
import {
  AUTH_SCHEME_PATTERN,
  CLI_FLAG_PATTERN,
  COOKIE_LINE_PATTERN,
  isSensitiveKey,
  KEY_VALUE_PATTERN,
  KNOWN_SECRET_PATTERNS,
  shouldMaskValue
} from './patterns'

/**
 * 打码。原则是"宁可多打一点，也不要漏掉密钥"，但同时避免把
 * `input_tokens: 128` 之类的统计数字也糊掉（见 patterns.ts 的排除规则）。
 *
 * 这里只处理展示层数据，原始文件永远不会被修改。
 */

function maskGroup(match: string, group: string): string {
  const index = match.lastIndexOf(group)
  if (index < 0) return REDACTION_PLACEHOLDER
  return `${match.slice(0, index)}${REDACTION_PLACEHOLDER}${match.slice(index + group.length)}`
}

export function redactText(input: string): string {
  if (typeof input !== 'string' || input === '') return input
  let text = input

  // 1. 已知格式的密钥（不依赖键名）。
  for (const { pattern, group } of KNOWN_SECRET_PATTERNS) {
    pattern.lastIndex = 0
    text = text.replace(pattern, (match, ...groups) => {
      if (group === 0) return REDACTION_PLACEHOLDER
      const captured = groups[group - 1]
      if (typeof captured !== 'string' || captured === '') return match
      return maskGroup(match, captured)
    })
  }

  // 2. Cookie 整行。
  COOKIE_LINE_PATTERN.lastIndex = 0
  text = text.replace(COOKIE_LINE_PATTERN, (_match, label: string, separator: string) => {
    return `${label}${separator}${REDACTION_PLACEHOLDER}`
  })

  // 3. Bearer / Basic 之类的凭据。
  AUTH_SCHEME_PATTERN.lastIndex = 0
  text = text.replace(AUTH_SCHEME_PATTERN, (match, scheme: string, credential: string) => {
    if (!shouldMaskValue(credential)) return match
    return `${scheme} ${REDACTION_PLACEHOLDER}`
  })

  // 4. 命令行参数。
  CLI_FLAG_PATTERN.lastIndex = 0
  text = text.replace(CLI_FLAG_PATTERN, (match, flag: string, quote: string, value: string) => {
    if (!shouldMaskValue(value)) return match
    return `${flag}${quote}${REDACTION_PLACEHOLDER}${quote}`
  })

  // 5. 通用的 键: 值 / 键=值。
  KEY_VALUE_PATTERN.lastIndex = 0
  text = text.replace(
    KEY_VALUE_PATTERN,
    (match, quote: string, key: string, separator: string, valueQuote: string, value: string) => {
      if (!isSensitiveKey(key)) return match
      if (!shouldMaskValue(value)) return match
      return `${quote}${key}${quote}${separator}${valueQuote}${REDACTION_PLACEHOLDER}${valueQuote}`
    }
  )

  return text
}

function redactStringValue(value: string, keyHint: string): string {
  if (keyHint !== '' && isSensitiveKey(keyHint) && shouldMaskValue(value)) {
    return REDACTION_PLACEHOLDER
  }
  return redactText(value)
}

/**
 * 深度打码任意 JSON 结构（用于"原始数据"面板与 JSON 导出）。
 *
 * 深度上限只是防栈溢出的保险，**绝不能因此把没处理过的内容放出去** ——
 * 密钥藏在第 20 层和藏在第 2 层一样是密钥。所以到了上限：
 * 字符串照常打码，数字与布尔原样返回（它们藏不住密钥），
 * 只有对象和数组换成"未展开"占位符。
 */
export function redactDeep(value: unknown, keyHint = '', depth = 0): unknown {
  if (typeof value === 'string') return redactStringValue(value, keyHint)

  // 数字、布尔、null、undefined 里不可能藏密钥，任何深度都可以原样返回。
  if (value === null || typeof value !== 'object') return value

  if (depth > REDACTION_MAX_DEPTH) return DEPTH_LIMIT_PLACEHOLDER

  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, keyHint, depth + 1))
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        if (typeof entry === 'string') {
          result[key] = shouldMaskValue(entry) ? REDACTION_PLACEHOLDER : entry
          continue
        }
        if (entry !== null && typeof entry === 'object') {
          result[key] = REDACTION_PLACEHOLDER
          continue
        }
        // 数字 / 布尔值保持原样：它们是计数或开关，不是密钥。
        result[key] = entry
        continue
      }
      result[key] = redactDeep(entry, key, depth + 1)
    }
    return result
  }

  return value
}

export function redactEvent(event: CodexEvent): CodexEvent {
  const redacted: CodexEvent = {
    ...event,
    title: redactText(event.title),
    content: redactText(event.content),
    raw: redactDeep(event.raw)
  }

  if (event.command !== undefined) redacted.command = redactText(event.command)
  if (event.fileChanges) {
    redacted.fileChanges = event.fileChanges.map((change) => {
      const next = { ...change }
      if (change.diff !== undefined) next.diff = redactText(change.diff)
      if (change.before !== undefined) next.before = redactText(change.before)
      if (change.after !== undefined) next.after = redactText(change.after)
      return next
    })
  }
  if (event.test) {
    redacted.test = {
      ...event.test,
      failures: event.test.failures.map((failure) => ({
        name: redactText(failure.name),
        ...(failure.message === undefined ? {} : { message: redactText(failure.message) })
      }))
    }
  }

  return redacted
}

export function redactSummary<T extends SessionSummary>(summary: T): T {
  return {
    ...summary,
    title: redactText(summary.title),
    warnings: summary.warnings.map((warning) => ({
      ...warning,
      reason: redactText(warning.reason)
    }))
  }
}

export function redactSession(session: CodexSession): CodexSession {
  return {
    ...redactSummary(session),
    events: session.events.map((event) => redactEvent(event))
  }
}

/** 按开关决定是否打码，方便设置项与导出选项复用。 */
export function maybeRedactSession(session: CodexSession, enabled: boolean): CodexSession {
  return enabled ? redactSession(session) : session
}

export function maybeRedactSummary<T extends SessionSummary>(summary: T, enabled: boolean): T {
  return enabled ? redactSummary(summary) : summary
}
