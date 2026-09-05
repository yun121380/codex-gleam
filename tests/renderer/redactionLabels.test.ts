import { describe, expect, it } from 'vitest'
import { keptReasonLabel, ruleHint, ruleLabel } from '../../src/renderer/lib/redactionLabels'
import { KNOWN_SECRET_PATTERNS } from '../../src/main/redaction/patterns'
import type { KeptReason } from '../../src/shared/types'

/**
 * 面板上那些说法。
 *
 * 这个文件盯的不是"函数返回了字符串"，而是**兜底会不会把缺文案这件事藏起来**：
 * 一条新规则加进 `KNOWN_SECRET_PATTERNS`、或者一条新 `KeptReason` 加进类型，
 * 界面上必须看得出来它没配说明，而不是显示一句「未知规则」了事。
 */

/** 六种 rule。`known-secret:` 那一族在这里用 openai 代表。 */
const SIX_RULES: readonly string[] = [
  'known-secret:openai',
  'cookie-line',
  'auth-scheme',
  'cli-flag',
  'key-value',
  'sensitive-key'
]

const FIVE_REASONS: readonly KeptReason[] = [
  'metric-name',
  'name-not-matched',
  'value-too-short',
  'value-is-template',
  'value-not-secret'
]

describe('六种规则都有说法，而且互不相同', () => {
  it('名字非空且不重复', () => {
    const labels = SIX_RULES.map(ruleLabel)
    for (const [at, label] of labels.entries()) {
      expect(label.trim(), SIX_RULES[at]).not.toBe('')
    }
    // 两条规则共用一个名字，等于面板上有一段永远说不清自己是谁。
    expect(new Set(labels).size).toBe(SIX_RULES.length)
  })

  it('解释非空且不重复', () => {
    const hints = SIX_RULES.map(ruleHint)
    for (const [at, hint] of hints.entries()) {
      expect(hint.trim(), SIX_RULES[at]).not.toBe('')
    }
    expect(new Set(hints).size).toBe(SIX_RULES.length)
  })

  it('规则名本身不出现在给用户看的说法里', () => {
    // 「cookie-line」这种连字符英文是代码里的标识符，不是中文界面上的话。
    for (const rule of SIX_RULES) {
      if (rule.startsWith('known-secret:')) continue
      expect(ruleLabel(rule), rule).not.toContain(rule)
    }
  })
})

describe('known-secret 那一族是拼出来的', () => {
  it('模式名原样跟在后面', () => {
    expect(ruleLabel('known-secret:openai')).toBe('已知格式的密钥 · openai')
    expect(ruleLabel('known-secret:aws-access-key')).toBe('已知格式的密钥 · aws-access-key')
  })

  it('认不出的模式名也把名字说出来，而不是回一句「未知规则」', () => {
    // 这是这个文件最要紧的一条。将来有人往 KNOWN_SECRET_PATTERNS 里加一条却忘了
    // 配文案，面板上得出现那条规则的名字 —— 一句「未知规则」会把这件事彻底盖住。
    const label = ruleLabel('known-secret:stripe-live')
    expect(label).toContain('stripe-live')
    expect(label).not.toContain('未知')

    const hint = ruleHint('known-secret:stripe-live')
    expect(hint).toContain('stripe-live')
  })

  it('patterns.ts 里现有的每一条都配了自己的解释', () => {
    // 直接读源头那张表：加了一条而没配解释，这里就红。
    // 先确认这张表真的有东西 —— 空数组会让下面那个循环空转，绿得没意义。
    expect(KNOWN_SECRET_PATTERNS.length).toBeGreaterThan(5)
    for (const { name } of KNOWN_SECRET_PATTERNS) {
      expect(ruleHint(`known-secret:${name}`), name).not.toContain('还没有给它配说明')
    }
  })
})

describe('五种排除理由', () => {
  it('每一条都是一句人话，互不相同', () => {
    const labels = FIVE_REASONS.map(keptReasonLabel)
    for (const [at, label] of labels.entries()) {
      expect(label.trim(), FIVE_REASONS[at]).not.toBe('')
      // 说的必须是**为什么**，不是规则名 —— 用户不该去猜 name-not-matched 是什么意思。
      expect(label, FIVE_REASONS[at]).not.toContain(FIVE_REASONS[at]!)
    }
    expect(new Set(labels).size).toBe(FIVE_REASONS.length)
  })
})
