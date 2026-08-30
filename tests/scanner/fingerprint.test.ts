import { describe, expect, it } from 'vitest'
import { detectFormat, fingerprintSample } from '../../src/main/scanner/fingerprint'
import { DEFAULT_CONFIDENCE_THRESHOLD } from '../../src/shared/constants'

const CODEX_JSONL = [
  '{"timestamp":"2026-08-24T09:12:03.120Z","type":"session_meta","payload":{"id":"s1","cwd":"C:\\\\demo","instructions":"x"}}',
  '{"timestamp":"2026-08-24T09:12:06.400Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
  '{"timestamp":"2026-08-24T09:12:11.220Z","type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\\"command\\":[\\"bash\\",\\"-lc\\",\\"npm test\\"]}"}}'
].join('\n')

const CODEX_JSON = JSON.stringify(
  {
    session_id: 's2',
    title: '示例',
    working_directory: 'C:\\demo',
    messages: [
      { role: 'user', content: 'hi', timestamp: '2026-08-24T09:00:00Z' },
      { role: 'assistant', content: 'hello', timestamp: '2026-08-24T09:00:10Z' }
    ]
  },
  null,
  2
)

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'demo',
    version: '1.0.0',
    private: true,
    scripts: { build: 'vite build', test: 'vitest run' },
    dependencies: { react: '^19.0.0' },
    devDependencies: { vite: '^7.0.0', typescript: '^5.0.0' }
  },
  null,
  2
)

const TSCONFIG = JSON.stringify(
  { compilerOptions: { target: 'ES2022', strict: true }, include: ['src'] },
  null,
  2
)

describe('格式识别', () => {
  it('多行且每行都是完整 JSON → 判为 jsonl', () => {
    expect(detectFormat(CODEX_JSONL, 'rollout.jsonl')).toBe('jsonl')
    expect(detectFormat(CODEX_JSONL, 'rollout.json')).toBe('jsonl')
  })

  it('缩进过的单个 JSON 对象 → 判为 json', () => {
    expect(detectFormat(CODEX_JSON, 'session.json')).toBe('json')
  })

  it('只有一行时靠扩展名判断', () => {
    expect(detectFormat('{"a":1}', 'x.jsonl')).toBe('jsonl')
    expect(detectFormat('{"a":1}', 'x.json')).toBe('json')
  })

  it('空内容判为 unknown', () => {
    expect(detectFormat('   ', 'x.json')).toBe('unknown')
  })

  it('缩进过的 JSON 数组不会被误判成 jsonl', () => {
    const pretty = '[\n  {"a":1},\n  {"b":2}\n]'
    expect(detectFormat(pretty, 'x.json')).toBe('json')
  })
})

describe('Codex 会话指纹识别', () => {
  it('识别 JSONL 会话，可信度为高', () => {
    const result = fingerprintSample(CODEX_JSONL, 'rollout-2026.jsonl')

    expect(result.format).toBe('jsonl')
    expect(result.confidence).toBe('high')
    expect(result.score).toBeGreaterThan(0.7)
    expect(result.matched.length).toBeGreaterThan(4)
    expect(result.reason).not.toBe('')
  })

  it('识别 JSON 会话', () => {
    const result = fingerprintSample(CODEX_JSON, 'session.json')

    expect(result.format).toBe('json')
    expect(result.score).toBeGreaterThanOrEqual(DEFAULT_CONFIDENCE_THRESHOLD)
    expect(result.matched).toContain('session_id')
    expect(result.matched).toContain('messages')
  })

  it('package.json 得分低于门槛，不会被当成会话', () => {
    const result = fingerprintSample(PACKAGE_JSON, 'package.json')

    expect(result.score).toBeLessThan(DEFAULT_CONFIDENCE_THRESHOLD)
    expect(result.rejected).toContain('devdependencies')
    expect(result.reason).toContain('配置文件')
  })

  it('tsconfig.json 同样被排除', () => {
    const result = fingerprintSample(TSCONFIG, 'tsconfig.json')

    expect(result.score).toBeLessThan(DEFAULT_CONFIDENCE_THRESHOLD)
    expect(result.rejected).toContain('compileroptions')
  })

  it('完全无关的 JSON 得分为 0', () => {
    const result = fingerprintSample('[1, 2, 3, 4, 5]', 'numbers.json')

    expect(result.score).toBe(0)
    expect(result.matched).toEqual([])
    expect(result.reason).toContain('没有出现')
  })

  it('空文件不会崩，得分为 0', () => {
    const result = fingerprintSample('', 'empty.json')
    expect(result.score).toBe(0)
    expect(result.format).toBe('unknown')
  })

  it('出现 role + user/assistant 会额外加分', () => {
    const withRole = fingerprintSample('{"role":"assistant","content":"hi"}', 'a.json')
    const withoutRole = fingerprintSample('{"speaker":"someone","body":"hi"}', 'b.json')

    expect(withRole.score).toBeGreaterThan(withoutRole.score)
    expect(withRole.matched).toContain('role+对话角色')
  })

  it('ISO 时间戳是有效信号', () => {
    const result = fingerprintSample('{"timestamp":"2026-08-24T09:12:03Z","command":"ls"}', 'a.jsonl')
    expect(result.matched).toContain('ISO 时间戳')
  })

  it('得分被限制在 0—1 之间', () => {
    const dense = fingerprintSample(
      JSON.stringify({
        session_id: 'a',
        conversation: [],
        tool_calls: [],
        working_directory: 'x',
        turns: [],
        messages: [],
        events: [],
        assistant: 'x',
        workspace: 'x',
        command: 'x',
        shell: 'x',
        timestamp: '2026-08-24T09:12:03Z',
        role: 'user',
        content: 'x',
        cwd: 'x',
        model: 'x',
        instructions: 'x',
        codex: true
      }),
      'dense.json'
    )

    expect(dense.score).toBeLessThanOrEqual(1)
    expect(dense.score).toBeGreaterThan(0.9)
  })
})
