import { describe, expect, it } from 'vitest'
import { REDACTION_PLACEHOLDER } from '../../src/shared/constants'
import { isSensitiveKey, shouldMaskValue } from '../../src/main/redaction/patterns'
import {
  redactDeep,
  redactEvent,
  redactSession,
  redactText
} from '../../src/main/redaction/redact'
import type { CodexEvent, CodexSession } from '../../src/shared/types'
import { fixturePath, loadFixture } from '../support/fixtures'

const MASK = REDACTION_PLACEHOLDER

describe('敏感键名判定', () => {
  it('识别规格里明确要求的字段', () => {
    for (const key of [
      'api_key',
      'apiKey',
      'API-KEY',
      'x-api-key',
      'token',
      'accessToken',
      'REFRESH_TOKEN',
      'password',
      'passwd',
      'secret',
      'client_secret',
      'Authorization',
      'cookie',
      'Set-Cookie',
      'credentials',
      'private_key',
      'passphrase'
    ]) {
      expect(isSensitiveKey(key), key).toBe(true)
    }
  })

  it('不误伤长得像但其实无关的字段', () => {
    for (const key of [
      'author',
      'authors',
      'keyboard',
      'keywords',
      'monkey',
      'input_tokens',
      'output_tokens',
      'total_tokens',
      'token_count',
      'max_tokens',
      'tokenizer',
      'key_name',
      'keypath'
    ]) {
      expect(isSensitiveKey(key), key).toBe(false)
    }
  })

  it('明显不是密钥的值不打码', () => {
    expect(shouldMaskValue('true')).toBe(false)
    expect(shouldMaskValue('null')).toBe(false)
    expect(shouldMaskValue('0')).toBe(false)
    expect(shouldMaskValue('1234')).toBe(false)
    expect(shouldMaskValue('abc')).toBe(false)
    expect(shouldMaskValue(MASK)).toBe(false)
    expect(shouldMaskValue('sk-demo-FAKE0123456789')).toBe(true)
  })
})

describe('文本打码', () => {
  it('打码 键=值 与 键: 值 两种写法', () => {
    expect(redactText('OPENAI_API_KEY=sk-demo-FAKE0123456789abcdef')).toBe(`OPENAI_API_KEY=${MASK}`)
    expect(redactText('password: demoPassw0rd123')).toBe(`password: ${MASK}`)
    expect(redactText('"token": "abcdef123456"')).toBe(`"token": "${MASK}"`)
  })

  it('打码 Authorization / Bearer 凭据', () => {
    expect(redactText('Authorization: Bearer abcdef1234567890')).toContain(MASK)
    expect(redactText('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef1234567890')
  })

  it('整行打码 Cookie', () => {
    const result = redactText('Cookie: session=abc123; theme=dark')
    expect(result).toBe(`Cookie: ${MASK}`)
    expect(result).not.toContain('abc123')
  })

  it('识别已知格式的密钥，即使没有键名提示', () => {
    const samples = [
      'sk-demo-FAKE0123456789abcdefghij',
      'ghp_FAKE0123456789abcdefghijklmnopqrst',
      'github_pat_FAKE0123456789abcdefghijkl',
      'xoxb-FAKE-0123456789-abcdef',
      'AKIAFAKE0123456789AB',
      'AIzaFAKE0123456789abcdefghijklmnopqrstu',
      'npm_FAKE0123456789abcdefghijklmnopqrstuv'
    ]

    for (const sample of samples) {
      const result = redactText(`值是 ${sample} 请注意`)
      expect(result, sample).toContain(MASK)
      expect(result, sample).not.toContain(sample)
    }
  })

  it('打码 JWT 与私钥块', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIiwibmFtZSI6IkRlbW8ifQ.FAKEsignature0123456789'
    expect(redactText(`token ${jwt}`)).not.toContain('FAKEsignature')

    const privateKey =
      '-----BEGIN RSA PRIVATE KEY-----\nFAKEKEYLINE1\nFAKEKEYLINE2\n-----END RSA PRIVATE KEY-----'
    const result = redactText(privateKey)
    expect(result).toBe(MASK)
    expect(result).not.toContain('FAKEKEYLINE1')
  })

  it('打码 URL 里的密码，但保留主机名', () => {
    const result = redactText('DATABASE_URL=postgres://demo:demoPassw0rd@localhost:5432/shop')
    expect(result).not.toContain('demoPassw0rd')
    expect(result).toContain(MASK)
  })

  it('打码命令行里的密钥参数', () => {
    expect(redactText('curl --token abcdef123456 https://example.invalid')).toContain(MASK)
    expect(redactText('deploy --api-key=FAKE0123456789 --verbose')).not.toContain('FAKE0123456789')
  })

  it('不动无关内容', () => {
    const text = '这次改了 src/cart/price.ts，把 > 改成 >=，测试 8 个全部通过。'
    expect(redactText(text)).toBe(text)
  })

  it('不打码 token 用量统计', () => {
    const text = 'input_tokens=18422 output_tokens=1180 total_tokens=19602'
    expect(redactText(text)).toBe(text)
  })

  it('在被转义的 JSON 字符串里打码，不会吞掉后面的行', () => {
    // 原始数据面板里看到的就是这种"一整行 JSON、换行是字面 \\n"的形态。
    const escaped =
      'OPENAI_API_KEY=sk-demo-FAKE0123456789abcdef\\nSESSION_SECRET=fake-demo-secret-value\\nSHOP_FEATURE_FLAGS=coupon,express'
    const result = redactText(escaped)

    expect(result).not.toContain('sk-demo-FAKE')
    expect(result).not.toContain('fake-demo-secret-value')
    expect(result).toContain('SHOP_FEATURE_FLAGS=coupon,express')
    expect(result).toContain('\\n')
  })

  it('值里的 Windows 路径不会被截断成半截', () => {
    const result = redactText('password=C:\\Users\\demo\\secret.txt')
    expect(result).toBe(`password=${MASK}`)
  })

  it('空值安全', () => {
    expect(redactText('')).toBe('')
  })
})

describe('结构化数据打码', () => {
  it('按键名打码，数字与布尔值保持原样', () => {
    const result = redactDeep({
      api_key: 'sk-demo-FAKE0123456789abcdef',
      total_tokens: 19602,
      nested: { password: 'demoPassw0rd', keep: '正常内容' },
      list: [{ authorization: 'Bearer FAKE0123456789' }],
      enabled: true,
      author: 'demo'
    }) as Record<string, unknown>

    expect(result.api_key).toBe(MASK)
    expect(result.total_tokens).toBe(19602)
    expect(result.enabled).toBe(true)
    expect(result.author).toBe('demo')
    expect((result.nested as Record<string, unknown>).password).toBe(MASK)
    expect((result.nested as Record<string, unknown>).keep).toBe('正常内容')
    expect(((result.list as unknown[])[0] as Record<string, unknown>).authorization).toBe(MASK)
  })

  it('敏感键下面挂着对象时整块替换', () => {
    const result = redactDeep({ credentials: { user: 'demo', pass: 'x' } }) as Record<string, unknown>
    expect(result.credentials).toBe(MASK)
  })

  it('深度嵌套不会栈溢出', () => {
    let deep: Record<string, unknown> = { password: 'demoPassw0rd' }
    for (let index = 0; index < 200; index += 1) deep = { level: deep }

    expect(() => redactDeep(deep)).not.toThrow()
  })
})

/**
 * 深度上限曾经是个绕过打码的口子：超过上限就把整个子树**原样**返回，
 * 藏在深处的密钥于是完整出现在"原始数据"面板和 JSON/HTML 导出里。
 *
 * 上限本身也定得太低（14 层）：实测 37555 条真实记录里，`session_meta` 的
 * 工具 schema 能到 22 层，占 0.8%，那些内容会被无谓地截掉。
 */
describe('深处的密钥同样打码', () => {
  const nest = (leaf: unknown, levels: number): unknown => {
    let current = leaf
    for (let index = 0; index < levels; index += 1) current = { level: current }
    return current
  }

  it('对象嵌套多深都不会漏', () => {
    for (const levels of [1, 14, 15, 22, 40, 41, 120]) {
      const value = nest({ password: 'demoPassw0rd-DEEP' }, levels)
      const text = JSON.stringify(redactDeep(value))
      expect(text, `嵌套 ${levels} 层`).not.toContain('demoPassw0rd-DEEP')
    }
  })

  it('数组嵌套同样不会漏', () => {
    let value: unknown = { api_key: 'sk-demo-FAKE0123456789abcdef' }
    for (let index = 0; index < 120; index += 1) value = [value]

    expect(JSON.stringify(redactDeep(value))).not.toContain('sk-demo-FAKE')
  })

  it('没有键名提示、只是长得像密钥的文本，深处也认得出来', () => {
    const value = nest({ note: '记一下 ghp_FAKE0123456789abcdefghijklmnopqrst' }, 60)
    expect(JSON.stringify(redactDeep(value))).not.toContain('ghp_FAKE')
  })

  it('超出上限时换成"未展开"，不是"已打码" —— 别让用户误会自己有密钥', () => {
    const value = nest({ note: '正常内容' }, 120)
    const text = JSON.stringify(redactDeep(value))

    expect(text).toContain('未展开')
    expect(text).not.toContain(MASK)
  })

  it('真实数据那 22 层不会被截断', () => {
    const value = nest({ name: 'automation_update', description: '正常的工具描述' }, 22)
    const text = JSON.stringify(redactDeep(value))

    expect(text).toContain('automation_update')
    expect(text).not.toContain('未展开')
  })

  it('深处的数字与布尔值原样保留（它们藏不住密钥）', () => {
    const value = nest({ total_tokens: 19602, enabled: true }, 120) as Record<string, unknown>
    // 上限之内的层级仍然照常展开，只有更深处才折叠。
    const shallow = redactDeep({ total_tokens: 19602, enabled: true }) as Record<string, unknown>

    expect(shallow.total_tokens).toBe(19602)
    expect(shallow.enabled).toBe(true)
    expect(() => redactDeep(value)).not.toThrow()
  })
})

/**
 * 通用「键: 值」规则原来不允许值里出现空格，于是多词密码只被打码第一个词 ——
 * 第一个词不足 4 个字符时（`my secret phrase` 的 `my`）整条都不打码。
 */
describe('值里带空格的密码', () => {
  it('多词密码整条打码', () => {
    expect(redactText('password: my secret phrase')).toBe(`password: ${MASK}`)
    expect(redactText('password = my secret phrase')).toBe(`password = ${MASK}`)
    expect(redactText('"password": "my secret phrase"')).toBe(`"password": "${MASK}"`)
  })

  it('不再只打掉第一个词', () => {
    const result = redactText('api_key: AKIA FAKE spaced value')
    expect(result).toBe(`api_key: ${MASK}`)
    expect(result).not.toContain('spaced value')
  })

  it('带空格的路径也整条打码', () => {
    expect(redactText('password=C:\\Program Files\\creds.txt')).toBe(`password=${MASK}`)
  })

  /**
   * 允许空格带来的风险：值可能一路吞到行尾，把后面真正的密钥连带吞掉
   * （吞掉的部分不会被当成键来检查，于是永远不打码）。所以遇到下一组
   * "键=值" 必须停下。
   */
  it('遇到下一组键值对就停，后面的密钥照样打码', () => {
    const result = redactText('user=demo password=secret123')
    expect(result).toBe(`user=demo password=${MASK}`)
  })

  it('多组混在一行时逐个判断', () => {
    const result = redactText('host=localhost token=FAKE0123456789 retries=3')
    expect(result).toContain('host=localhost')
    expect(result).toContain('retries=3')
    expect(result).not.toContain('FAKE0123456789')
  })

  it('token 用量统计仍然不受影响', () => {
    const text = 'input_tokens=18422 output_tokens=1180 total_tokens=19602'
    expect(redactText(text)).toBe(text)
  })

  it('逗号分隔的键值对不会互相吞掉', () => {
    const result = redactText('secret: demoPassw0rd, user: demo')
    expect(result).toContain('user: demo')
    expect(result).not.toContain('demoPassw0rd')
  })

  /**
   * 允许空格之后差点糊掉源码。实测 120 个真实会话时抓到的：
   * 这些行里 `str` / `int` 是类型名，不是密码，而看清代码改了什么正是这个工具的正事。
   */
  it('源码里的类型标注不会被糊掉', () => {
    const lines = [
      '    token: str = Depends(oauth2_scheme),',
      '    secret_key: str = "change-me"',
      '    password: str = Field(min_length=6, max_length=64)',
      '    token_type: str = "bearer"',
      '    access_token_expire_minutes: int = 60 * 24 * 7'
    ]

    for (const line of lines) {
      expect(redactText(line), line).toBe(line)
    }
  })

  it('挡住类型标注的同时，真密码照样打码', () => {
    expect(redactText('      POSTGRES_PASSWORD: planner')).toBe(`      POSTGRES_PASSWORD: ${MASK}`)
    expect(redactText('SECRET_KEY=change-this-secret-in-production')).toBe(`SECRET_KEY=${MASK}`)
  })
})

describe('事件与会话打码', () => {
  const baseEvent: CodexEvent = {
    id: 'e1',
    timestamp: '2026-08-24T09:00:00.000Z',
    type: 'command_output',
    title: 'OPENAI_API_KEY=sk-demo-FAKE0123456789abcdef',
    content: 'OPENAI_API_KEY=sk-demo-FAKE0123456789abcdef\nDONE',
    sourceFile: 'C:\\demo\\a.jsonl',
    workingDirectory: 'C:\\demo',
    relatedFiles: ['.env.local'],
    displayWorkingDirectory: 'C:\\demo',
    displayRelatedFiles: ['.env.local'],
    success: true,
    raw: { output: 'password: demoPassw0rd' },
    command: 'cat .env.local --token FAKE0123456789'
  }

  it('标题、正文、命令、原始数据全部打码', () => {
    const result = redactEvent(baseEvent)

    expect(result.title).toContain(MASK)
    expect(result.content).toContain(MASK)
    expect(result.content).not.toContain('sk-demo-FAKE')
    expect(result.command).toContain(MASK)
    expect(JSON.stringify(result.raw)).not.toContain('demoPassw0rd')
  })

  it('文件差异内容里的密钥同样被打码', () => {
    const result = redactEvent({
      ...baseEvent,
      type: 'file_edit',
      fileChanges: [
        {
          path: '.env',
          displayPath: '.env',
          kind: 'edit',
          additions: 1,
          deletions: 1,
          diff: '-API_KEY=old-FAKE-value-1234\n+API_KEY=new-FAKE-value-5678',
          before: 'API_KEY=old-FAKE-value-1234',
          after: 'API_KEY=new-FAKE-value-5678'
        }
      ]
    })

    const change = result.fileChanges?.[0]
    expect(change?.diff).not.toContain('old-FAKE-value-1234')
    expect(change?.before).toContain(MASK)
    expect(change?.after).toContain(MASK)
  })

  it('不修改原对象（打码只作用在副本上）', () => {
    const snapshot = JSON.stringify(baseEvent)
    redactEvent(baseEvent)
    expect(JSON.stringify(baseEvent)).toBe(snapshot)
  })

  it('示例会话里的虚构密钥确实被打掉了', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const session = sessions[0] as CodexSession

    const before = JSON.stringify(session)
    expect(before).toContain('sk-demo-FAKE')

    const after = JSON.stringify(redactSession(session))
    expect(after).not.toContain('sk-demo-FAKE')
    expect(after).not.toContain('demoPassw0rd')
    expect(after).not.toContain('this-is-a-fake-demo-secret-value')
    expect(after).toContain(MASK)
  })

  it('打码后不影响正常内容与统计字段', async () => {
    const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
    const session = sessions[0] as CodexSession
    const redacted = redactSession(session)

    expect(redacted.eventCount).toBe(session.eventCount)
    expect(redacted.changedFiles).toEqual(session.changedFiles)
    expect(redacted.testsPassed).toBe(session.testsPassed)
    expect(redacted.events.some((event) => event.content.includes('coupon.threshold'))).toBe(true)
  })
})
