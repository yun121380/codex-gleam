import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionLibrary } from '../../src/main/library'
import { LocalStore } from '../../src/main/storage/store'
import type { FileSystemAccess } from '../../src/main/scanner/fsAccess'
import { createFakeFs } from '../support/fakeFs'

/**
 * 「显示完整路径」这个开关，在**数据离开主进程的那一刻**生效。
 *
 * 上面那些 maskPaths 的单元测试证明了转换本身对不对；这里证明它真的接上了 ——
 * 界面拿到的会话、拿到的列表，里面确实没有用户名。原来这件事是靠界面自己
 * 挑 display 字段，于是漏一个字段就漏一处。
 */

const HOME = 'C:\\Users\\alice'
const ROOT = `${HOME}\\.codex`

/** 一份路径长在各处的会话：用户消息里、命令里、命令输出里都有。 */
function leakySession(): string {
  return [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: 's-leaky',
        cwd: `${HOME}\\proj`,
        timestamp: '2026-08-28T10:00:00.000Z'
      }
    }),
    JSON.stringify({
      timestamp: '2026-08-28T10:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `帮我改一下 ${HOME}\\proj\\src\\a.ts` }]
      }
    }),
    JSON.stringify({
      timestamp: '2026-08-28T10:00:02.000Z',
      type: 'exec_command_begin',
      payload: { call_id: 'c1', command: `cat ${HOME}\\.ssh\\config` }
    }),
    JSON.stringify({
      timestamp: '2026-08-28T10:00:03.000Z',
      type: 'exec_command_end',
      payload: {
        call_id: 'c1',
        exit_code: 1,
        stdout: `cat: ${HOME}\\.ssh\\config: No such file`
      }
    })
  ].join('\n')
}

let storeDir: string

async function makeLibrary(): Promise<SessionLibrary> {
  const fs: FileSystemAccess = createFakeFs({ [`${ROOT}\\a.jsonl`]: leakySession() })
  const library = new SessionLibrary({
    store: new LocalStore(storeDir),
    fs,
    platform: 'win32',
    env: { USERPROFILE: HOME },
    homeDir: HOME,
    sampleDir: null
  })
  await library.init()
  await library.updateSettings({ useBuiltinDirs: false, extraScanDirs: [ROOT] })
  await library.scan(undefined, () => {})
  return library
}

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'gleam-display-'))
})

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true })
})

describe('关闭「显示完整路径」时（默认）', () => {
  it('会话列表里的标题不含用户名', async () => {
    const library = await makeLibrary()
    const sessions = await library.listSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.title).toContain('~\\proj\\src\\a.ts')
    expect(sessions[0]?.title).not.toContain('alice')
  })

  it('打开的会话里，所有文字都不含用户名', async () => {
    const library = await makeLibrary()
    const [summary] = await library.listSessions()
    const detail = await library.getSession(summary!.id)

    const texts = (detail?.events ?? []).flatMap((event) => [
      event.title,
      event.content,
      event.command ?? ''
    ])

    expect(texts.length).toBeGreaterThan(3)
    for (const text of texts) expect(text).not.toContain('alice')
    expect(texts.some((text) => text.includes('~\\.ssh\\config'))).toBe(true)
  })

  it('命令输出正文也处理过（原来正是这里在漏）', async () => {
    const library = await makeLibrary()
    const [summary] = await library.listSessions()
    const detail = await library.getSession(summary!.id)

    const output = detail?.events.find((event) => event.type === 'command_output')
    expect(output).toBeDefined()
    expect(output?.content).toContain('~\\.ssh\\config')
    expect(output?.content).not.toContain('alice')
  })

  /*
   * 反过来的那一半，同样要盯死：路径字段必须原样送到界面，
   * 否则「在文件管理器中定位」就成了摆设。
   */
  it('但用来定位文件的路径字段仍然是真实路径', async () => {
    const library = await makeLibrary()
    const [summary] = await library.listSessions()
    const detail = await library.getSession(summary!.id)

    expect(summary?.sourceFile).toBe(`${ROOT}\\a.jsonl`)
    expect(detail?.sourceFile).toBe(`${ROOT}\\a.jsonl`)
    expect(detail?.events[0]?.workingDirectory).toBe(`${HOME}\\proj`)
  })
})

describe('打开「显示完整路径」时', () => {
  it('原样交给界面，一个字都不改', async () => {
    const library = await makeLibrary()
    await library.updateSettings({ showFullPaths: true })

    const [summary] = await library.listSessions()
    const detail = await library.getSession(summary!.id)

    expect(summary?.title).toContain(`${HOME}\\proj\\src\\a.ts`)
    expect(detail?.events.some((event) => (event.command ?? '').includes(HOME))).toBe(true)
  })
})
