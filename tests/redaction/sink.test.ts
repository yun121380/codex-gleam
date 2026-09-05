/**
 * 遥测 sink 的行为契约。
 *
 * 四件事，缺一件这个面板就不能信：
 *   1. 不传 sink 时返回值逐字节相同 —— 打码是正事，审计是搭车的；
 *   2. 六种 rule、五种 KeptReason 都真的报得出来，不是写在类型里就算有；
 *   3. 报告里没有原值，哪怕两条规则在同一处叠着打了两次码；
 *   4. eventId 落到了每条事件上，不属于任何一条事件的那几处是 null。
 */
import { describe, expect, it } from 'vitest'
import { createCollector, type RedactionCollector } from '../../src/main/redaction/report'
import { redactDeep, redactSession, redactText } from '../../src/main/redaction/redact'
import { REDACTION_PLACEHOLDER } from '../../src/shared/constants'
import type {
  CodexSession,
  KeptReason,
  RedactionHit,
  RedactionReport,
  RedactionRuleGroup
} from '../../src/shared/types'
import { fixturePath, loadFixture } from '../support/fixtures'

const MASK = REDACTION_PLACEHOLDER

/**
 * 六种 rule 各来一处。全部是虚构值，但词形与长度都照着真的写 ——
 * 值不足 4 个字符或一眼像占位符的话走的是排除那条路，命中就凑不齐。
 *
 * 第 4 行用 `--api-key=` 而不是设计文档里举的 `--token `：`--token X` 里的
 * `token` 会先被第 3 阶段的 `\b(Bearer|Basic|Token|ApiKey)\s+` 吃掉，报出来的是
 * auth-scheme。值照样打掉了，不是漏打；但想验 cli-flag 就得绕开那四个词。
 */
const SIX_RULES_TEXT = [
  'deploy with sk-live-0OpQrStUvWxYz123456 now',
  'Cookie: sid=abcdefghijklmnopqrst; theme=dark',
  'Authorization: Bearer ZmFrZS1iZWFyZXItdG9rZW4tdmFsdWU',
  'node deploy.js --api-key=fake-cli-key-value',
  'password: my secret phrase'
].join('\n')

/** 第六种（sensitive-key）只在 redactDeep 的记录分支里出现。 */
const SIX_RULES_JSON = { api_key: 'fake-json-api-key-value' }

/** 上面那段文本与 JSON 里出现过的原值，一个都不许进报告。 */
const SIX_RULES_SECRETS: readonly string[] = [
  'sk-live-0OpQrStUvWxYz123456',
  'abcdefghijklmnopqrst',
  'ZmFrZS1iZWFyZXItdG9rZW4tdmFsdWU',
  'fake-cli-key-value',
  'my secret phrase',
  'fake-json-api-key-value'
]

const SIX_RULES: readonly string[] = [
  'known-secret:openai',
  'cookie-line',
  'auth-scheme',
  'cli-flag',
  'key-value',
  'sensitive-key'
]

/** 五种 KeptReason 各来一处。这五行一个字符都不该变。 */
const FIVE_REASONS_TEXT = [
  'author: "some plain text"',
  'input_tokens: 128',
  'password: str = Field(min_length=6)',
  'api_key: <your-key>',
  'token: true'
].join('\n')

const FIVE_REASONS: ReadonlyArray<readonly [string, KeptReason]> = [
  ['author', 'name-not-matched'],
  ['input_tokens', 'metric-name'],
  ['password', 'value-too-short'],
  ['api_key', 'value-is-template'],
  ['token', 'value-not-secret']
]

function collectReport(run: (collector: RedactionCollector) => void): RedactionReport {
  const collector = createCollector()
  run(collector)
  return collector.summarize('sink-test', true)
}

function groupOf(result: RedactionReport, rule: string): RedactionRuleGroup | undefined {
  return result.groups.find((group) => group.rule === rule)
}

function samplesOf(result: RedactionReport): RedactionHit[] {
  return result.groups.flatMap((group) => group.samples)
}

describe('不传 sink 就当没这回事', () => {
  // 46 条老测试全绿只说明「没改坏」，这一组说的是另一半：「加了 sink 也不改结果」。
  it('redactText 的返回值逐字节相同', () => {
    expect(redactText(SIX_RULES_TEXT, createCollector())).toBe(redactText(SIX_RULES_TEXT))
  })

  it('redactDeep 的返回值相同', () => {
    expect(redactDeep(SIX_RULES_JSON, '', 0, createCollector())).toEqual(
      redactDeep(SIX_RULES_JSON)
    )
  })

  it('整个会话打码的结果相同', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const session = sessions[0] as CodexSession
    expect(redactSession(session, createCollector())).toEqual(redactSession(session))
  })
})

describe('六种 rule 各命中一次', () => {
  const result = collectReport((collector) => {
    redactText(SIX_RULES_TEXT, collector)
    redactDeep(SIX_RULES_JSON, '', 0, collector)
  })

  it('六条规则都在报告里，各一次', () => {
    for (const rule of SIX_RULES) {
      expect(groupOf(result, rule)?.count, rule).toBe(1)
    }
    expect(result.groups).toHaveLength(SIX_RULES.length)
    // totalHits 是所有 count 之和，正好等于规则数只是因为这里每条各命中一次。
    expect(result.totalHits).toBe(SIX_RULES.length)
  })

  it('每条上下文都带着占位符', () => {
    const samples = samplesOf(result)
    expect(samples).toHaveLength(SIX_RULES.length)
    for (const sample of samples) {
      expect(sample.maskedContext, sample.rule).toContain(MASK)
    }
  })

  it('原值一个都没进报告', () => {
    const serialized = JSON.stringify(result)
    for (const secret of SIX_RULES_SECRETS) {
      expect(serialized, secret).not.toContain(secret)
    }
  })

  it('被打过码的地方不算「排除」', () => {
    // 第 5 阶段会在 `Cookie: [已打码]` 这类终稿上再匹配一次。报成 value-not-secret
    // 就是把「刚刚打过码」说成「判过、不是密钥」—— 那是把事实说反。
    expect(result.kept).toEqual([])
  })
})

describe('五种 KeptReason 各出现一次', () => {
  const result = collectReport((collector) => {
    redactText(FIVE_REASONS_TEXT, collector)
  })

  it('五种原因齐全，键名对得上', () => {
    for (const [keyName, reason] of FIVE_REASONS) {
      const entry = result.kept.find((item) => item.keyName === keyName && item.reason === reason)
      expect(entry?.count, `${keyName} → ${reason}`).toBe(1)
    }
  })

  it('这五行一处都没被打码', () => {
    // 排除原因说得出口的前提是「确实没打」，否则面板是在解释一件没发生的事。
    expect(redactText(FIVE_REASONS_TEXT)).toBe(FIVE_REASONS_TEXT)
    expect(result.totalHits).toBe(0)
  })

  it('没有第六条 —— 跟敏感词无关的键名不进报告', () => {
    // 同一份文本里还有 `min_length=6`，它既不敏感也不沾敏感词，报出来只会灌满面板。
    expect(result.kept).toHaveLength(FIVE_REASONS.length)
    expect(result.keptTruncated).toBe(false)
  })
})

describe('两条规则叠在同一处', () => {
  // 第 1 阶段把 sk- 密钥打成占位符，第 2 阶段再把整行连占位符一起吞掉。
  const COOKIE_LINE = 'Cookie: sid=sk-live-0OpQrStUvWxYz123456'
  const result = collectReport((collector) => {
    redactText(COOKIE_LINE, collector)
  })

  it('两条命中都在，各报一次', () => {
    expect(groupOf(result, 'known-secret:openai')?.count).toBe(1)
    expect(groupOf(result, 'cookie-line')?.count).toBe(1)
    expect(result.totalHits).toBe(2)
  })

  it('终稿里只剩一个占位符，两条上下文都不含密钥本体', () => {
    expect(redactText(COOKIE_LINE)).toBe(`Cookie: ${MASK}`)
    const samples = samplesOf(result)
    expect(samples).toHaveLength(2)
    for (const sample of samples) {
      expect(sample.maskedContext, sample.rule).toContain(MASK)
      expect(sample.maskedContext, sample.rule).not.toContain('sk-live')
      expect(sample.maskedContext, sample.rule).not.toContain('sid=')
    }
  })
})

describe('eventId 落到每条事件上', () => {
  it('样例的 eventId 要么指得到一条真事件，要么是 null', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const base = sessions[0] as CodexSession
    // 会话标题不属于任何一条事件。给它塞一处命中，「eventId 是 null」才有东西可断言。
    const session: CodexSession = { ...base, title: '登录口令是 password: my secret phrase' }

    const collector = createCollector()
    redactSession(session, collector)
    const result = collector.summarize(session.id, true)
    const samples = samplesOf(result)

    expect(result.sessionId).toBe(session.id)
    expect(samples.length).toBeGreaterThan(0)

    const ids = new Set(session.events.map((event) => event.id))
    for (const sample of samples) {
      if (sample.eventId === null) continue
      expect(ids.has(sample.eventId), sample.eventId).toBe(true)
    }

    // 事件上的命中确实带着 id，不是整份报告都退化成 null。
    expect(samples.some((sample) => sample.eventId !== null)).toBe(true)

    const rootHits = samples.filter((sample) => sample.eventId === null)
    expect(rootHits.some((hit) => hit.rule === 'key-value' && hit.keyName === 'password')).toBe(true)
  })
})
