import { describe, expect, it } from 'vitest'
import { MAX_PARSED_BYTES, MAX_PARSED_LINES } from '../../src/shared/constants'
import { fingerprintSample } from '../../src/main/scanner/fingerprint'
import { loadSessionsFromFile } from '../../src/main/parsers/loadSession'
import { createFakeFs, type FakeFileSpec } from '../support/fakeFs'

const DIR = 'C:\\Users\\demo\\.codex\\sessions'

async function load(
  fileName: string,
  spec: FakeFileSpec | string,
  options: { requireMeaningfulEvents?: boolean } = {}
) {
  const path = `${DIR}\\${fileName}`
  const fs = createFakeFs({ [path]: spec })
  const info = await fs.statPath(path)
  const head = await fs.readHead(path, 64 * 1024)

  return loadSessionsFromFile({
    filePath: path,
    fileSizeBytes: info.size,
    modifiedMs: info.mtimeMs,
    fs,
    fingerprint: fingerprintSample(head, path),
    homeDir: 'C:\\Users\\demo',
    platform: 'win32',
    ...options
  })
}

describe('损坏的 JSON', () => {
  it('整份 JSON 被截断时，明确告诉用户原因和下一步', async () => {
    const { sessions, issues } = await load(
      'truncated.json',
      '{"session_id":"a","messages":[{"role":"user","content":"hi"}'
    )

    expect(sessions).toEqual([])
    expect(issues).toHaveLength(1)
    expect(issues[0]?.kind).toBe('parse-failed')
    expect(issues[0]?.reason).toContain('不是合法的 JSON')
    expect(issues[0]?.suggestion).toContain('缺少')
    expect(issues[0]?.displayPath).toContain('~')
  })

  it('JSONL 全部行都坏掉时报告第一行的错误', async () => {
    const { sessions, issues } = await load('all-bad.jsonl', '{oops\n{"also broken\nnot json at all')

    expect(sessions).toEqual([])
    expect(issues[0]?.kind).toBe('parse-failed')
    expect(issues[0]?.reason).toMatch(/第 1 行/)
  })

  it('JSONL 只坏一部分时照常出会话，并附上警告', async () => {
    const content = [
      '{"type":"session_meta","payload":{"session_id":"ok-1","cwd":"C:\\\\demo"}}',
      '{"role":"user","content":"第一句"}',
      '{broken line here',
      '{"role":"assistant","content":"第二句"}'
    ].join('\n')

    const { sessions, issues } = await load('partly.jsonl', content)

    expect(issues).toEqual([])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.eventCount).toBe(3)
    expect(sessions[0]?.warnings.some((warning) => warning.reason.includes('1 行'))).toBe(true)
  })

  it('空文件被明确标记，而不是产出一个空会话', async () => {
    const { sessions, issues } = await load('empty.jsonl', '')

    expect(sessions).toEqual([])
    expect(issues[0]?.kind).toBe('parse-failed')
  })

  it('只有空白与注释行的文件不会崩', async () => {
    const { sessions, issues } = await load('comments.jsonl', '\n\n// 这是注释\n# 也是注释\n\n')

    expect(sessions).toEqual([])
    expect(issues).toHaveLength(1)
  })

  it('能解析成 JSON 但里面没有对话内容时，说明它可能不是会话', async () => {
    const { sessions, issues } = await load(
      'config.json',
      JSON.stringify({ session: 'x', workspace: 'y', timestamp: '2026-08-24T09:00:00Z' })
    )

    expect(sessions).toEqual([])
    expect(issues[0]?.kind).toBe('not-a-session')
    expect(issues[0]?.suggestion).toContain('导入单个文件')
  })

  it('扩展名是 .json 但内容其实是逐行 JSON 时自动改用逐行解析', async () => {
    const content = [
      '{"session_id":"jsonl-in-json","role":"user","content":"第一行"}',
      '{"role":"assistant","content":"第二行"}'
    ].join('\n')

    const { sessions } = await load('mislabeled.json', content)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.eventCount).toBe(2)
  })
})

describe('超大文件', () => {
  it('单体 JSON 超过解析上限时被跳过，并解释为什么', async () => {
    const { sessions, issues } = await load('huge.json', {
      content: '{"messages":[{"role":"user","content":"hi"}]}',
      size: MAX_PARSED_BYTES + 1
    })

    expect(sessions).toEqual([])
    expect(issues[0]?.kind).toBe('skipped-large')
    expect(issues[0]?.reason).toContain('MB')
    expect(issues[0]?.suggestion).toContain('.jsonl')
  })

  it('超长 JSONL 只读前面若干条，并提示已截断', async () => {
    const lines: string[] = ['{"session_id":"big","role":"user","content":"开始"}']
    for (let index = 0; index < MAX_PARSED_LINES + 20; index += 1) {
      lines.push(`{"role":"assistant","content":"第 ${index} 条"}`)
    }

    const { sessions } = await load('big.jsonl', lines.join('\n'))

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.eventCount).toBe(MAX_PARSED_LINES)
    expect(
      sessions[0]?.warnings.some((warning) => warning.reason.includes('只读取了前'))
    ).toBe(true)
  }, 60_000)

  it('单行特别长的 JSONL 不会把整个会话搞崩', async () => {
    const longText = 'x'.repeat(200_000)
    const content = [
      '{"session_id":"long-line","role":"user","content":"看看长输出"}',
      JSON.stringify({ type: 'command_output', exit_code: 0, stdout: longText })
    ].join('\n')

    const { sessions } = await load('longline.jsonl', content)

    expect(sessions).toHaveLength(1)
    const output = sessions[0]?.events.find((event) => event.type === 'command_output')
    expect(output?.content.length).toBeLessThan(longText.length)
    expect(output?.content).toContain('已截断')
  })
})

describe('把配置文件挡在门外', () => {
  /**
   * 真实数据里踩到的坑：Sentry 的崩溃报告文件因为正文里提到了
   * conversation / session / shell / command 这些词，指纹拿到了满分，
   * 于是被当成会话排在列表最前面。光靠词频区分不了，必须看结构。
   */
  const SENTRY_LIKE = JSON.stringify({
    scope: {
      user: { id: 'demo' },
      tags: { session: 'active', model: 'demo-model' },
      breadcrumbs: [
        { timestamp: '2026-08-28T10:00:00Z', message: 'conversation turns shell command' },
        { timestamp: '2026-08-28T10:00:01Z', message: 'cwd content role' }
      ]
    },
    event: { level: 'error', timestamp: '2026-08-28T10:00:02Z' }
  })

  it('这类文件的指纹分确实很高（所以词频挡不住它）', () => {
    expect(fingerprintSample(SENTRY_LIKE, 'scope_v3.json').score).toBeGreaterThan(0.3)
  })

  it('批量扫描时被判为不是会话', async () => {
    const { sessions, issues } = await load('scope_v3.json', SENTRY_LIKE, {
      requireMeaningfulEvents: true
    })

    expect(sessions).toEqual([])
    expect(issues[0]?.kind).toBe('not-a-session')
    expect(issues[0]?.reason).toContain('配置或状态文件')
    expect(issues[0]?.suggestion).toContain('导入单个文件')
  })

  it('用户明确导入时仍然打得开（不做这项检查）', async () => {
    const { sessions } = await load('scope_v3.json', SENTRY_LIKE)
    expect(sessions.length).toBeGreaterThanOrEqual(1)
  })

  it('真正的会话不受影响', async () => {
    const content = [
      '{"type":"session_meta","payload":{"session_id":"real","cwd":"C:\\\\demo"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我改个 bug"}]}}'
    ].join('\n')

    const { sessions } = await load('real.jsonl', content, { requireMeaningfulEvents: true })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.userMessageCount).toBe(1)
  })

  it('只有会话开始、没有任何对话或动作的文件也被挡住', async () => {
    const content = [
      '{"type":"session_meta","payload":{"session_id":"empty-one","cwd":"C:\\\\demo"}}',
      '{"type":"turn_context","payload":{"cwd":"C:\\\\demo","model":"demo"}}'
    ].join('\n')

    const { sessions, issues } = await load('onlystart.jsonl', content, {
      requireMeaningfulEvents: true
    })

    expect(sessions).toEqual([])
    expect(issues[0]?.kind).toBe('not-a-session')
  })

  it('会话开始 + 一条出错也算会话（开局就中断的空会话，真实存在）', async () => {
    const content = [
      '{"type":"session_meta","payload":{"session_id":"aborted","cwd":"C:\\\\demo"}}',
      '{"type":"event_msg","payload":{"type":"stream_error","message":"连接中断"}}'
    ].join('\n')

    const { sessions } = await load('aborted.jsonl', content, { requireMeaningfulEvents: true })
    expect(sessions).toHaveLength(1)
  })
})

describe('把 Codex 自己的状态文件挡在门外', () => {
  /**
   * 真实数据里踩到的坑：`~/.codex/process_manager/chat_processes.json`
   * 是一个进程状态数组，每条带着 command 和 conversationId。
   * 于是它被按 conversationId 拆成 70 个"会话"排进列表，标题全是文件名，
   * 事件全是 shell_command —— 既没有一句对话，也没有一条会话元信息。
   */
  const PROCESS_MANAGER = JSON.stringify([
    {
      chatTitle: null,
      command: 'git status --short',
      conversationId: '019fd0ae-8c09-77d0-8d40-814781c1d62e',
      cwd: 'C:\\Users\\demo\\proj',
      itemId: 'exec-ad2f91c2',
      osPid: null,
      processId: null,
      startedAtMs: 1785912617121,
      turnId: '019fd0ae-f364-7980-aa59-34df277daa04',
      id: '019fd0ae-8c09-77d0-8d40-814781c1d62e:019fd0ae-f364:exec-ad2f91c2',
      updatedAtMs: 1785912617122
    },
    {
      chatTitle: null,
      command: 'npm test',
      conversationId: '019fccfb-2b71-7280-8a74-d3347edb6812',
      cwd: 'D:\\ai\\starforge',
      itemId: 'exec-77b31d40',
      osPid: null,
      processId: null,
      startedAtMs: 1785912600000,
      turnId: '019fccfb-4a19-7c31-9d02-1f0e5b7a9c11',
      id: '019fccfb-2b71-7280-8a74-d3347edb6812:019fccfb-4a19:exec-77b31d40',
      updatedAtMs: 1785912600001
    }
  ])

  it('指纹分同样很高（conversation、command、cwd 全命中）', () => {
    expect(fingerprintSample(PROCESS_MANAGER, 'chat_processes.json').score).toBeGreaterThan(0.3)
  })

  it('批量扫描时一个都不收', async () => {
    const { sessions, issues } = await load('chat_processes.json', PROCESS_MANAGER, {
      requireMeaningfulEvents: true
    })

    expect(sessions).toEqual([])
    expect(issues[0]?.kind).toBe('not-a-session')
  })

  it('用户明确导入时仍然打得开', async () => {
    const { sessions } = await load('chat_processes.json', PROCESS_MANAGER)
    expect(sessions.length).toBeGreaterThanOrEqual(1)
  })

  it('跑分结果这类"只有认不出的记录"的文件也被挡住', async () => {
    const benchmark = JSON.stringify([
      { task_id: 'HumanEval/0', passed: true, result: 'ok', completion: 'def f(): pass' },
      { task_id: 'HumanEval/1', passed: false, result: 'failed: timeout' }
    ])

    const { sessions } = await load('humaneval-results.json', benchmark, {
      requireMeaningfulEvents: true
    })
    expect(sessions).toEqual([])
  })
})

describe('同一文件里重复出现的会话 id', () => {
  it('不会互相覆盖，而是各自成为独立会话', async () => {
    const content = [
      '{"type":"session_meta","payload":{"session_id":"abc","cwd":"C:\\\\demo"}}',
      '{"role":"user","content":"第一段对话"}',
      '{"type":"session_meta","payload":{"session_id":"def","cwd":"C:\\\\demo"}}',
      '{"role":"user","content":"第二段对话"}',
      '{"type":"session_meta","payload":{"session_id":"abc","cwd":"C:\\\\demo"}}',
      '{"role":"user","content":"第三段对话（id 与第一段相同）"}'
    ].join('\n')

    const { sessions } = await load('repeated-id.jsonl', content)

    expect(sessions).toHaveLength(3)
    expect(new Set(sessions.map((session) => session.id)).size).toBe(3)
    expect(sessions.map((session) => session.events.length)).toEqual([2, 2, 2])
  })

  it('重复解析时 id 依然稳定', async () => {
    const content = [
      '{"session_id":"same","role":"user","content":"一"}',
      '{"session_id":"other","role":"user","content":"二"}',
      '{"session_id":"same","role":"user","content":"三"}'
    ].join('\n')

    const first = await load('stable.jsonl', content)
    const second = await load('stable.jsonl', content)

    expect(first.sessions.map((s) => s.id)).toEqual(second.sessions.map((s) => s.id))
    expect(new Set(first.sessions.map((s) => s.id)).size).toBe(first.sessions.length)
  })
})

describe('会话为空的边界情况', () => {
  it('messages 是空数组时不会产出会话', async () => {
    const { sessions, issues } = await load(
      'empty-messages.json',
      JSON.stringify({ session_id: 'e', messages: [], workspace: 'C:\\demo', role: 'user' })
    )

    expect(sessions).toEqual([])
    expect(issues).toHaveLength(1)
  })

  it('JSON 数组里混着非对象元素时只解析有效的部分', async () => {
    const { sessions } = await load(
      'mixed.json',
      JSON.stringify([
        null,
        42,
        'text',
        { role: 'user', content: '有效记录', session_id: 'mixed-1' },
        { role: 'assistant', content: '也有效' }
      ])
    )

    // null / 数字 / 裸字符串这些不成结构的元素被丢掉，只留下两条真正的记录。
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.eventCount).toBe(2)
  })
})
