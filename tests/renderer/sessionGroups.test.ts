import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../src/shared/types'
import { describeAgent, foldSubAgents } from '../../src/renderer/lib/sessionGroups'

/**
 * 并行子代理的折叠。
 *
 * 依据是 Codex 写在 session_meta 里的 parent_thread_id，不是标题 ——
 * 好几个月前各自打过一句 "hi" 的会话也会重名，它们之间毫无关系。
 */
function session(
  id: string,
  agent: Partial<SessionSummary['agent']> = {},
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id,
    title: '同一个任务',
    projectName: 'demo',
    projectPath: null,
    sourceFile: `C:\\x\\${id}.jsonl`,
    displaySourceFile: `~\\x\\${id}.jsonl`,
    fileSizeBytes: 10,
    startedAt: '2026-08-09T07:00:00.000Z',
    endedAt: '2026-08-09T07:10:00.000Z',
    durationMs: 600_000,
    eventCount: 5,
    userMessageCount: 1,
    assistantMessageCount: 1,
    commandCount: 0,
    failedCommandCount: 0,
    changedFileCount: 0,
    changedFiles: [],
    testsPassed: 0,
    testsFailed: 0,
    errorCount: 0,
    hasFailures: false,
    hasCodeChanges: false,
    confidence: 'high',
    confidenceScore: 1,
    parserId: 'jsonl-events',
    eventTypeCounts: {},
    warnings: [],
    indexedAt: '2026-08-09T07:10:00.000Z',
    fileModifiedAt: '2026-08-09T07:10:00.000Z',
    agent: { threadId: null, parentThreadId: null, nickname: null, role: null, taskPath: null, ...agent },
    ...overrides
  }
}

describe('折叠并行子代理', () => {
  it('子代理挂到派出它们的会话下面', () => {
    const groups = foldSubAgents([
      session('parent', { threadId: 't-parent' }),
      session('kid-1', { threadId: 't-1', parentThreadId: 't-parent', nickname: 'Kepler' }),
      session('kid-2', { threadId: 't-2', parentThreadId: 't-parent', nickname: 'Turing' })
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.parent.id).toBe('parent')
    expect(groups[0]?.children.map((child) => child.id)).toEqual(['kid-1', 'kid-2'])
  })

  it('没有父子关系的会话各自成一行', () => {
    const groups = foldSubAgents([
      session('a', { threadId: 't-a' }),
      session('b', { threadId: 't-b' })
    ])

    expect(groups.map((group) => group.parent.id)).toEqual(['a', 'b'])
    expect(groups.every((group) => group.children.length === 0)).toBe(true)
  })

  it('标题一样但没有父子关系的，绝不合并（几个月前各打一句 hi）', () => {
    const groups = foldSubAgents([
      session('hi-1', { threadId: 't-1' }, { title: 'hi', startedAt: '2026-05-19T10:45:00.000Z' }),
      session('hi-2', { threadId: 't-2' }, { title: 'hi', startedAt: '2026-06-30T15:21:00.000Z' })
    ])

    expect(groups).toHaveLength(2)
  })

  it('父会话不在列表里时，子代理仍然显示，不会凭空消失', () => {
    const groups = foldSubAgents([
      session('kid-1', { threadId: 't-1', parentThreadId: '不存在的父会话' }),
      session('kid-2', { threadId: 't-2', parentThreadId: '不存在的父会话' })
    ])

    expect(groups.map((group) => group.parent.id)).toEqual(['kid-1', 'kid-2'])
  })

  it('子代理按开始时间排序', () => {
    const groups = foldSubAgents([
      session('parent', { threadId: 't-parent' }),
      session('late', { threadId: 't-2', parentThreadId: 't-parent' }, { startedAt: '2026-08-09T07:19:00.000Z' }),
      session('early', { threadId: 't-1', parentThreadId: 't-parent' }, { startedAt: '2026-08-09T06:58:00.000Z' })
    ])

    expect(groups[0]?.children.map((child) => child.id)).toEqual(['early', 'late'])
  })

  it('子代理又派了子代理时，整棵子树都挂到最顶上那个会话下（只折一层）', () => {
    const groups = foldSubAgents([
      session('root', { threadId: 't-root' }),
      session('mid', { threadId: 't-mid', parentThreadId: 't-root' }),
      session('leaf', { threadId: 't-leaf', parentThreadId: 't-mid' })
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.parent.id).toBe('root')
    expect(groups[0]?.children.map((child) => child.id).sort()).toEqual(['leaf', 'mid'])
  })

  it('父子关系成环时不会死循环', () => {
    const groups = foldSubAgents([
      session('a', { threadId: 't-a', parentThreadId: 't-b' }),
      session('b', { threadId: 't-b', parentThreadId: 't-a' })
    ])

    expect(groups.length).toBeGreaterThan(0)
  })

  it('顶层会话保持调用方给的顺序', () => {
    const groups = foldSubAgents([
      session('c', { threadId: 't-c' }),
      session('a', { threadId: 't-a' }),
      session('b', { threadId: 't-b' })
    ])

    expect(groups.map((group) => group.parent.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('子代理的显示名', () => {
  it('代号 + 任务 + 角色', () => {
    const one = session('x', {
      nickname: 'Schrodinger',
      taskPath: '/root/voice_slice',
      role: 'explorer'
    })
    expect(describeAgent(one)).toBe('Schrodinger · voice slice · explorer')
  })

  it('只有代号时就只显示代号', () => {
    expect(describeAgent(session('x', { nickname: 'Kepler' }))).toBe('Kepler')
  })

  it('什么都没有时给个兜底名字，不显示空白', () => {
    expect(describeAgent(session('x'))).toBe('子代理')
  })
})
