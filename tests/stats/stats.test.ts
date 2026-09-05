import { describe, expect, it } from 'vitest'
import { computeStats } from '../../src/main/stats/stats'
import type { SessionSummary } from '../../src/shared/types'

const NOW = new Date('2026-08-29T12:00:00.000Z')

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: overrides.id ?? 'id-1',
    title: '示例会话',
    projectName: 'demo-shop',
    projectPath: 'C:\\Users\\demo\\projects\\demo-shop',
    sourceFile: 'C:\\Users\\demo\\.codex\\a.jsonl',
    displaySourceFile: '~\\.codex\\a.jsonl',
    fileSizeBytes: 1024,
    startedAt: '2026-08-28T10:00:00.000Z',
    endedAt: '2026-08-28T10:05:00.000Z',
    durationMs: 300_000,
    eventCount: 10,
    userMessageCount: 2,
    assistantMessageCount: 3,
    commandCount: 4,
    failedCommandCount: 1,
    changedFileCount: 2,
    changedFiles: ['src/a.ts', 'src/b.css'],
    testsPassed: 8,
    testsFailed: 1,
    errorCount: 0,
    hasFailures: true,
    hasCodeChanges: true,
    confidence: 'high',
    confidenceScore: 0.9,
    parserId: 'jsonl-events',
    eventTypeCounts: { user_message: 2, assistant_message: 3, shell_command: 4, test_result: 1 },
    warnings: [],
    indexedAt: '2026-08-28T10:05:00.000Z',
    fileModifiedAt: '2026-08-28T10:05:00.000Z',
    agent: { threadId: null, parentThreadId: null, nickname: null, role: null, taskPath: null },
    usage: null,
    ...overrides
  }
}

describe('统计计算', () => {
  it('没有会话时全部为 0，且不会除以零', () => {
    const stats = computeStats([], NOW)

    expect(stats.totalSessions).toBe(0)
    expect(stats.totalCommands).toBe(0)
    expect(stats.averageSessionDurationMs).toBe(0)
    expect(stats.topProjects).toEqual([])
    expect(stats.byDay).toHaveLength(14)
  })

  it('把各项数字加总', () => {
    const stats = computeStats([summary({ id: 'a' }), summary({ id: 'b' })], NOW)

    expect(stats.totalSessions).toBe(2)
    expect(stats.totalEvents).toBe(20)
    expect(stats.totalCommands).toBe(8)
    expect(stats.failedCommands).toBe(2)
    expect(stats.changedFileCount).toBe(4)
    expect(stats.testsPassed).toBe(16)
    expect(stats.testsFailed).toBe(2)
    expect(stats.totalDurationMs).toBe(600_000)
    expect(stats.averageSessionDurationMs).toBe(300_000)
  })

  it('修改过的文件按去重后的数量单独统计', () => {
    const stats = computeStats(
      [
        summary({ id: 'a', changedFiles: ['src/a.ts', 'src/b.ts'], changedFileCount: 2 }),
        summary({ id: 'b', changedFiles: ['src/a.ts', 'src/c.ts'], changedFileCount: 2 })
      ],
      NOW
    )

    expect(stats.changedFileCount).toBe(4)
    expect(stats.uniqueChangedFileCount).toBe(3)
  })

  it('"最近 7 天"以会话时间为准，超出范围的不计入', () => {
    const stats = computeStats(
      [
        summary({
          id: 'recent',
          startedAt: '2026-08-28T09:55:00.000Z',
          endedAt: '2026-08-28T10:00:00.000Z'
        }),
        summary({
          id: 'edge',
          startedAt: '2026-08-22T12:55:00.000Z',
          endedAt: '2026-08-22T13:00:00.000Z'
        }),
        summary({
          id: 'old',
          startedAt: '2026-07-01T09:55:00.000Z',
          endedAt: '2026-07-01T10:00:00.000Z',
          fileModifiedAt: '2026-07-01T10:00:00.000Z',
          indexedAt: '2026-07-01T10:00:00.000Z'
        })
      ],
      NOW
    )

    expect(stats.totalSessions).toBe(3)
    expect(stats.sessionsLast7Days).toBe(2)
  })

  it('缺少时间戳时退回文件修改时间', () => {
    const stats = computeStats(
      [
        summary({
          id: 'no-time',
          startedAt: null,
          endedAt: null,
          fileModifiedAt: '2026-08-28T09:00:00.000Z'
        })
      ],
      NOW
    )

    expect(stats.sessionsLast7Days).toBe(1)
  })

  it('项目按会话数排序', () => {
    const stats = computeStats(
      [
        summary({ id: '1', projectName: 'demo-shop' }),
        summary({ id: '2', projectName: 'demo-blog' }),
        summary({ id: '3', projectName: 'demo-shop' }),
        summary({ id: '4', projectName: 'demo-shop' })
      ],
      NOW
    )

    expect(stats.topProjects[0]).toEqual({ label: 'demo-shop', count: 3 })
    expect(stats.topProjects[1]).toEqual({ label: 'demo-blog', count: 1 })
  })

  it('按扩展名统计最常修改的文件类型', () => {
    const stats = computeStats(
      [
        summary({ id: '1', changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.css'] }),
        summary({ id: '2', changedFiles: ['src/d.ts', 'Makefile'] })
      ],
      NOW
    )

    expect(stats.topFileTypes[0]).toEqual({ label: '.ts', count: 3 })
    expect(stats.topFileTypes.map((item) => item.label)).toContain('（无扩展名）')
  })

  it('按天分桶，覆盖最近 14 天且日期递增', () => {
    const stats = computeStats([summary()], NOW)

    expect(stats.byDay).toHaveLength(14)
    const dates = stats.byDay.map((bucket) => bucket.date)
    expect([...dates].sort()).toEqual(dates)
    expect(stats.byDay.some((bucket) => bucket.sessions > 0)).toBe(true)
  })

  it('汇总各类事件数量', () => {
    const stats = computeStats([summary({ id: 'a' }), summary({ id: 'b' })], NOW)

    expect(stats.eventTypeCounts.user_message).toBe(4)
    expect(stats.eventTypeCounts.shell_command).toBe(8)
    expect(stats.eventTypeCounts.error).toBeUndefined()
  })

  it('同样的输入永远得到同样的输出（确定性）', () => {
    const sessions = [summary({ id: 'a' }), summary({ id: 'b', projectName: 'demo-blog' })]
    const first = computeStats(sessions, NOW)
    const second = computeStats(sessions, NOW)

    expect(first).toEqual(second)
  })

  it('记录生成时间，便于界面展示', () => {
    expect(computeStats([], NOW).generatedAt).toBe(NOW.toISOString())
  })
})
