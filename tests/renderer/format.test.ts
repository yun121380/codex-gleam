import { describe, expect, it } from 'vitest'
import {
  formatCost,
  formatListTime,
  formatRelativeTime,
  formatTokens
} from '../../src/renderer/lib/format'

/**
 * 会话列表的时间列。
 *
 * 并行子代理会在同一分钟里跑出十几个会话，标题还都一样（收到的是同一段任务），
 * 只显示"13 天前"就分不清谁是谁 —— 所以隔了一天以上要给出确切时刻。
 *
 * 下面那些 `08-16 20:50` 是本地时区下的结果。时区由 `vitest.config.ts` 里的
 * `env.TZ` 钉在 Asia/Shanghai，别把它去掉：CI 的 runner 是 UTC，
 * 一去掉这三条断言就会差 8 小时。
 */
const NOW = Date.parse('2026-08-30T14:00:00+08:00')

describe('列表里的时间', () => {
  it('一天之内还是说"几小时前"，对新会话更直观', () => {
    expect(formatListTime('2026-08-30T11:00:00+08:00', NOW)).toBe('3 小时前')
    expect(formatListTime('2026-08-30T13:30:00+08:00', NOW)).toBe('30 分钟前')
  })

  it('超过一天就换成确切的日期时刻', () => {
    expect(formatListTime('2026-08-16T20:50:00+08:00', NOW)).toBe('08-16 20:50')
    expect(formatListTime('2026-08-17T08:01:00+08:00', NOW)).toBe('08-17 08:01')
  })

  it('同一天里相隔几分钟的并行会话也分得开', () => {
    const a = formatListTime('2026-08-09T07:00:00+08:00', NOW)
    const b = formatListTime('2026-08-09T07:19:00+08:00', NOW)

    expect(a).toBe('08-09 07:00')
    expect(b).toBe('08-09 07:19')
    expect(a).not.toBe(b)
  })

  it('跨年的才带上年份', () => {
    expect(formatListTime('2025-12-31T22:10:00+08:00', NOW)).toBe('2025-12-31 22:10')
  })

  it('没有时间戳时不显示乱七八糟的东西', () => {
    expect(formatListTime(null, NOW)).toBe('时间未知')
    expect(formatListTime('不是时间', NOW)).toBe('时间未知')
  })

  it('相对时间本身的口径不变', () => {
    expect(formatRelativeTime('2026-08-30T13:59:30+08:00', NOW)).toBe('刚刚')
    expect(formatRelativeTime('2026-08-29T14:00:00+08:00', NOW)).toBe('昨天')
    expect(formatRelativeTime('2026-08-17T14:00:00+08:00', NOW)).toBe('13 天前')
  })
})

/** 徽标上的 token 数。宽度有限，一万以上必须缩写，否则整行会被顶开。 */
describe('token 数的写法', () => {
  it('一万以内写全，带千分位', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(640)).toBe('640')
    expect(formatTokens(9760)).toBe('9,760')
  })

  it('一万以上缩成 k', () => {
    expect(formatTokens(10_000)).toBe('10.0k')
    expect(formatTokens(19_602)).toBe('19.6k')
  })

  it('百万以上缩成 M', () => {
    expect(formatTokens(1_234_567)).toBe('1.23M')
  })

  it('负数和非数字都当 0，不把 NaN 写到界面上', () => {
    expect(formatTokens(-1)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0')
  })
})

/**
 * 金额。
 *
 * 这里最要紧的一条是"没填单价"与"单价填了 0"必须分开：前者返回 null，
 * 界面上一个金额都不显示；后者是免费额度内的真实单价，得老实显示 0。
 */
describe('金额的写法', () => {
  const usage = { inputTokens: 9120, outputTokens: 640 }

  it('两个单价都没填就不算金额', () => {
    expect(formatCost(usage, null, null, '$')).toBeNull()
  })

  it('填了就按每百万 token 算', () => {
    expect(formatCost(usage, 3, 15, '$')).toBe('$0.04')
  })

  it('单价填 0 显示 0，而不是当成没填', () => {
    expect(formatCost(usage, 0, 0, '$')).toBe('$0.00')
  })

  it('只填了一半时另一半按 0 计', () => {
    expect(formatCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, null, 10, '¥')).toBe(
      '¥10.00'
    )
  })

  it('不到一分钱时多给两位，免得一屏全是 0.00', () => {
    expect(formatCost({ inputTokens: 1000, outputTokens: 0 }, 3, null, '$')).toBe('$0.0030')
  })

  it('没填货币符号就只给数字', () => {
    expect(formatCost(usage, 3, 15, '')).toBe('0.04')
  })
})
