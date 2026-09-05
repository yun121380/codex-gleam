import { describe, expect, it } from 'vitest'

import { loadFixtureSession } from '../support/fixtures'

describe('会话用量', () => {
  /**
   * spec 第六节的关键断言。
   *
   * 这个 fixture 的三条 token_count 依次是 4390 → 5100 → 9760，单调递增，是累计
   * 值。直接求和会得到 19250 —— 接近真值的两倍，而且会话越长错得越多。
   */
  it('累计序列的 fixture 得出 9760 而不是 19250', async () => {
    const session = await loadFixtureSession('sample-agent-harness.jsonl')

    expect(session.usage).not.toBeNull()
    expect(session.usage?.totalTokens).toBe(9760)
    expect(session.usage?.totalTokens).not.toBe(19250)
    expect(session.usage?.basis).toBe('cumulative')
    expect(session.usage?.inputTokens).toBe(9120)
    expect(session.usage?.outputTokens).toBe(640)
    expect(session.usage?.cachedInputTokens).toBeNull()
  })

  it('模型名从 turn_context 认出来，上下文窗口从 task_started 认出来', async () => {
    const session = await loadFixtureSession('sample-agent-harness.jsonl')

    expect(session.usage?.byModel).toEqual([{ model: 'demo-model', totalTokens: 9760 }])
    expect(session.usage?.contextWindow).toBe(200000)
  })

  it('按模型拆分之和恒等于总数', async () => {
    for (const name of [
      'sample-agent-harness.jsonl',
      'sample-codex-session.jsonl',
      'sample-mirrored-records.jsonl'
    ]) {
      const session = await loadFixtureSession(name)
      const usage = session.usage
      expect(usage, name).not.toBeNull()
      expect(usage!.byModel.reduce((sum, entry) => sum + entry.totalTokens, 0), name).toBe(
        usage!.totalTokens
      )
    }
  })

  it('只有一条用量记录的 fixture 也认', async () => {
    const session = await loadFixtureSession('sample-codex-session.jsonl')

    expect(session.usage?.basis).toBe('cumulative')
    expect(session.usage?.totalTokens).toBe(19602)
  })

  it('日志里没有用量记录时是 null，不是一堆 0', async () => {
    const session = await loadFixtureSession('sample-partial-broken.jsonl')

    expect(session.usage).toBeNull()
  })
})
