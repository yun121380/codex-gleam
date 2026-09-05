import { describe, expect, it } from 'vitest'
import { buildResumeCommand, defaultResumeTemplate } from '../../src/renderer/lib/resumeCommand'
import type { Platform } from '../../src/shared/types'

/**
 * resume 命令的模板填充。
 *
 * 这串字符最终会被粘进终端并回车，所以这里的每一条都是"粘出去会发生什么"：
 * 拼错了不是显示错误，是执行错误的东西。
 */

function build(overrides: {
  template?: string
  platform?: Platform
  dir?: string | null
  threadId?: string | null
}) {
  return buildResumeCommand({
    template: overrides.template ?? '',
    platform: overrides.platform ?? 'win32',
    dir: overrides.dir === undefined ? 'C:\\projects\\demo' : overrides.dir,
    threadId: overrides.threadId === undefined ? 'abc-123' : overrides.threadId
  })
}

describe('平台默认模板', () => {
  /*
   * 设计稿里写的是 POSIX 的 `cd -- {dir}`。cmd.exe 不认 `--`，
   * 而且不带 `/d` 时不跨盘符 —— 项目在 D: 而终端在 C: 时那条命令一声不响地留在原地。
   * 默认值必须在本机直接可用。
   */
  it('Windows 上用 cd /d，不带 --', () => {
    const template = defaultResumeTemplate('win32')
    expect(template).toContain('cd /d')
    expect(template).not.toContain('--')
  })

  it('macOS 与 Linux 上用 cd --', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(defaultResumeTemplate(platform)).toContain('cd --')
    }
  })

  it('三个平台都把 {dir} 放在引号里', () => {
    // 路径里有空格是常态（"Application Support"、"Desktop\我的 项目"）。
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(defaultResumeTemplate(platform)).toContain('"{dir}"')
    }
  })
})

describe('拼命令', () => {
  it('两个占位符都被填上', () => {
    const result = build({ dir: 'D:\\work\\shop', threadId: 'sess-7' })

    expect(result.ok).toBe(true)
    expect(result.ok && result.command).toBe('cd /d "D:\\work\\shop" && codex resume sess-7')
  })

  it('自定义模板照用', () => {
    const result = build({ template: 'codex resume {threadId} # in {dir}' })

    expect(result.ok && result.command).toBe('codex resume abc-123 # in C:\\projects\\demo')
  })

  it('模板留空或全是空格时回落到平台默认', () => {
    expect(build({ template: '', platform: 'linux' }).ok).toBe(true)
    expect(build({ template: '   ', platform: 'linux' })).toEqual(
      build({ template: 'cd -- "{dir}" && codex resume {threadId}', platform: 'linux' })
    )
  })

  it('同一个占位符出现两次，两处都替换', () => {
    const result = build({ template: '{threadId} {threadId}', threadId: 'x1' })
    expect(result.ok && result.command).toBe('x1 x1')
  })

  /** 我们只认识两个占位符，其它 `{…}` 是用户自己的字面文本，不许动、也不许报错。 */
  it('不认识的占位符原样留着', () => {
    const result = build({ template: 'echo {foo} {threadId}' })
    expect(result.ok && result.command).toBe('echo {foo} abc-123')
  })
})

describe('填进去的值不许改变命令的结构', () => {
  /*
   * 一次正则扫完、且用函数形式替换，这两条都是为了这里的三种情况。
   * 逐个 replaceAll 会让先填进去的值被第二轮再解释一次；
   * 字符串形式的替换会让值里的 `$&` 变成特殊记法。
   */
  it('值里含 $& 时原样出现，不被当成替换记法', () => {
    const result = build({ dir: 'C:\\a$&b' })
    expect(result.ok && result.command).toContain('C:\\a$&b')
  })

  it('值里含 {threadId} 字面量时不被二次替换', () => {
    const result = build({ dir: 'C:\\{threadId}', threadId: 'real-id' })

    expect(result.ok && result.command).toBe('cd /d "C:\\{threadId}" && codex resume real-id')
  })

  /** 路径里一个换行就把一行命令劈成两条，第二条是什么全看路径长什么样。 */
  it('控制字符被剥掉，拼出来的命令只有一行', () => {
    const result = build({ dir: 'C:\\a\nrm -rf /\tb\r\u0000c' })

    expect(result.ok).toBe(true)
    expect(result.ok && result.command).toBe('cd /d "C:\\arm -rf /bc" && codex resume abc-123')
    expect(result.ok && result.command.includes('\n')).toBe(false)
  })

  /** 剥完只剩空串的话，那就是没有这个值 —— 不能拼出一条 `cd ""`。 */
  it('值只由控制字符组成时当缺失处理', () => {
    const result = build({ dir: '\n\t ' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('项目目录')
  })
})

describe('拼不出来就说拼不出来', () => {
  it('缺会话 id 时不给半成品命令', () => {
    const result = build({ threadId: null })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('会话 id')
    expect(result.detail).toContain('session_id')
    // 关键：占位符不能原样留在命令里让人拿去跑。
    expect(JSON.stringify(result)).not.toContain('{threadId}')
  })

  it('缺项目目录时也不给', () => {
    const result = build({ dir: null })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('项目目录')
  })

  it('两个都缺时两句都给', () => {
    const result = build({ dir: null, threadId: null })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('会话 id')
    expect(result.reason).toContain('项目目录')
  })

  /**
   * 只挡模板真的用得到的。
   * 用户把 `cd` 那一段删掉之后，会话没记项目目录就不该再挡着他复制。
   */
  it('缺的值模板没用到时照样拼得出来', () => {
    const result = build({ template: 'codex resume {threadId}', dir: null })

    expect(result.ok).toBe(true)
    expect(result.ok && result.command).toBe('codex resume abc-123')
  })
})
