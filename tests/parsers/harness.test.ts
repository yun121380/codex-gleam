import { describe, expect, it } from 'vitest'
import type { CodexEventType } from '../../src/shared/types'
import { fixturePath, loadFixture } from '../support/fixtures'

/**
 * 针对「多智能体 harness」格式的端到端测试。
 *
 * 这类日志的特点（都来自实测真实数据）：
 *   - 一半以上的记录是 harness 自己的噪音（条目回播、用量计数、任务通知）；
 *   - 工具调用的参数不是 JSON，而是一段调用 tools.* 的代码；
 *   - 真正的命令藏在 cmd:"…" 里，文件改动藏在 apply_patch 的补丁字符串里；
 *   - 输出是 [{type:'input_text',text:'…'}] 数组，且**不记录退出码**。
 */

const FIXTURE = 'sample-agent-harness.jsonl'

async function harnessSession() {
  const { sessions, issues } = await loadFixture(fixturePath(FIXTURE))
  expect(issues).toEqual([])
  expect(sessions).toHaveLength(1)
  return sessions[0]!
}

describe('harness 格式：噪音过滤', () => {
  it('条目回播、用量计数、任务通知全部不出现在时间线上', async () => {
    const session = await harnessSession()
    const dump = JSON.stringify(session.events)

    for (const noise of [
      'item_completed',
      'token_count',
      'task_started',
      'task_complete',
      'thread_settings_applied'
    ]) {
      expect(dump, `${noise} 不该出现`).not.toContain(noise)
    }
  })

  it('没有任何「其他记录」，说明每条留下来的记录都被认出来了', async () => {
    const session = await harnessSession()
    expect(session.events.filter((event) => event.type === 'unknown')).toEqual([])
  })

  it('丢弃噪音不算解析失败，不产生警告', async () => {
    const session = await harnessSession()
    expect(session.warnings).toEqual([])
  })

  it('26 条原始记录被压缩成十几个有意义的步骤', async () => {
    const session = await harnessSession()
    expect(session.eventCount).toBeGreaterThan(10)
    expect(session.eventCount).toBeLessThan(20)
  })
})

describe('harness 格式：重复记录只留一份', () => {
  /**
   * 实测踩到的坑：有些 harness 有两条并行的记录通道，
   * 一条给界面看（event_msg），一条是正式记录（response_item），
   * 同一句话写两遍 —— 时间线上每句话都出现两次。
   */
  it('同一句话通过两条通道各写一遍时只显示一次', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-mirrored-records.jsonl'))
    const session = sessions[0]!

    const users = session.events.filter((event) => event.type === 'user_message')
    const replies = session.events.filter((event) => event.type === 'assistant_message')
    const reasoning = session.events.filter((event) => event.type === 'reasoning')

    expect(users).toHaveLength(1)
    expect(reasoning).toHaveLength(1)
    // 文件里有两条内容不同的回复，其中一条被重复记录了两遍。
    expect(replies).toHaveLength(2)
  })

  it('内容不同的连续消息不会被误合并', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-mirrored-records.jsonl'))
    const session = sessions[0]!
    const contents = session.events
      .filter((event) => event.type === 'assistant_message')
      .map((event) => event.content)

    expect(new Set(contents).size).toBe(contents.length)
  })

  it('同一条命令跑两次都保留（那是两次真实执行，改动前后各一次）', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-mirrored-records.jsonl'))
    const session = sessions[0]!
    // npm test 会被识别成「开始测试」。
    const runs = session.events.filter((event) => event.command === 'npm test' && event.type === 'test_start')

    expect(runs).toHaveLength(2)
  })

  it('先失败后通过的两次测试结果都在', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-mirrored-records.jsonl'))
    const results = sessions[0]!.events.filter((event) => event.type === 'test_result')

    expect(results).toHaveLength(2)
    expect(results[0]?.test).toMatchObject({ passed: 4, failed: 1 })
    expect(results[1]?.test).toMatchObject({ passed: 5, failed: 0 })
  })

  it('补丁完成通知不会变成一条空洞的「修改文件」', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-mirrored-records.jsonl'))
    const session = sessions[0]!
    const edits = session.events.filter((event) => event.type === 'file_edit')

    // 只有一条真正的文件改动，而且它说清了改的是哪个文件。
    expect(edits).toHaveLength(1)
    expect(edits[0]?.fileChanges?.[0]?.path).toBe('src/retry.ts')
    expect(session.changedFiles).toEqual(['src/retry.ts'])

    // 那条只带 success 和一行 stdout 的通知按"执行结果"显示。
    const notice = session.events.find((event) => event.content.includes('M src/retry.ts'))
    expect(notice?.type).toBe('command_output')
  })
})

describe('harness 格式：会话开始只有一次', () => {
  it('session_meta 与 turn_context 不会产生两条「会话开始」', async () => {
    const session = await harnessSession()
    const starts = session.events.filter((event) => event.type === 'session_start')

    expect(starts).toHaveLength(1)
    expect(starts[0]?.workingDirectory).toBe('C:\\Users\\demo\\projects\\demo-report')
  })
})

describe('harness 格式：思考过程单独成类', () => {
  it('思考过程不混进 Codex 回复', async () => {
    const session = await harnessSession()

    const reasoning = session.events.filter((event) => event.type === 'reasoning')
    const replies = session.events.filter((event) => event.type === 'assistant_message')

    expect(reasoning).toHaveLength(2)
    expect(replies).toHaveLength(2)
    expect(reasoning[0]?.content).toContain('CSV 列错位')
  })

  it('统计里能单独看到思考过程的数量', async () => {
    const session = await harnessSession()
    expect(session.eventTypeCounts.reasoning).toBe(2)
  })
})

describe('harness 格式：命令抽取', () => {
  it('从 tools.exec_command 的代码里抽出真实命令', async () => {
    const session = await harnessSession()
    const commands = session.events
      .filter((event) => event.type === 'shell_command' || event.type === 'test_start')
      .map((event) => event.command)

    expect(commands).toEqual([
      "rg -n 'join' src/export --type ts",
      'npm run lint',
      'npm test'
    ])
  })

  it('命令的标题就是命令本身，而不是笼统的「执行命令」', async () => {
    const session = await harnessSession()
    const lint = session.events.find((event) => event.command === 'npm run lint')

    expect(lint?.title).toBe('npm run lint')
  })

  it('工作目录从代码里的 workdir 抽出', async () => {
    const session = await harnessSession()
    const lint = session.events.find((event) => event.command === 'npm run lint')

    expect(lint?.workingDirectory).toBe('C:\\Users\\demo\\projects\\demo-report')
  })

  it('测试命令被识别成开始测试，输出升级为测试结果', async () => {
    const session = await harnessSession()

    expect(session.events.some((event) => event.type === 'test_start')).toBe(true)
    const result = session.events.find((event) => event.type === 'test_result')
    expect(result?.test).toMatchObject({ passed: 6, failed: 0 })
    expect(session.testsPassed).toBe(6)
  })

  it('没有命令的工具调用显示成具体工具名', async () => {
    const session = await harnessSession()
    const call = session.events.find((event) => event.type === 'tool_call')

    expect(call?.title).toBe('调用工具：write_stdin')
  })
})

describe('harness 格式：文件改动', () => {
  it('从 apply_patch 的补丁字符串里解析出改动', async () => {
    const session = await harnessSession()

    expect(session.changedFiles.sort()).toEqual(['src/export/csv.ts', 'src/export/escapeCell.ts'])
    expect(session.hasCodeChanges).toBe(true)
    expect(session.changedFileCount).toBe(2)
  })

  it('改动带有可展示的差异内容', async () => {
    const session = await harnessSession()
    const edit = session.events.find(
      (event) => event.fileChanges?.some((change) => change.path === 'src/export/csv.ts')
    )
    const change = edit?.fileChanges?.[0]

    expect(change?.diff).toContain('rows.map(escapeCell)')
    expect(change?.additions).toBe(1)
    expect(change?.deletions).toBe(1)
  })

  it('新增文件被标成写入', async () => {
    const session = await harnessSession()
    const added = session.events
      .flatMap((event) => event.fileChanges ?? [])
      .find((change) => change.path === 'src/export/escapeCell.ts')

    expect(added?.kind).toBe('write')
  })
})

describe('harness 格式：输出与成败', () => {
  it('数组形式的输出被正确展开成文本', async () => {
    const session = await harnessSession()
    const output = session.events.find(
      (event) => event.type === 'command_output' && event.command === "rg -n 'join' src/export --type ts"
    )

    expect(output?.content).toContain('src/export/csv.ts:14')
  })

  it('Wall time 被抽成耗时', async () => {
    const session = await harnessSession()
    const output = session.events.find((event) => event.command === "rg -n 'join' src/export --type ts" && event.type === 'command_output')

    expect(output?.durationMs).toBe(400)
  })

  it('「command not found」被判定为失败，并回填到命令上', async () => {
    const session = await harnessSession()

    const lint = session.events.find((event) => event.command === 'npm run lint' && event.type !== 'command_output')
    expect(lint?.success).toBe(false)
    expect(session.failedCommandCount).toBe(1)
    expect(session.hasFailures).toBe(true)
  })

  it('没有失败标记的输出保持「未记录」，不瞎猜成功或失败', async () => {
    const session = await harnessSession()
    const output = session.events.find(
      (event) => event.type === 'command_output' && event.command === "rg -n 'join' src/export --type ts"
    )

    // 这个 harness 不写退出码，所以只能是 null —— 谎报成功比不报更糟。
    expect(output?.success).toBeNull()
    expect(output?.exitCode ?? null).toBeNull()
  })
})

describe('harness 格式：会话摘要', () => {
  it('项目名与时间范围来自日志本身', async () => {
    const session = await harnessSession()

    expect(session.projectName).toBe('demo-report')
    expect(session.startedAt).toBe('2026-08-28T10:14:02.100Z')
    // 最后一条 task_complete 是噪音，被丢掉了，所以结束时间是最后一句真实回复。
    expect(session.endedAt).toBe('2026-08-28T10:14:52.900Z')
  })

  it('标题取自用户第一句话', async () => {
    const session = await harnessSession()
    expect(session.title).toContain('CSV')
  })

  it('各类事件都被计数', async () => {
    const session = await harnessSession()
    const types = Object.keys(session.eventTypeCounts) as CodexEventType[]

    for (const expected of ['user_message', 'reasoning', 'shell_command', 'file_edit'] as CodexEventType[]) {
      expect(types, `缺少 ${expected}`).toContain(expected)
    }
  })
})
