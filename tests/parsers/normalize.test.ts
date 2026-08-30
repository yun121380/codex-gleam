import { describe, expect, it } from 'vitest'
import { normalizeRecords } from '../../src/main/parsers/normalize'
import type { NormalizeContext, ParsedRecord } from '../../src/main/parsers/types'
import type { CodexEvent } from '../../src/shared/types'

function context(workingDirectory: string | null = null): NormalizeContext {
  let counter = 0
  return {
    filePath: 'C:\\Users\\demo\\.codex\\sessions\\a.jsonl',
    parserId: 'test',
    workingDirectory,
    nextId: () => {
      counter += 1
      return `e${counter}`
    }
  }
}

function normalize(values: unknown[], workingDirectory: string | null = null): CodexEvent[] {
  const records: ParsedRecord[] = values.map((value, index) => ({ value, line: index + 1 }))
  return normalizeRecords(records, context(workingDirectory)).events
}

describe('事件统一转换', () => {
  it('把 role=user 的消息转成 user_message，并抽出纯文本', () => {
    const [event] = normalize([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我修一个 bug' }] }
    ])

    expect(event?.type).toBe('user_message')
    expect(event?.content).toBe('帮我修一个 bug')
    expect(event?.title).toBe('帮我修一个 bug')
    expect(event?.role).toBe('user')
  })

  it('剥掉 response_item 外层信封，并继承外层时间戳', () => {
    const [event] = normalize([
      {
        timestamp: '2026-08-24T09:12:10.500Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] }
      }
    ])

    expect(event?.type).toBe('assistant_message')
    expect(event?.content).toBe('好的')
    expect(event?.timestamp).toBe('2026-08-24T09:12:10.500Z')
  })

  it('没有 type、只有 role 时也能判断出消息类型', () => {
    const events = normalize([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' }
    ])

    expect(events.map((event) => event.type)).toEqual(['user_message', 'assistant_message'])
  })

  it('agent_reasoning 单独归为思考过程，不混进 Codex 回复', () => {
    const [event] = normalize([
      { type: 'agent_reasoning', summary: [{ type: 'summary_text', text: '先找到计价函数' }] }
    ])

    expect(event?.type).toBe('reasoning')
    expect(event?.content).toBe('先找到计价函数')
  })

  it('reasoning / thinking 等别名都归为思考过程', () => {
    const events = normalize([
      { type: 'reasoning', content: [{ type: 'text', text: '推演一' }] },
      { type: 'thinking', text: '推演二' }
    ])

    expect(events.map((event) => event.type)).toEqual(['reasoning', 'reasoning'])
  })

  it('function_call + shell 工具 → 执行命令，并从数组里解出真实命令', () => {
    const [event] = normalize([
      {
        type: 'function_call',
        name: 'shell',
        call_id: 'c1',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la src'] })
      }
    ])

    expect(event?.type).toBe('shell_command')
    expect(event?.command).toBe('ls -la src')
    expect(event?.callId).toBe('c1')
  })

  it('cmd.exe /c 这类 Windows 写法同样能解出命令', () => {
    const [event] = normalize([
      { type: 'shell_command', command: ['cmd.exe', '/c', 'dir', 'src'] }
    ])

    expect(event?.command).toBe('dir src')
  })

  it('非 shell 包装的命令数组按空格拼接', () => {
    const [event] = normalize([{ type: 'shell_command', command: ['git', 'status', '--short'] }])
    expect(event?.command).toBe('git status --short')
  })

  it('命令输出带退出码时判定成功或失败', () => {
    const events = normalize([
      { type: 'function_call_output', output: '{"output":"done","metadata":{"exit_code":0}}' },
      { type: 'function_call_output', output: '{"output":"boom","metadata":{"exit_code":1}}' }
    ])

    expect(events[0]?.type).toBe('command_output')
    expect(events[0]?.success).toBe(true)
    expect(events[0]?.content).toBe('done')
    expect(events[1]?.success).toBe(false)
    expect(events[1]?.exitCode).toBe(1)
    expect(events[1]?.title).toContain('退出码 1')
  })

  it('用 call_id 把命令和它的输出配对，失败结果回填到命令上', () => {
    const events = normalize([
      {
        type: 'function_call',
        name: 'shell',
        call_id: 'c9',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'npm run lint'] })
      },
      {
        type: 'function_call_output',
        call_id: 'c9',
        output: '{"output":"1 problem","metadata":{"exit_code":1}}'
      }
    ])

    expect(events[0]?.success).toBe(false)
    expect(events[1]?.linkedCommandId).toBe(events[0]?.id)
    expect(events[1]?.command).toBe('npm run lint')
  })

  it('没有 call_id 时按"最近一条未配对命令"配对', () => {
    const events = normalize([
      { type: 'shell_command', command: 'npm run build' },
      { type: 'command_output', exit_code: 2, stdout: 'failed' }
    ])

    expect(events[0]?.success).toBe(false)
    expect(events[1]?.linkedCommandId).toBe(events[0]?.id)
  })

  it('测试命令被识别成 test_start，其输出升级为 test_result', () => {
    const events = normalize([
      {
        type: 'function_call',
        name: 'shell',
        call_id: 't1',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] })
      },
      {
        type: 'function_call_output',
        call_id: 't1',
        output:
          '{"output":" Test Files  1 failed | 1 passed (2)\\n      Tests  1 failed | 7 passed (8)\\n","metadata":{"exit_code":1}}'
      }
    ])

    expect(events[0]?.type).toBe('test_start')
    expect(events[1]?.type).toBe('test_result')
    expect(events[1]?.test).toMatchObject({ passed: 7, failed: 1, skipped: 0, total: 8 })
    expect(events[1]?.success).toBe(false)
    expect(events[1]?.title).toContain('7 通过')
  })

  it('apply_patch 转成文件修改，并算出增删行数', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/cart/price.ts',
      '@@',
      '-  if (coupon && subtotal > coupon.threshold) {',
      '+  if (coupon && subtotal >= coupon.threshold) {',
      '     return subtotal - coupon.amount',
      '*** End Patch'
    ].join('\n')

    const [event] = normalize([
      { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: patch }) }
    ])

    expect(event?.type).toBe('file_edit')
    expect(event?.fileChanges).toHaveLength(1)
    expect(event?.fileChanges?.[0]).toMatchObject({
      path: 'src/cart/price.ts',
      kind: 'edit',
      additions: 1,
      deletions: 1
    })
    expect(event?.relatedFiles).toEqual(['src/cart/price.ts'])
    expect(event?.title).toContain('src/cart/price.ts')
  })

  it('changes 对象形状（路径 → 操作 → unified_diff）也能解析', () => {
    const [event] = normalize([
      {
        type: 'patch_apply_begin',
        changes: {
          'src/a.ts': { update: { unified_diff: '--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' } },
          'src/b.ts': { add: { content: 'export const b = 1\n' } }
        }
      }
    ])

    expect(event?.type).toBe('file_edit')
    expect(event?.fileChanges).toHaveLength(2)
    expect(event?.fileChanges?.find((change) => change.path === 'src/b.ts')?.kind).toBe('write')
    expect(event?.title).toContain('2 个文件')
  })

  it('只有 before/after 全文时自动算出 diff', () => {
    const [event] = normalize([
      {
        type: 'file_edit',
        path: 'src/x.ts',
        before: 'const a = 1\nconst b = 2\n',
        after: 'const a = 1\nconst b = 3\n'
      }
    ])

    const change = event?.fileChanges?.[0]
    expect(change?.diff).toContain('-const b = 2')
    expect(change?.diff).toContain('+const b = 3')
    expect(change?.additions).toBe(1)
    expect(change?.deletions).toBe(1)
  })

  it('结构化测试结果直接采用，不再猜文本', () => {
    const [event] = normalize([
      {
        type: 'test_result',
        test: { framework: 'Vitest', passed: 12, failed: 0, skipped: 1, duration_ms: 1830 }
      }
    ])

    expect(event?.test).toMatchObject({ framework: 'Vitest', passed: 12, failed: 0, skipped: 1 })
    expect(event?.success).toBe(true)
    expect(event?.durationMs).toBeUndefined()
  })

  it('错误事件标记为失败并保留堆栈', () => {
    const [event] = normalize([
      { type: 'error', error: 'ReferenceError: localStorage is not defined', stack: 'at foo.ts:9' }
    ])

    expect(event?.type).toBe('error')
    expect(event?.success).toBe(false)
    expect(event?.content).toContain('at foo.ts:9')
  })

  it('会话级工作目录会填到没有 cwd 的事件上', () => {
    const events = normalize(
      [{ type: 'shell_command', command: 'ls' }, { type: 'shell_command', command: 'pwd', cwd: 'D:\\other' }],
      'C:\\Users\\demo\\projects\\demo-shop'
    )

    expect(events[0]?.workingDirectory).toBe('C:\\Users\\demo\\projects\\demo-shop')
    expect(events[1]?.workingDirectory).toBe('D:\\other')
  })

  it('支持秒级时间戳', () => {
    const [event] = normalize([{ type: 'user_message', text: 'hi', timestamp: 1787000000 }])
    expect(event?.timestamp).toBe(new Date(1787000000 * 1000).toISOString())
  })
})

describe('不完整与异常记录', () => {
  it('未知类型归为 unknown，但原始内容完整保留', () => {
    const [event] = normalize([{ type: 'quantum_flux', mystery: 42, nested: { a: [1, 2] } }])

    expect(event?.type).toBe('unknown')
    expect(event?.title).toContain('quantum_flux')
    expect(event?.raw).toEqual({ type: 'quantum_flux', mystery: 42, nested: { a: [1, 2] } })
    expect(event?.content).toContain('quantum_flux')
  })

  it('空对象不会产出空白事件', () => {
    const [event] = normalize([{}])

    expect(event?.type).toBe('unknown')
    expect(event?.title).not.toBe('')
    expect(event?.content.trim()).not.toBe('')
  })

  it('缺字段的记录不影响其他记录', () => {
    const events = normalize([
      { role: 'user' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '正常' }] },
      { type: 'shell_command' }
    ])

    expect(events).toHaveLength(3)
    expect(events[1]?.content).toBe('正常')
  })

  it('纯字符串行也会保留成一条记录', () => {
    const [event] = normalize(['这是一行普通日志文字'])

    expect(event?.type).toBe('unknown')
    expect(event?.content).toBe('这是一行普通日志文字')
  })

  it('单条记录抛异常时被单独兜住，其余记录照常解析', () => {
    const explosive = {
      get type(): string {
        throw new Error('故意炸掉')
      }
    }

    const events = normalize([explosive, { role: 'user', content: '我还在' }])

    expect(events).toHaveLength(2)
    expect(events[0]?.title).toBe('这条记录读不懂')
    expect(events[0]?.content).toContain('故意炸掉')
    expect(events[1]?.content).toBe('我还在')
  })

  it('null 与数字这类记录被安静跳过', () => {
    const result = normalizeRecords(
      [
        { value: null, line: 1 },
        { value: 42, line: 2 },
        { value: { role: 'user', content: 'ok' }, line: 3 }
      ],
      context()
    )

    expect(result.events).toHaveLength(2)
    expect(result.skipped).toBe(1)
  })

  it('每个事件都带齐规格要求的字段', () => {
    const [event] = normalize([{ role: 'user', content: '检查字段' }])

    expect(event).toBeDefined()
    expect(typeof event?.id).toBe('string')
    expect(event).toHaveProperty('timestamp')
    expect(event).toHaveProperty('type')
    expect(event).toHaveProperty('title')
    expect(event).toHaveProperty('content')
    expect(event?.sourceFile).toBe('C:\\Users\\demo\\.codex\\sessions\\a.jsonl')
    expect(event).toHaveProperty('workingDirectory')
    expect(Array.isArray(event?.relatedFiles)).toBe(true)
    expect(event).toHaveProperty('success')
    expect(event).toHaveProperty('raw')
  })
})
