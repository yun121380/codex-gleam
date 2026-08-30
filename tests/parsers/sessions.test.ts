import { describe, expect, it } from 'vitest'
import type { CodexEventType } from '../../src/shared/types'
import { fixturePath, loadFixture } from '../support/fixtures'

function typesOf(events: ReadonlyArray<{ type: CodexEventType }>): Set<CodexEventType> {
  return new Set(events.map((event) => event.type))
}

describe('JSONL 会话识别与解析（示例：demo-shop）', () => {
  it('解析出一个完整会话', async () => {
    const { sessions, issues } = await loadFixture(fixturePath('sample-codex-session.jsonl'))

    expect(sessions).toHaveLength(1)
    expect(issues).toEqual([])
  })

  it('会话基本信息来自日志本身', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const session = sessions[0]!

    expect(session.projectName).toBe('demo-shop')
    expect(session.projectPath).toBe('C:\\Users\\demo\\projects\\demo-shop')
    expect(session.title).toContain('购物车')
    expect(session.confidence).toBe('high')
    expect(session.parserId).toBe('jsonl-events')
    expect(session.warnings).toEqual([])
  })

  it('时间范围与时长被算出来', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const session = sessions[0]!

    expect(session.startedAt).toBe('2026-08-24T09:12:03.120Z')
    expect(session.endedAt).toBe('2026-08-24T09:12:58.640Z')
    expect(session.durationMs).toBe(55520)
  })

  it('涵盖对话、命令、文件修改、测试等各类事件', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const types = typesOf(sessions[0]!.events)

    for (const expected of [
      'session_start',
      'user_message',
      'assistant_message',
      'shell_command',
      'command_output',
      'file_edit',
      'test_start',
      'test_result'
    ] as CodexEventType[]) {
      expect(types.has(expected), `缺少事件类型 ${expected}`).toBe(true)
    }
  })

  it('统计出命令数、失败数与改动的文件', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const session = sessions[0]!

    // 7 条 shell 命令；3 次 apply_patch 算文件修改，不算命令。
    expect(session.commandCount).toBe(7)
    expect(session.failedCommandCount).toBe(2)
    expect(session.changedFiles).toEqual(['src/cart/price.ts'])
    expect(session.hasCodeChanges).toBe(true)
    expect(session.hasFailures).toBe(true)
  })

  it('两次测试的结果都被记下来', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const session = sessions[0]!
    const results = session.events.filter((event) => event.type === 'test_result')

    expect(results).toHaveLength(2)
    expect(results[0]?.test).toMatchObject({ passed: 7, failed: 1 })
    expect(results[1]?.test).toMatchObject({ passed: 8, failed: 0 })
    expect(session.testsPassed).toBe(15)
    expect(session.testsFailed).toBe(1)
  })

  it('命令输出里的退出码被正确读出（藏在 metadata 里）', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const lint = sessions[0]!.events.find((event) => event.command === 'npm run lint')

    expect(lint?.success).toBe(false)

    const lintOutput = sessions[0]!.events.find(
      (event) => event.type === 'command_output' && event.linkedCommandId === lint?.id
    )
    expect(lintOutput?.exitCode).toBe(1)
    expect(lintOutput?.durationMs).toBe(4620)
  })

  it('补丁被解析成可展示的差异', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const edits = sessions[0]!.events.filter((event) => event.type === 'file_edit')

    expect(edits.length).toBeGreaterThanOrEqual(3)
    const change = edits[0]?.fileChanges?.[0]
    expect(change?.path).toBe('src/cart/price.ts')
    expect(change?.diff).toContain('subtotal >= coupon.threshold')
    expect(change?.displayPath).toBe('src/cart/price.ts')
  })

  /**
   * 渲染进程拿不到 homeDir，没法自己把 `C:\Users\用户名\…` 换成 `~\…`。
   * 所以每个事件都得带上算好的展示路径，否则详情页只能显示原始路径，
   * 默认设置下就把用户名摆出来了。
   */
  it('每个事件都带上隐去用户名的展示路径', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const events = sessions[0]!.events

    const withCwd = events.filter((event) => event.workingDirectory !== null)
    expect(withCwd.length).toBeGreaterThan(0)

    for (const event of withCwd) {
      expect(event.workingDirectory).toContain('C:\\Users\\demo')
      expect(event.displayWorkingDirectory, event.title).toBe('~\\projects\\demo-shop')
    }
  })

  it('相关文件的展示路径逐条对齐，数量不会错位', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const events = sessions[0]!.events

    const withFiles = events.filter((event) => event.relatedFiles.length > 0)
    expect(withFiles.length).toBeGreaterThan(0)

    for (const event of withFiles) {
      expect(event.displayRelatedFiles, event.title).toHaveLength(event.relatedFiles.length)
    }
  })

  it('展示路径里不含用户主目录', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const events = sessions[0]!.events

    for (const event of events) {
      expect(event.displayWorkingDirectory ?? '').not.toContain('C:\\Users\\demo')
      for (const file of event.displayRelatedFiles) {
        expect(file).not.toContain('C:\\Users\\demo')
      }
    }
  })

  it('token_count 这类纯用量记录被整条丢弃，不占用时间线', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const session = sessions[0]!

    expect(session.events.some((event) => event.type === 'unknown')).toBe(false)
    expect(JSON.stringify(session.events)).not.toContain('token_count')
  })

  it('丢弃噪音不会被当成解析失败而弹警告', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    expect(sessions[0]!.warnings).toEqual([])
  })

  it('每个事件都记录了来源文件与行号', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))

    for (const event of sessions[0]!.events) {
      expect(event.sourceFile).toContain('sample-codex-session.jsonl')
      expect(typeof event.sourceLine).toBe('number')
    }
  })
})

describe('JSON 会话对象解析（示例：demo-blog）', () => {
  it('用不同字段名写成的 JSON 也能解析', async () => {
    const { sessions, issues } = await loadFixture(fixturePath('sample-codex-session.json'))

    expect(issues).toEqual([])
    expect(sessions).toHaveLength(1)

    const session = sessions[0]!
    expect(session.parserId).toBe('json-session-object')
    expect(session.title).toBe('给博客加上暗色模式')
    expect(session.projectName).toBe('demo-blog')
  })

  it('新增文件、修改文件、错误与测试结果都被识别', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.json'))
    const session = sessions[0]!

    expect(session.changedFiles.sort()).toEqual(['src/hooks/useTheme.ts', 'src/styles/base.css'])
    expect(session.errorCount).toBe(1)
    expect(session.testsPassed).toBe(12)
    expect(session.testsFailed).toBe(0)

    const write = session.events.find((event) => event.type === 'file_write')
    expect(write?.fileChanges?.[0]?.kind).toBe('write')
    expect(write?.fileChanges?.[0]?.additions).toBeGreaterThan(5)
  })
})

describe('一个文件里多个会话（JSON 数组）', () => {
  it('拆成两个独立会话', async () => {
    const { sessions, issues } = await loadFixture(fixturePath('sample-codex-multi-session.json'))

    expect(issues).toEqual([])
    expect(sessions).toHaveLength(2)
    expect(sessions.map((session) => session.projectName)).toEqual([
      'demo-dashboard',
      'demo-crawler'
    ])
    expect(sessions[0]?.parserId).toBe('json-session-array')
  })

  it('两个会话的 id 不同，标题各自独立', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-multi-session.json'))

    expect(sessions[0]?.id).not.toBe(sessions[1]?.id)
    expect(sessions[0]?.title).toContain('打包时间')
    expect(sessions[1]?.title).toContain('周日')
  })

  it('before/after 形式与 diff 形式的改动都能识别', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-multi-session.json'))

    expect(sessions[0]?.changedFiles).toEqual(['src/routes.tsx'])
    expect(sessions[1]?.changedFiles.sort()).toEqual([
      'src/scheduler/jobs.ts',
      'tests/scheduler/jobs.test.ts'
    ])

    const lazyEdit = sessions[0]?.events.find((event) => event.type === 'file_edit')
    expect(lazyEdit?.fileChanges?.[0]?.diff).toContain('lazy')
  })

  it('第二个会话里先失败后成功的测试都被记下来', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-multi-session.json'))
    const session = sessions[1]!

    expect(session.testsFailed).toBe(1)
    expect(session.testsPassed).toBe(7)
    expect(session.hasFailures).toBe(true)
  })

  it('同一个文件重复解析得到稳定的会话 id', async () => {
    const first = await loadFixture(fixturePath('sample-codex-multi-session.json'))
    const second = await loadFixture(fixturePath('sample-codex-multi-session.json'))

    expect(first.sessions.map((session) => session.id)).toEqual(
      second.sessions.map((session) => session.id)
    )
  })
})

describe('部分损坏的日志（示例：demo-notes）', () => {
  it('坏行被跳过，其余内容照常解析', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-partial-broken.jsonl'))

    expect(sessions).toHaveLength(1)
    const session = sessions[0]!
    expect(session.eventCount).toBeGreaterThanOrEqual(6)
    expect(session.projectName).toBe('demo-notes')
  })

  it('给出明确的警告：多少行坏了、第几行、还能怎么办', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-partial-broken.jsonl'))
    const warning = sessions[0]!.warnings.find((entry) => entry.kind === 'partial-records')

    expect(warning).toBeDefined()
    expect(warning?.reason).toContain('2 行')
    expect(warning?.reason).toMatch(/第 \d+ 行/)
    expect(warning?.suggestion).not.toBe('')
  })

  it('损坏的日志里依然能读出测试通过结果', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-partial-broken.jsonl'))

    expect(sessions[0]?.testsPassed).toBe(3)
    expect(sessions[0]?.testsFailed).toBe(0)
  })
})
