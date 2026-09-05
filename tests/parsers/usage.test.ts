import { describe, expect, it } from 'vitest'

import { UsageCollector } from '../../src/main/parsers/usage'
import type { UsageSummary } from '../../src/shared/types'

/** 造一条 Codex 的 token_count 记录（已剥壳，采集器看到的就是这个形状）。 */
function tokenCount(input: number, output: number, total?: number): unknown {
  return {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total ?? input + output
      }
    }
  }
}

function collect(records: unknown[]): UsageSummary | null {
  const collector = new UsageCollector()
  for (const record of records) collector.note(record)
  return collector.summary()
}

describe('UsageCollector', () => {
  it('没有任何用量记录时返回 null，而不是一堆 0', () => {
    expect(collect([{ type: 'message', role: 'user', content: '你好' }])).toBeNull()
  })

  it('单调不减的序列判为累计值，取最后一条', () => {
    const usage = collect([
      tokenCount(4210, 180, 4390),
      tokenCount(4890, 210, 5100),
      tokenCount(9120, 640, 9760)
    ])

    expect(usage?.basis).toBe('cumulative')
    expect(usage?.totalTokens).toBe(9760)
    expect(usage?.inputTokens).toBe(9120)
    expect(usage?.outputTokens).toBe(640)
  })

  it('出现下降的序列判为增量值，求和', () => {
    const usage = collect([tokenCount(100, 10, 110), tokenCount(50, 5, 55), tokenCount(20, 2, 22)])

    expect(usage?.basis).toBe('delta')
    expect(usage?.totalTokens).toBe(110 + 55 + 22)
    expect(usage?.inputTokens).toBe(170)
    expect(usage?.outputTokens).toBe(17)
  })

  it('只有一条记录时按累计处理，两种规则算出来是同一个数', () => {
    const usage = collect([tokenCount(18422, 1180, 19602)])

    expect(usage?.basis).toBe('cumulative')
    expect(usage?.totalTokens).toBe(19602)
  })

  it('中途归零（上下文压缩）判为增量并求和，而不是把前半段丢掉', () => {
    const usage = collect([
      tokenCount(1000, 100, 1100),
      tokenCount(2000, 200, 2200),
      tokenCount(300, 30, 330)
    ])

    expect(usage?.basis).toBe('delta')
    expect(usage?.totalTokens).toBe(1100 + 2200 + 330)
  })

  it('相邻两条完全相等仍然算单调不减', () => {
    const usage = collect([tokenCount(100, 10, 110), tokenCount(100, 10, 110)])

    expect(usage?.basis).toBe('cumulative')
    expect(usage?.totalTokens).toBe(110)
  })

  it('数字是字符串也认', () => {
    const usage = collect([
      {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: '100', output_tokens: '20', total_tokens: '120' }
        }
      }
    ])

    expect(usage?.totalTokens).toBe(120)
    expect(usage?.inputTokens).toBe(100)
  })

  it('缺 total_tokens 时用输入加输出补出来', () => {
    const usage = collect([
      { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } }
    ])

    expect(usage?.totalTokens).toBe(120)
  })

  it('三个数字全缺就当这条记录不存在', () => {
    expect(collect([{ type: 'token_count', info: { total_token_usage: { model: 'x' } } }])).toBeNull()
  })

  it('数字为负数的记录不认', () => {
    expect(
      collect([{ type: 'token_count', info: { total_token_usage: { total_tokens: -5 } } }])
    ).toBeNull()
  })

  it('数字直接摊在记录上（没有子对象）也认', () => {
    const usage = collect([{ type: 'usage', input_tokens: 40, output_tokens: 8 }])

    expect(usage?.totalTokens).toBe(48)
  })

  it('缓存字段缺失时是 null，不是 0', () => {
    expect(collect([tokenCount(100, 20, 120)])?.cachedInputTokens).toBeNull()
  })

  it('缓存字段存在时按同一条规则聚合', () => {
    const usage = collect([
      {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            output_tokens: 20,
            cached_input_tokens: 60,
            total_tokens: 120
          }
        }
      },
      {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 300,
            output_tokens: 40,
            cached_input_tokens: 250,
            total_tokens: 340
          }
        }
      }
    ])

    expect(usage?.basis).toBe('cumulative')
    expect(usage?.cachedInputTokens).toBe(250)
  })

  it('没有模型名时只有一条 unknown', () => {
    expect(collect([tokenCount(100, 20, 120)])?.byModel).toEqual([
      { model: 'unknown', totalTokens: 120 }
    ])
  })

  it('模型名从 turn_context 取，按模型拆分且各项之和等于总数', () => {
    const usage = collect([
      { type: 'turn_context', model: 'gpt-a' },
      tokenCount(4890, 210, 5100),
      { type: 'turn_context', model: 'gpt-b' },
      tokenCount(9120, 640, 9760)
    ])

    expect(usage?.byModel).toEqual([
      { model: 'gpt-a', totalTokens: 5100 },
      { model: 'gpt-b', totalTokens: 4660 }
    ])
    expect(usage?.byModel.reduce((sum, entry) => sum + entry.totalTokens, 0)).toBe(
      usage?.totalTokens
    )
  })

  it('增量序列按模型直接分别求和', () => {
    const usage = collect([
      { type: 'turn_context', model: 'gpt-a' },
      tokenCount(100, 10, 110),
      { type: 'turn_context', model: 'gpt-b' },
      tokenCount(50, 5, 55),
      tokenCount(20, 2, 22)
    ])

    expect(usage?.basis).toBe('delta')
    expect(usage?.byModel).toEqual([
      { model: 'gpt-a', totalTokens: 110 },
      { model: 'gpt-b', totalTokens: 77 }
    ])
    expect(usage?.byModel.reduce((sum, entry) => sum + entry.totalTokens, 0)).toBe(
      usage?.totalTokens
    )
  })

  it('第一条用量记录出现在模型名之前时归到 unknown', () => {
    const usage = collect([
      tokenCount(100, 10, 110),
      { type: 'turn_context', model: 'gpt-a' },
      tokenCount(300, 30, 330)
    ])

    expect(usage?.byModel).toEqual([
      { model: 'gpt-a', totalTokens: 220 },
      { model: 'unknown', totalTokens: 110 }
    ])
  })

  it('上下文窗口取最后一个非空值', () => {
    const usage = collect([
      { type: 'task_started', model_context_window: 200000 },
      tokenCount(100, 20, 120),
      { type: 'task_started', model_context_window: 400000 }
    ])

    expect(usage?.contextWindow).toBe(400000)
  })

  it('只有上下文窗口、没有任何用量数字时仍然返回 null', () => {
    expect(collect([{ type: 'task_started', model_context_window: 200000 }])).toBeNull()
  })

  it('喂进去的东西再离谱也不抛异常', () => {
    const collector = new UsageCollector()
    const hostile = {
      get info() {
        throw new Error('boom')
      }
    }

    expect(() => collector.note(hostile)).not.toThrow()
    expect(() => collector.note(null)).not.toThrow()
    expect(() => collector.note(undefined)).not.toThrow()
    expect(() => collector.note('字符串')).not.toThrow()
    expect(() => collector.note([1, 2, 3])).not.toThrow()
    expect(collector.summary()).toBeNull()
  })

  it('中间夹了一条畸形记录，前后的样本照样算', () => {
    const collector = new UsageCollector()
    collector.note(tokenCount(100, 10, 110))
    collector.note({
      get info() {
        throw new Error('boom')
      }
    })
    collector.note(tokenCount(300, 30, 330))

    expect(collector.summary()?.totalTokens).toBe(330)
  })
})
