import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionLibrary } from '../../src/main/library'
import { LocalStore } from '../../src/main/storage/store'
import type { FileSystemAccess } from '../../src/main/scanner/fsAccess'
import { createFakeFs } from '../support/fakeFs'

/**
 * 点开一个会话时会重新解析它所在的文件。这里盯住两件事：
 *   - 一个文件里装了很多个会话时，任意一个都要打得开；
 *   - 真的打不开时，那条索引要消失，而不是留在列表里等着再报一次错。
 */

const ROOT = 'C:\\Users\\demo\\.codex'

/** 一个文件里装 n 个会话：Codex 的状态文件实测能装 70 个。 */
function manySessions(count: number): string {
  const lines: string[] = []
  for (let index = 1; index <= count; index += 1) {
    lines.push(
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: `s-${index}`,
          cwd: `C:\\Users\\demo\\projects\\proj-${index}`,
          timestamp: '2026-08-28T10:00:00.000Z'
        }
      }),
      JSON.stringify({
        timestamp: '2026-08-28T10:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `第 ${index} 个会话的要求` }]
        }
      })
    )
  }
  return lines.join('\n')
}

let storeDir: string

async function makeLibrary(fs: FileSystemAccess): Promise<SessionLibrary> {
  const library = new SessionLibrary({
    store: new LocalStore(storeDir),
    fs,
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\demo' },
    homeDir: 'C:\\Users\\demo',
    sampleDir: null
  })
  await library.init()
  await library.updateSettings({ useBuiltinDirs: false, extraScanDirs: [ROOT] })
  return library
}

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'gleam-open-'))
})

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true })
})

describe('一个文件里有很多会话时逐个打开', () => {
  /**
   * 实测踩到的坑：会话缓存上限是 3，而打开流程会把整份文件解析出的会话
   * 全塞进缓存再去取想要的那一个 —— 文件里超过 3 个会话时，
   * 除了最后 3 个以外全都取不到，界面于是报"原始文件可能已被移动或删除"，
   * 而文件其实一直都在。
   */
  it('20 个会话，每一个都打得开', async () => {
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\many.jsonl`]: manySessions(20) }))
    const scanned = await library.scan(undefined, () => {})
    expect(scanned.sessions).toHaveLength(20)

    const failed: string[] = []
    for (const summary of scanned.sessions) {
      const detail = await library.getSession(summary.id)
      if (detail === null) failed.push(summary.title)
    }

    expect(failed).toEqual([])
  })

  it('打开的确实是点中的那一个，不是碰巧留在缓存里的别人', async () => {
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\many.jsonl`]: manySessions(20) }))
    const scanned = await library.scan(undefined, () => {})

    for (const summary of scanned.sessions.slice(0, 6)) {
      const detail = await library.getSession(summary.id)
      expect(detail?.id).toBe(summary.id)
      expect(detail?.title).toBe(summary.title)
    }
  })

  it('反复打开同一个也稳定（缓存命中路径）', async () => {
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\many.jsonl`]: manySessions(20) }))
    const scanned = await library.scan(undefined, () => {})
    const first = scanned.sessions[0]!

    for (let round = 0; round < 3; round += 1) {
      const detail = await library.getSession(first.id)
      expect(detail?.id).toBe(first.id)
    }
  })
})

describe('打不开的条目要从列表里消失', () => {
  it('原文件没了以后，那条索引被删掉', async () => {
    const content = manySessions(2)
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\gone.jsonl`]: content }))
    const scanned = await library.scan(undefined, () => {})
    expect(scanned.sessions).toHaveLength(2)

    const target = scanned.sessions[0]!

    // 换一个"文件已经不在"的文件系统，但沿用同一个 store（模拟应用还开着、文件被删了）。
    const afterDelete = await makeLibrary(createFakeFs({ [`${ROOT}\\other.txt`]: 'x' }))
    expect(await afterDelete.getSession(target.id)).toBeNull()

    const left = await afterDelete.listSessions()
    expect(left.map((summary) => summary.id)).not.toContain(target.id)
  })

  it('只忘掉出问题的那个文件，别的文件不受影响', async () => {
    const good = manySessions(2)
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\bad.jsonl`]: manySessions(3), [`${ROOT}\\good.jsonl`]: good })
    )
    const scanned = await library.scan(undefined, () => {})
    const target = scanned.sessions.find((summary) => summary.sourceFile.endsWith('bad.jsonl'))!
    const goodIds = scanned.sessions
      .filter((summary) => summary.sourceFile.endsWith('good.jsonl'))
      .map((summary) => summary.id)
    expect(goodIds.length).toBeGreaterThan(0)

    // 只有 bad.jsonl 不见了。
    const changed = await makeLibrary(createFakeFs({ [`${ROOT}\\good.jsonl`]: good }))
    expect(await changed.getSession(target.id)).toBeNull()

    const left = await changed.listSessions()
    const leftIds = left.map((summary) => summary.id)
    // bad.jsonl 的条目整份清掉，good.jsonl 的一个都不少。
    expect(leftIds.filter((id) => goodIds.includes(id)).sort()).toEqual([...goodIds].sort())
    expect(left.every((summary) => !summary.sourceFile.endsWith('bad.jsonl'))).toBe(true)
  })

  it('删掉的是索引条目，不是用户主动删除 —— 文件回来后还能重新收录', async () => {
    const content = manySessions(2)
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\back.jsonl`]: content }))
    const scanned = await library.scan(undefined, () => {})
    const target = scanned.sessions[0]!

    const missing = await makeLibrary(createFakeFs({ [`${ROOT}\\other.txt`]: 'x' }))
    expect(await missing.getSession(target.id)).toBeNull()

    // 文件又回来了，重新扫描应当再次收录它。
    const restored = await makeLibrary(createFakeFs({ [`${ROOT}\\back.jsonl`]: content }))
    const rescanned = await restored.scan(undefined, () => {})

    expect(rescanned.sessions.map((summary) => summary.id)).toContain(target.id)
  })
})
