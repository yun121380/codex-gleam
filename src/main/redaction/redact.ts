import {
  DEPTH_LIMIT_PLACEHOLDER,
  REDACTION_CONTEXT_LENGTH,
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
  keyKeptReason,
  KNOWN_SECRET_PATTERNS,
  shouldMaskValue,
  valueKeptReason
} from './patterns'
import { scopedTo, type RedactionSink } from './report'
import { lookBehind, scoreResidual, tokenize } from './residual'

/**
 * 打码。原则是"宁可多打一点，也不要漏掉密钥"，但同时避免把
 * `input_tokens: 128` 之类的统计数字也糊掉（见 patterns.ts 的排除规则）。
 *
 * 这里只处理展示层数据，原始文件永远不会被修改。
 *
 * 每个函数都多收一个可选的 `sink`（见 report.ts）。不传时这些函数一行逻辑都不多走，
 * 返回值逐字节相同 —— 打码是正事，审计是搭车的。
 */

function maskGroup(match: string, group: string): string {
  const index = match.lastIndexOf(group)
  if (index < 0) return REDACTION_PLACEHOLDER
  return `${match.slice(0, index)}${REDACTION_PLACEHOLDER}${match.slice(index + group.length)}`
}

/**
 * 一处还没定位的命中。
 *
 * `maskedMatch` 是那个 replacer **自己返回的字符串**，所以它按定义就是打过码的 ——
 * 这是「报告绝不携带原值」这条约束在这一层的落地方式。
 */
interface PendingHit {
  rule: string
  keyName: string | null
  maskedMatch: string
}

/**
 * 从终稿里切一段上下文出来。
 *
 * 五个阶段打出来的 `maskedMatch` 一律是「前缀 + 占位符」，所以窗口装不下整段时
 * 保尾不保头 —— 否则切出来的上下文里一个占位符都看不见，读起来像是这处没打码。
 */
function cutWindow(text: string, index: number, length: number): string {
  if (length >= REDACTION_CONTEXT_LENGTH) {
    return text.slice(index + length - REDACTION_CONTEXT_LENGTH, index + length)
  }
  const pad = Math.floor((REDACTION_CONTEXT_LENGTH - length) / 2)
  const start = Math.max(0, index - pad)
  return text.slice(start, start + REDACTION_CONTEXT_LENGTH)
}

/**
 * 把攒下来的命中翻译成带上下文的 `RedactionHit`。
 *
 * 为什么要等到终稿：第 3 个阶段手上那份文本里，第 4、5 阶段该打的码还没打。就地切
 * 一段 120 字符的窗口，很可能把隔壁一个还没轮到的密钥原样切进报告里 —— 那正是这个
 * 面板最不能犯的错。所以五个阶段只攒 `PendingHit`，切窗口一律在终稿上做。
 *
 * 定位是「够用」而不是「精确」：游标从左往右推，保证多条命中不会都指向同一处；
 * 找不到就从头再找一次（后面的阶段可能把这段又改了一次 —— `Cookie:` 整行规则会把
 * 第 1 阶段刚打好的占位符一起吞掉）；再找不到就退化成只报 `maskedMatch` 自己。
 *
 * 偶尔偏一处的后果是「上下文是另一处命中的邻居」，**而不是泄露** —— 终稿处处都是
 * 打过码的，所以这里的安全性不依赖定位准不准。
 */
function emitHits(text: string, pending: readonly PendingHit[], sink: RedactionSink): void {
  let cursor = 0
  for (const item of pending) {
    let index = text.indexOf(item.maskedMatch, cursor)
    if (index < 0) index = text.indexOf(item.maskedMatch)
    const maskedContext =
      index < 0
        ? item.maskedMatch.slice(0, REDACTION_CONTEXT_LENGTH)
        : cutWindow(text, index, item.maskedMatch.length)
    if (index >= 0) cursor = index + item.maskedMatch.length
    sink.hit({ rule: item.rule, keyName: item.keyName, eventId: null, maskedContext })
  }
}

/** 键名敏感、整个值被换掉的那几处没有「周围的文本」可切，只能合成一段。 */
function synthesizeContext(keyName: string): string {
  return `${keyName}: ${REDACTION_PLACEHOLDER}`
}

/**
 * 扫一遍终稿，把「五个阶段都没碰过、但看起来像密钥」的片段报上去。
 *
 * 位置只能是这里 —— `text` 已经是终稿的地方。往前挪一个阶段，后面阶段该打的码还没打，
 * 被正确打掉的密钥就会以「可疑残留」的身份报出来，面板于是在这个工具**工作得最好**的
 * 地方给出最错的话。这条约束有个现成的看门人：`tests/redaction/reportSecrets.test.ts`
 * 把整份报告序列化之后搜那六个假密钥的本体，而 `residuals` 一进报告就落进它的搜索范围。
 * 它保持绿色恰恰是因为残留来自打过码的文本。
 *
 * **没有阈值**：分数只用来排序，报上来的一条都不丢（见 residual.ts 的模块注释）。
 * 也**没有**「跳过占位符」这个判断 —— `[已打码]` 里的方括号和中文都不在分词表内，
 * 它压根不会成词。写一个永假的 `if` 只会让下一个人以为它在防什么。
 */
function emitResiduals(text: string, sink: RedactionSink): void {
  for (const token of tokenize(text)) {
    const { score, shape } = scoreResidual(token.text, lookBehind(text, token.at))
    sink.residual({ text: token.text, length: token.text.length, score, shape })
  }
}

export function redactText(input: string, sink?: RedactionSink): string {
  if (typeof input !== 'string' || input === '') return input
  let text = input
  /** 五个阶段只往这里攒，切上下文等终稿。不传 sink 时它始终是空的。 */
  const pending: PendingHit[] = []

  // 1. 已知格式的密钥（不依赖键名）。
  for (const { name, pattern, group } of KNOWN_SECRET_PATTERNS) {
    pattern.lastIndex = 0
    text = text.replace(pattern, (match, ...groups) => {
      if (group === 0) {
        // 这一阶段不看键名 —— 那正是它存在的理由，所以 keyName 是 null。
        if (sink !== undefined) {
          pending.push({
            rule: `known-secret:${name}`,
            keyName: null,
            maskedMatch: REDACTION_PLACEHOLDER
          })
        }
        return REDACTION_PLACEHOLDER
      }
      const captured = groups[group - 1]
      // 捕获组是空的，这次匹配等于什么都没匹到 —— 既不是命中也不是「判为不是密钥」。
      if (typeof captured !== 'string' || captured === '') return match
      const masked = maskGroup(match, captured)
      if (sink !== undefined) {
        pending.push({ rule: `known-secret:${name}`, keyName: null, maskedMatch: masked })
      }
      return masked
    })
  }

  // 2. Cookie 整行。
  COOKIE_LINE_PATTERN.lastIndex = 0
  text = text.replace(COOKIE_LINE_PATTERN, (_match, label: string, separator: string) => {
    const masked = `${label}${separator}${REDACTION_PLACEHOLDER}`
    if (sink !== undefined) {
      pending.push({ rule: 'cookie-line', keyName: label, maskedMatch: masked })
    }
    return masked
  })

  // 3. Bearer / Basic 之类的凭据。
  AUTH_SCHEME_PATTERN.lastIndex = 0
  text = text.replace(AUTH_SCHEME_PATTERN, (match, scheme: string, credential: string) => {
    if (!shouldMaskValue(credential)) {
      // 这一阶段没有键名可报，`scheme` 是用户在原文里看到的那个词，拿它当抬头。
      if (sink !== undefined) {
        const reason = valueKeptReason(credential)
        if (reason !== null) sink.kept(scheme, reason)
      }
      return match
    }
    const masked = `${scheme} ${REDACTION_PLACEHOLDER}`
    if (sink !== undefined) {
      pending.push({ rule: 'auth-scheme', keyName: null, maskedMatch: masked })
    }
    return masked
  })

  // 4. 命令行参数。
  CLI_FLAG_PATTERN.lastIndex = 0
  text = text.replace(CLI_FLAG_PATTERN, (match, flag: string, quote: string, value: string) => {
    // flag 这一组连着分隔符（`--token ` / `--api-key=`），报出去要去掉尾巴。
    const flagName = flag.replace(/[=\s]+$/, '')
    if (!shouldMaskValue(value)) {
      if (sink !== undefined) {
        const reason = valueKeptReason(value)
        if (reason !== null) sink.kept(flagName, reason)
      }
      return match
    }
    const masked = `${flag}${quote}${REDACTION_PLACEHOLDER}${quote}`
    if (sink !== undefined) {
      pending.push({ rule: 'cli-flag', keyName: flagName, maskedMatch: masked })
    }
    return masked
  })

  // 5. 通用的 键: 值 / 键=值。
  KEY_VALUE_PATTERN.lastIndex = 0
  text = text.replace(
    KEY_VALUE_PATTERN,
    (match, quote: string, key: string, separator: string, valueQuote: string, value: string) => {
      if (!isSensitiveKey(key)) {
        if (sink !== undefined) {
          // null 的意思是「这不值得解释」（`id`、`timestamp` 之类），不是「没有原因」。
          const reason = keyKeptReason(key)
          if (reason !== null) sink.kept(key, reason)
        }
        return match
      }
      if (!shouldMaskValue(value)) {
        if (sink !== undefined) {
          const reason = valueKeptReason(value)
          if (reason !== null) sink.kept(key, reason)
        }
        return match
      }
      const masked = `${quote}${key}${quote}${separator}${valueQuote}${REDACTION_PLACEHOLDER}${valueQuote}`
      if (sink !== undefined) {
        pending.push({ rule: 'key-value', keyName: key, maskedMatch: masked })
      }
      return masked
    }
  )

  if (sink !== undefined && pending.length > 0) emitHits(text, pending, sink)
  // 同一道门：不传 sink 时这两行一行都不跑，`text` 从头到尾没被多读一次。
  if (sink !== undefined) emitResiduals(text, sink)

  return text
}

function redactStringValue(value: string, keyHint: string, sink?: RedactionSink): string {
  if (keyHint !== '' && isSensitiveKey(keyHint) && shouldMaskValue(value)) {
    sink?.hit({
      rule: 'sensitive-key',
      keyName: keyHint,
      eventId: null,
      maskedContext: synthesizeContext(keyHint)
    })
    return REDACTION_PLACEHOLDER
  }
  const masked = redactText(value, sink)
  // 先看结果再决定报不报。这条 bail-out 会往下走 redactText，值可能在那里被别的规则
  // 打掉（`{"author": "sk-live-…"}` 就是这样）—— 那时报「author 被判为不是密钥」是把
  // 事实说反。所以只有结果和原值**逐字节相同**才轮得到「为什么没打」。
  if (sink !== undefined && keyHint !== '' && masked === value) {
    // 键名本身敏感时，拦住这个值的是值那一侧的判断，报键名的原因会指向一条没跑到的规则。
    const reason = isSensitiveKey(keyHint) ? valueKeptReason(value) : keyKeptReason(keyHint)
    if (reason !== null) sink.kept(keyHint, reason)
  }
  return masked
}

/**
 * 深度打码任意 JSON 结构（用于"原始数据"面板与 JSON 导出）。
 *
 * 深度上限只是防栈溢出的保险，**绝不能因此把没处理过的内容放出去** ——
 * 密钥藏在第 20 层和藏在第 2 层一样是密钥。所以到了上限：
 * 字符串照常打码，数字与布尔原样返回（它们藏不住密钥），
 * 只有对象和数组换成"未展开"占位符。
 */
export function redactDeep(
  value: unknown,
  keyHint = '',
  depth = 0,
  sink?: RedactionSink
): unknown {
  if (typeof value === 'string') return redactStringValue(value, keyHint, sink)

  // 数字、布尔、null、undefined 里不可能藏密钥，任何深度都可以原样返回。
  if (value === null || typeof value !== 'object') return value

  // 到了上限，对象与数组换成"未展开"占位符。
  //
  // 这里**什么都不报**：既不是命中也不是排除，是「没往下看」。硬要报的话得再加一个
  // KeptReason，而它会在面板上和真正的排除混在一起，读起来像是「这里判过了」——它没判过。
  if (depth > REDACTION_MAX_DEPTH) return DEPTH_LIMIT_PLACEHOLDER

  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, keyHint, depth + 1, sink))
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        if (typeof entry === 'string') {
          if (shouldMaskValue(entry)) {
            result[key] = REDACTION_PLACEHOLDER
            sink?.hit({
              rule: 'sensitive-key',
              keyName: key,
              eventId: null,
              maskedContext: synthesizeContext(key)
            })
            continue
          }
          result[key] = entry
          if (sink !== undefined) {
            const reason = valueKeptReason(entry)
            if (reason !== null) sink.kept(key, reason)
          }
          continue
        }
        if (entry !== null && typeof entry === 'object') {
          result[key] = REDACTION_PLACEHOLDER
          sink?.hit({
            rule: 'sensitive-key',
            keyName: key,
            eventId: null,
            maskedContext: synthesizeContext(key)
          })
          continue
        }
        // 数字 / 布尔值保持原样：它们是计数或开关，不是密钥。
        result[key] = entry
        sink?.kept(key, 'value-not-secret')
        continue
      }
      result[key] = redactDeep(entry, key, depth + 1, sink)
    }
    return result
  }

  return value
}

export function redactEvent(event: CodexEvent, sink?: RedactionSink): CodexEvent {
  const redacted: CodexEvent = {
    ...event,
    title: redactText(event.title, sink),
    content: redactText(event.content, sink),
    raw: redactDeep(event.raw, '', 0, sink)
  }

  if (event.command !== undefined) redacted.command = redactText(event.command, sink)
  if (event.fileChanges) {
    redacted.fileChanges = event.fileChanges.map((change) => {
      const next = { ...change }
      if (change.diff !== undefined) next.diff = redactText(change.diff, sink)
      if (change.before !== undefined) next.before = redactText(change.before, sink)
      if (change.after !== undefined) next.after = redactText(change.after, sink)
      return next
    })
  }
  if (event.test) {
    redacted.test = {
      ...event.test,
      failures: event.test.failures.map((failure) => ({
        name: redactText(failure.name, sink),
        ...(failure.message === undefined ? {} : { message: redactText(failure.message, sink) })
      }))
    }
  }

  return redacted
}

export function redactSummary<T extends SessionSummary>(summary: T, sink?: RedactionSink): T {
  return {
    ...summary,
    title: redactText(summary.title, sink),
    warnings: summary.warnings.map((warning) => ({
      ...warning,
      reason: redactText(warning.reason, sink)
    }))
  }
}

/**
 * 会话级打码。
 *
 * 每条事件都套一层 `scopedTo`，好让命中与残留都说得出「这处在哪条事件上」；
 * 会话标题与警告不属于任何一条事件，它们的 `eventId` 就是 `null` —— 摘要那一路
 * 走的也是 `redactText`，所以残留会自动被收进来，不需要为它多写一条分支。
 */
export function redactSession(session: CodexSession, sink?: RedactionSink): CodexSession {
  return {
    ...redactSummary(session, sink),
    events: session.events.map((event) =>
      redactEvent(event, sink === undefined ? undefined : scopedTo(sink, event.id))
    )
  }
}

/** 按开关决定是否打码，方便设置项与导出选项复用。 */
export function maybeRedactSession(session: CodexSession, enabled: boolean): CodexSession {
  return enabled ? redactSession(session) : session
}

export function maybeRedactSummary<T extends SessionSummary>(summary: T, enabled: boolean): T {
  return enabled ? redactSummary(summary) : summary
}
