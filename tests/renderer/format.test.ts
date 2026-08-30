import { describe, expect, it } from 'vitest'
import { formatListTime, formatRelativeTime } from '../../src/renderer/lib/format'

/**
 * 会话列表的时间列。
 *
 * 并行子代理会在同一分钟里跑出十几个会话，标题还都一样（收到的是同一段任务），
 * 只显示"13 天前"就分不清谁是谁 —— 所以隔了一天以上要给出确切时刻。
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
