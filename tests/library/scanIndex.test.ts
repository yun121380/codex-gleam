import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionLibrary } from '../../src/main/library'
import { LocalStore } from '../../src/main/storage/store'
import type { FileSystemAccess } from '../../src/main/scanner/fsAccess'
import { createFakeFs } from '../support/fakeFs'

/**
 * 索引维护的行为测试。
 *
 * 重点是三件事：
 *   - 重新扫描能发现新文件；
 *   - 原文件被删除后，索引里的会话也要消失；
 *   - 但用户手动导入、位于扫描范围之外的会话不能被误删。
 */

const ROOT = 'C:\\Users\\demo\\.codex'

function sessionContent(sessionId: string, project: string, text: string): string {
  return [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: sessionId,
        cwd: `C:\\Users\\demo\\projects\\${project}`,
        timestamp: '2026-08-28T10:00:00.000Z'
      }
    }),
    JSON.stringify({
      timestamp: '2026-08-28T10:00:05.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    })
  ].join('\n')
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
  storeDir = await mkdtemp(join(tmpdir(), 'gleam-test-'))
})

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true })
})

describe('重新扫描维护索引', () => {
  it('第一次扫描收录全部会话', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
      [`${ROOT}\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
    })

    const library = await makeLibrary(fs)
    const result = await library.scan(undefined, () => {})

    expect(result.sessions).toHaveLength(2)
    expect(result.sessions.map((s) => s.projectName).sort()).toEqual(['proj-a', 'proj-b'])
  })

  it('新增文件在下次扫描时被发现', async () => {
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A') })
    )
    expect((await library.scan(undefined, () => {})).sessions).toHaveLength(1)

    const grown = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
        [`${ROOT}\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
      })
    )
    expect((await grown.scan(undefined, () => {})).sessions).toHaveLength(2)
  })

  it('文件被删除后，它的会话从索引里消失', async () => {
    // 第一次：两个文件都在。
    const library = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
        [`${ROOT}\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
      })
    )
    expect((await library.scan(undefined, () => {})).sessions).toHaveLength(2)

    // 第二次：b.jsonl 已被删除（同一个 store，模拟用户重新扫描）。
    const afterDelete = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A') })
    )
    const result = await afterDelete.scan(undefined, () => {})

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.projectName).toBe('proj-a')
  })

  it('扫描范围之外的会话不会被误删', async () => {
    // 先手动导入一个放在别处的文件。
    const outsidePath = 'D:\\backup\\old-session.jsonl'
    const library = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
        [outsidePath]: sessionContent('s-out', 'proj-outside', '这是外面导入的')
      })
    )

    const imported = await library.importFiles([outsidePath])
    expect(imported.sessions).toHaveLength(1)

    // 再扫描 .codex —— 外面那个文件不在扫描范围内，必须留着。
    const result = await library.scan(undefined, () => {})
    const projects = result.sessions.map((s) => s.projectName).sort()

    expect(projects).toEqual(['proj-a', 'proj-outside'])
  })

  it('文件内容变了以后，旧会话条目被替换而不是叠加', async () => {
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: sessionContent('s-old', 'proj-a', '旧内容') })
    )
    const first = await library.scan(undefined, () => {})
    expect(first.sessions).toHaveLength(1)

    // 同一路径、不同大小与修改时间、里面换成了另一个会话 id。
    const changed = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: {
          content: sessionContent('s-new', 'proj-a', '换成了全新的内容，长度也不一样'),
          mtimeMs: Date.UTC(2026, 7, 29, 12, 0, 0)
        }
      })
    )
    const second = await changed.scan(undefined, () => {})

    expect(second.sessions).toHaveLength(1)
    expect(second.sessions[0]?.title).toContain('换成了全新的内容')
  })

  it('取消扫描时不删任何东西（信息不完整，宁可保守）', async () => {
    const library = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
        [`${ROOT}\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
      })
    )
    expect((await library.scan(undefined, () => {})).sessions).toHaveLength(2)

    // 文件都还在，但扫描一开始就被取消。
    const cancelled = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
        [`${ROOT}\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
      })
    )
    const scanPromise = cancelled.scan(undefined, () => {
      cancelled.cancelScan()
    })
    const result = await scanPromise

    expect(result.cancelled).toBe(true)
    expect(result.sessions.length).toBeGreaterThanOrEqual(2)
  })

  /**
   * 扫描必须在主进程里防重入。界面上禁用按钮挡不住：列表右上角的刷新、
   * 空状态里的"开始自动扫描"、"选择文件夹"走的都是各自的入口，IPC 也能被同时调两次。
   * 两次扫描同时跑会互相踩 —— 共用一个取消令牌、各自基于同一份旧索引，
   * 最后完成的把先完成的整份覆盖掉。
   */
  it('同一个请求并发调用时只跑一次，两边拿到同一个结果', async () => {
    const library = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
        [`${ROOT}\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
      })
    )

    const [first, second] = await Promise.all([
      library.scan(undefined, () => {}),
      library.scan(undefined, () => {})
    ])

    // 复用同一次扫描：连返回对象都是同一个。
    expect(second).toBe(first)
    expect(first.sessions).toHaveLength(2)
  })

  it('并发扫描不会把索引搞乱', async () => {
    const library = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
        [`${ROOT}\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
      })
    )

    await Promise.all(Array.from({ length: 5 }, () => library.scan(undefined, () => {})))

    const sessions = await library.listSessions()
    expect(sessions.map((summary) => summary.projectName).sort()).toEqual(['proj-a', 'proj-b'])
  })

  it('要扫的地方不一样时明确拒绝，而不是悄悄拿另一次的结果糊弄', async () => {
    const library = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
        'D:\\elsewhere\\c.jsonl': sessionContent('s-c', 'proj-c', '别处的会话')
      })
    )

    const full = library.scan(undefined, () => {})
    const conflicting = await library.scan({ roots: ['D:\\elsewhere'], merge: true }, () => {})

    expect(conflicting.cancelled).toBe(true)
    expect(conflicting.issues.map((issue) => issue.kind)).toEqual(['busy'])
    expect(conflicting.issues[0]?.reason).toContain('上一次扫描还在进行')

    // 被拒绝的那次不该动索引，正在跑的那次照常完成。
    await expect(full).resolves.toBeTruthy()
  })

  it('一次扫描结束后可以正常发起下一次', async () => {
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A') })
    )

    await library.scan(undefined, () => {})
    const second = await library.scan(undefined, () => {})

    expect(second.issues.map((issue) => issue.kind)).not.toContain('busy')
    expect(second.sessions).toHaveLength(1)
  })

  /**
   * 「这个文件在不在扫描范围内」原来是拿 startsWith 判断的，
   * 于是扫描 `C:\foo` 时 `C:\foobar\old.jsonl` 也算"在范围内、但这次没扫到"，
   * 索引条目就被无辜删掉了。
   */
  it('名字前缀相同的兄弟目录不会被误删', async () => {
    const inside = 'C:\\foo\\inside.jsonl'
    const sibling = 'C:\\foobar\\old.jsonl'

    const library = await makeLibrary(
      createFakeFs({
        [inside]: sessionContent('s-in', 'proj-inside', '范围内'),
        [sibling]: sessionContent('s-sib', 'proj-sibling', '兄弟目录')
      })
    )
    await library.updateSettings({ useBuiltinDirs: false, extraScanDirs: ['C:\\foo'] })

    // 先把兄弟目录里的那个手动导入进来。
    const imported = await library.importFiles([sibling])
    expect(imported.sessions).toHaveLength(1)

    // 再扫 C:\foo —— 兄弟目录不在扫描范围内，必须留着。
    const result = await library.scan(undefined, () => {})
    const projects = result.sessions.map((summary) => summary.projectName).sort()

    expect(projects).toEqual(['proj-inside', 'proj-sibling'])
  })

  /*
   * 下面这一组都是同一个毛病的不同长相：扫描**没看清**，却按"没看到就是没了"
   * 把索引条目删了。原来的判据只有 result.cancelled，可扫描半途而废的方式远不止取消。
   */
  describe('扫描没看清的地方不许删', () => {
    it('目录读不动时，它底下的条目留着', async () => {
      const files = {
        [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
        [`${ROOT}\\sub\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
      }
      const library = await makeLibrary(createFakeFs(files))
      expect((await library.scan(undefined, () => {})).sessions).toHaveLength(2)

      // 文件一个没少，只是 sub 这次权限不足读不进去。
      const blocked = await makeLibrary(
        createFakeFs(files, { errors: { [`${ROOT}\\sub`]: 'EACCES' } })
      )
      const result = await blocked.scan(undefined, () => {})

      expect(result.cancelled).toBe(false)
      expect(result.issues.map((issue) => issue.kind)).toContain('unreadable')
      expect(result.sessions.map((summary) => summary.projectName).sort()).toEqual([
        'proj-a',
        'proj-b'
      ])
    })

    it('调低搜索深度不会删掉更深处的条目', async () => {
      const files = {
        [`${ROOT}\\top.jsonl`]: sessionContent('s-top', 'proj-top', '浅的'),
        [`${ROOT}\\a\\b\\c.jsonl`]: sessionContent('s-deep', 'proj-deep', '深的')
      }
      const library = await makeLibrary(createFakeFs(files))
      await library.updateSettings({ maxDepth: 8 })
      expect((await library.scan(undefined, () => {})).sessions).toHaveLength(2)

      // 深度调成 1：这次压根没往 a\b 里走，不能因此断定那个文件没了。
      const shallow = await makeLibrary(createFakeFs(files))
      await shallow.updateSettings({ maxDepth: 1 })
      const result = await shallow.scan(undefined, () => {})

      expect(result.sessions.map((summary) => summary.projectName).sort()).toEqual([
        'proj-deep',
        'proj-top'
      ])
    })

    it('文件超过大小上限只是跳过，不算已删除', async () => {
      const small = sessionContent('s-big', 'proj-big', '会长大的那个')
      const library = await makeLibrary(
        createFakeFs({
          [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
          [`${ROOT}\\big.jsonl`]: small
        })
      )
      expect((await library.scan(undefined, () => {})).sessions).toHaveLength(2)

      // 同一个文件，这次报出来的体积超过了上限。
      const grown = await makeLibrary(
        createFakeFs({
          [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
          [`${ROOT}\\big.jsonl`]: { content: small, size: 64 * 1024 * 1024 }
        })
      )
      await grown.updateSettings({ maxFileSizeMb: 1 })
      const result = await grown.scan(undefined, () => {})

      expect(result.issues.map((issue) => issue.kind)).toContain('skipped-large')
      expect(result.sessions.map((summary) => summary.projectName).sort()).toEqual([
        'proj-a',
        'proj-big'
      ])
    })

    it('整个目录被删掉后，底下多深的条目都清干净', async () => {
      const library = await makeLibrary(
        createFakeFs({
          [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
          [`${ROOT}\\sub\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
        })
      )
      expect((await library.scan(undefined, () => {})).sessions).toHaveLength(2)

      // 用户把整个 .codex 删了 —— 这是确定的信息，索引该空。
      const gone = await makeLibrary(createFakeFs({ 'D:\\unrelated\\x.txt': 'nothing' }))
      const result = await gone.scan(undefined, () => {})

      expect(result.sessions).toEqual([])
    })
  })

  /*
   * 扫描要跑几十秒到几分钟，导入 / 清空 / 移除走的都是各自的 IPC，
   * 完全可以在这期间发生。扫描收尾时若拿开扫那一刻的快照整份写回去，
   * 就把用户这期间做的事悄悄撤销了。
   */
  describe('扫描期间的其他改动不能被覆盖', () => {
    it('扫描期间导入的会话仍然在', async () => {
      const outside = 'D:\\backup\\imported.jsonl'
      const library = await makeLibrary(
        createFakeFs({
          [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
          [`${ROOT}\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B'),
          [outside]: sessionContent('s-out', 'proj-imported', '扫描途中导入的')
        })
      )

      let importing: Promise<unknown> | null = null
      const scanning = library.scan(undefined, () => {
        importing ??= library.importFiles([outside])
      })
      await Promise.all([scanning, importing])

      const projects = (await library.listSessions()).map((summary) => summary.projectName).sort()
      expect(projects).toEqual(['proj-a', 'proj-b', 'proj-imported'])
    })

    it('扫描期间清空索引后，只有本次真的扫到的东西回来', async () => {
      const outside = 'D:\\backup\\old.jsonl'
      const library = await makeLibrary(
        createFakeFs({
          [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
          [outside]: sessionContent('s-out', 'proj-outside', '扫描范围之外')
        })
      )
      await library.importFiles([outside])
      await library.scan(undefined, () => {})
      expect((await library.listSessions()).map((s) => s.projectName).sort()).toEqual([
        'proj-a',
        'proj-outside'
      ])

      let clearing: Promise<unknown> | null = null
      const scanning = library.scan(undefined, () => {
        clearing ??= library.clearIndex()
      })
      await Promise.all([scanning, clearing])

      // proj-a 是这一次在磁盘上真看到的，回来没问题；
      // proj-outside 只存在于那份已经被清掉的快照里，不该被扫描"复活"。
      expect((await library.listSessions()).map((s) => s.projectName)).toEqual(['proj-a'])
    })
  })

  it('「清空本地索引」会把已隐藏的会话一起放出来（设置页就是这么承诺的）', async () => {
    const library = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
        [`${ROOT}\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
      })
    )
    const scanned = await library.scan(undefined, () => {})
    const target = scanned.sessions.find((summary) => summary.projectName === 'proj-b')!

    await library.forgetSession(target.id)
    expect((await library.listSessions()).map((s) => s.projectName)).toEqual(['proj-a'])

    await library.clearIndex()
    expect(await library.listSessions()).toEqual([])

    // 清空之后重新扫描，被移除过的那个必须回来。
    const rescanned = await library.scan(undefined, () => {})
    expect(rescanned.sessions.map((summary) => summary.projectName).sort()).toEqual([
      'proj-a',
      'proj-b'
    ])
  })

  it('「从索引中移除」不影响原始文件，但重新扫描后也不会复活', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\a.jsonl`]: sessionContent('s-a', 'proj-a', '改一下 A'),
      [`${ROOT}\\b.jsonl`]: sessionContent('s-b', 'proj-b', '改一下 B')
    })
    const library = await makeLibrary(fs)
    const scanned = await library.scan(undefined, () => {})

    const target = scanned.sessions.find((s) => s.projectName === 'proj-b')!
    const left = await library.forgetSession(target.id)
    expect(left.map((s) => s.projectName)).toEqual(['proj-a'])

    // 原文件仍然读得到 —— 说明只动了索引。
    await expect(fs.statPath(`${ROOT}\\b.jsonl`)).resolves.toBeTruthy()

    const rescanned = await library.scan(undefined, () => {})
    expect(rescanned.sessions.map((s) => s.projectName)).toEqual(['proj-a'])
  })
})
