import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalStore } from '../../src/main/storage/store'
import type { SessionSummary } from '../../src/shared/types'

/**
 * 本地存储的并发安全。
 *
 * 这不是理论问题：设置页的滑块每动一下就调一次 updateSettings，
 * 而所有写入原来共用同一个 `<文件名>.tmp` —— 实测 100 次并发写设置
 * 有 96 次因为互相抢占临时文件而 ENOENT。
 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gleam-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function summary(id: string): SessionSummary {
  return {
    id,
    title: `会话 ${id}`,
    projectName: 'demo',
    projectPath: null,
    sourceFile: `C:\\x\\${id}.jsonl`,
    displaySourceFile: `~\\x\\${id}.jsonl`,
    fileSizeBytes: 1,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    eventCount: 1,
    userMessageCount: 0,
    assistantMessageCount: 0,
    commandCount: 0,
    failedCommandCount: 0,
    changedFileCount: 0,
    changedFiles: [],
    testsPassed: 0,
    testsFailed: 0,
    errorCount: 0,
    hasFailures: false,
    hasCodeChanges: false,
    confidence: 'high',
    confidenceScore: 1,
    parserId: 'test',
    eventTypeCounts: {},
    warnings: [],
    indexedAt: '2026-08-30T00:00:00.000Z',
    fileModifiedAt: null,
    agent: { threadId: null, parentThreadId: null, nickname: null, role: null, taskPath: null },
    usage: null
  }
}

describe('并发写设置', () => {
  it('100 次并发写入全部成功，不再 ENOENT', async () => {
    const store = new LocalStore(dir)

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        store.updateSettings({ playbackIntervalMs: 1000 + index })
      )
    )

    const failed = results.filter((entry) => entry.status === 'rejected')
    expect(failed.map((entry) => String((entry as PromiseRejectedResult).reason))).toEqual([])
  })

  it('并发的补丁不会互相丢失', async () => {
    const store = new LocalStore(dir)
    await store.getSettings()

    // 三个调用各改一个字段。串行化之后每一项都该留在最终结果里。
    await Promise.all([
      store.updateSettings({ redactSensitive: false }),
      store.updateSettings({ showFullPaths: true }),
      store.updateSettings({ maxDepth: 9 })
    ])

    const onDisk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    expect(onDisk.redactSensitive).toBe(false)
    expect(onDisk.showFullPaths).toBe(true)
    expect(onDisk.maxDepth).toBe(9)
  })

  it('磁盘上的内容与内存缓存一致（最后写入的赢）', async () => {
    const store = new LocalStore(dir)

    await Promise.all(
      Array.from({ length: 40 }, (_, index) => store.updateSettings({ playbackIntervalMs: 1000 + index }))
    )

    const cached = await store.getSettings()
    const onDisk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    expect(onDisk.playbackIntervalMs).toBe(cached.playbackIntervalMs)
  })

  it('写完不留临时文件', async () => {
    const store = new LocalStore(dir)
    await Promise.all(
      Array.from({ length: 30 }, (_, index) => store.updateSettings({ playbackIntervalMs: 1200 + index }))
    )

    const files = await readdir(dir)
    expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('并发写索引', () => {
  it('60 次并发写入全部成功', async () => {
    const store = new LocalStore(dir)

    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, index) => store.saveIndex([summary(`s-${index}`)]))
    )

    expect(results.filter((entry) => entry.status === 'rejected')).toEqual([])
  })

  it('最终落盘的是最后一次写入的内容', async () => {
    const store = new LocalStore(dir)

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.saveIndex([summary(`s-${index}`)]))
    )

    const onDisk = JSON.parse(await readFile(join(dir, 'session-index.json'), 'utf8'))
    const cached = await store.getIndex()
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].id).toBe(cached[0]?.id)
  })

  it('设置与索引写不同文件，不会互相阻塞或串味', async () => {
    const store = new LocalStore(dir)

    await Promise.all([
      ...Array.from({ length: 20 }, () => store.updateSettings({ showFullPaths: true })),
      ...Array.from({ length: 20 }, () => store.saveIndex([summary('only')])),
      ...Array.from({ length: 20 }, () => store.updateState({ firstRunCompleted: true }))
    ])

    const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    const index = JSON.parse(await readFile(join(dir, 'session-index.json'), 'utf8'))
    const state = JSON.parse(await readFile(join(dir, 'app-state.json'), 'utf8'))

    expect(settings.showFullPaths).toBe(true)
    expect(index[0].id).toBe('only')
    expect(state.firstRunCompleted).toBe(true)
  })
})

describe('损坏与残留', () => {
  it('一次写入失败不会把后面排队的都堵死', async () => {
    // 把 session-index.json 占成一个目录，针对它的写入必定失败。
    await mkdir(join(dir, 'session-index.json'), { recursive: true })
    const store = new LocalStore(dir)

    const first = await store.saveIndex([summary('a')]).then(
      () => 'ok',
      () => 'failed'
    )
    expect(first).toBe('failed')

    // 队列必须已经腾空：后面的写入还得能正常排上去。
    const second = await store.saveIndex([summary('b')]).then(
      () => 'ok',
      () => 'failed'
    )
    expect(second).toBe('failed')

    // 换一个文件写，完全不受前面失败的影响。
    await expect(store.updateSettings({ showFullPaths: true })).resolves.toBeTruthy()
  })

  it('写入失败后不留下写了一半的临时文件', async () => {
    await mkdir(join(dir, 'session-index.json'), { recursive: true })
    const store = new LocalStore(dir)

    await store.saveIndex([summary('a')]).catch(() => undefined)

    const files = await readdir(dir)
    expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  /*
   * 写失败之后，内存里不能留着一份"其实没存下来"的值。
   * 缓存先改、落盘后失败的话：调用方收到了异常，可后续 getSettings() 依然
   * 一口一个新值，界面显示改好了 —— 下次启动又变回去，中间没有任何迹象。
   */
  describe('写入失败后缓存不能假装成功', () => {
    it('设置写不进去时，缓存仍然是磁盘上的旧值', async () => {
      const store = new LocalStore(dir)
      await store.updateSettings({ playbackIntervalMs: 1500 })

      // 把 settings.json 换成目录，之后针对它的写入必定失败。
      await rm(join(dir, 'settings.json'))
      await mkdir(join(dir, 'settings.json'), { recursive: true })

      await expect(store.updateSettings({ playbackIntervalMs: 9000 })).rejects.toThrow()
      expect((await store.getSettings()).playbackIntervalMs).toBe(1500)
    })

    it('索引写不进去时，缓存仍然是磁盘上的旧值', async () => {
      const store = new LocalStore(dir)
      await store.saveIndex([summary('kept')])

      await rm(join(dir, 'session-index.json'))
      await mkdir(join(dir, 'session-index.json'), { recursive: true })

      await expect(store.saveIndex([summary('never-saved')])).rejects.toThrow()
      expect((await store.getIndex()).map((entry) => entry.id)).toEqual(['kept'])
    })

    it('应用状态写不进去时，缓存仍然是磁盘上的旧值', async () => {
      const store = new LocalStore(dir)
      await store.updateState({ lastScanAt: '2026-08-30T00:00:00.000Z' })

      await rm(join(dir, 'app-state.json'))
      await mkdir(join(dir, 'app-state.json'), { recursive: true })

      await expect(store.updateState({ lastScanAt: '2026-08-31T00:00:00.000Z' })).rejects.toThrow()
      expect((await store.getState()).lastScanAt).toBe('2026-08-30T00:00:00.000Z')
    })

    it('写成功之后缓存与磁盘一致', async () => {
      const store = new LocalStore(dir)
      await store.updateSettings({ maxDepth: 7 })

      const onDisk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
      expect((await store.getSettings()).maxDepth).toBe(7)
      expect(onDisk.maxDepth).toBe(7)
    })
  })

  it('文件内容损坏时回退到默认值，不抛异常', async () => {
    await writeFile(join(dir, 'settings.json'), '{ 这不是 JSON', 'utf8')
    await writeFile(join(dir, 'session-index.json'), 'nope', 'utf8')

    const store = new LocalStore(dir)
    await expect(store.getSettings()).resolves.toBeTruthy()
    await expect(store.getIndex()).resolves.toEqual([])
  })
})

/**
 * 索引是上一次扫描留在磁盘上的，可能由更早的版本写成。
 *
 * 类型签名上这些字段都不可能是 undefined，但索引是从 JSON 读进来强转的，
 * 编译器管不着 —— 只有这条测试能拦住"新增字段忘了补默认值"。
 */
describe('旧版本索引', () => {
  /** 造一条旧索引：拿完整的 summary 抹掉几个字段，模拟更早的版本写下的样子。 */
  function legacy(id: string, ...omit: string[]): Record<string, unknown> {
    const entry = { ...summary(id) } as unknown as Record<string, unknown>
    for (const key of omit) delete entry[key]
    return entry
  }

  it('缺 usage 的旧索引读出来是 null，不是 undefined', async () => {
    await writeFile(
      join(dir, 'session-index.json'),
      JSON.stringify([legacy('legacy', 'usage')]),
      'utf8'
    )

    const [entry] = await new LocalStore(dir).getIndex()

    expect(entry).toBeDefined()
    expect(entry!.usage).toBeNull()
    expect('usage' in entry!).toBe(true)
  })

  /**
   * 逐字段补而不是"有 agent 就整条原样返回"：真实的旧索引往往缺的不止一个字段，
   * 补齐逻辑不能因为撞上其中一个就提前收工。
   */
  it('agent 和 usage 一起缺时两个都补上', async () => {
    await writeFile(
      join(dir, 'session-index.json'),
      JSON.stringify([legacy('older', 'agent', 'usage')]),
      'utf8'
    )

    const [entry] = await new LocalStore(dir).getIndex()

    expect(entry!.usage).toBeNull()
    expect(entry!.agent.threadId).toBeNull()
  })
})
