import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionLibrary } from '../../src/main/library'
import { LocalStore } from '../../src/main/storage/store'
import type { FileSystemAccess } from '../../src/main/scanner/fsAccess'
import type { SearchIndexFile } from '../../src/shared/types'
import { createFakeFs } from '../support/fakeFs'

/**
 * 倒排表的生命周期。
 *
 * `tests/library/scanIndex.test.ts` 已经把"会话索引什么时候该过期"钉了一遍，
 * 这份文件是同一批情形的另一半：断言换成"倒排表里还有没有它"。两张表必须分毫不差
 * 地一起过期 —— 对不齐的症状不是报错，是搜出来一个点不开的会话，或者一个明明在
 * 列表里的会话怎么都搜不到。
 *
 * 断言尽量落在**磁盘上那份**而不是内存里那份：用户关掉应用再打开，拿到的就是磁盘
 * 上这一份，而"内存对了、磁盘错了"这种坏法要等到下次启动才露头。
 */

const ROOT = 'C:\\Users\\demo\\.codex'
const TABLE_FILE = 'search-index.json'

/**
 * 造一个会话文件。第一条消息决定标题，后面几条只进正文。
 *
 * 标题和正文分开传是为了能区分"只搜了标题"和"搜了全文"：降级路径应当找得到标题
 * 里的词、找不到只在正文里出现过的词。少了这个区分，两条路的断言长得一模一样。
 */
function sessionContent(
  sessionId: string,
  project: string,
  title: string,
  ...body: string[]
): string {
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: sessionId,
        cwd: `C:\\Users\\demo\\projects\\${project}`,
        timestamp: '2026-08-28T10:00:00.000Z'
      }
    })
  ]
  for (const [at, text] of [title, ...body].entries()) {
    lines.push(
      JSON.stringify({
        timestamp: `2026-08-28T10:00:0${at + 1}.000Z`,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
      })
    )
  }
  return lines.join('\n')
}

/*
 * 四个会话，每个都带一个只在正文里出现过的独有词（enoent / node_modules /
 * ts2345 / sourcemap）。搜这些词能一句话说清"是不是搜到了这一个会话的正文"。
 */
const A = sessionContent('s-a', 'proj-a', '修复部署脚本', '诊断 ENOENT 之后重跑')
const B = sessionContent('s-b', 'proj-b', '重构缓存策略', '清理 node_modules 再装一遍')
const DEEP = sessionContent('s-deep', 'proj-deep', '整理离线自检', '补上 TS2345 的类型')
const BIG = sessionContent('s-big', 'proj-big', '压缩打包产物', '产物里有 sourcemap 残留')

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
  storeDir = await mkdtemp(join(tmpdir(), 'gleam-search-'))
})

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true })
})

/** 磁盘上那张表。新开一个 store 读，绕开任何内存里的残留。 */
async function onDisk(): Promise<SearchIndexFile | null> {
  return new LocalStore(storeDir).getSearchIndex()
}

async function tableFileExists(): Promise<boolean> {
  return (await readdir(storeDir)).includes(TABLE_FILE)
}

/** 搜一个词，只要命中的会话 id。 */
async function found(library: SessionLibrary, query: string): Promise<string[]> {
  const response = await library.searchSessions({ query })
  return labelsOf(library, response.sessionIds)
}

/**
 * 会话 id 是 `sha1(文件路径#draftKey)` 的前 16 位，写进断言里没人看得懂它指谁。
 * 一律换成项目名 —— 每个 fixture 一个，和 `sessionContent` 的第二个参数对得上。
 */
async function labelsOf(library: SessionLibrary, ids: readonly string[]): Promise<string[]> {
  const byId = new Map((await library.listSessions()).map((entry) => [entry.id, entry.projectName]))
  return ids.map((id) => byId.get(id) ?? id)
}

/** 磁盘那张表里现在有哪些会话，同样按项目名报。 */
async function tableProjects(library: SessionLibrary): Promise<string[]> {
  const table = await onDisk()
  return table ? labelsOf(library, table.sessionIds) : []
}

/** 按项目名找出一个会话的真实 id。 */
async function idOf(library: SessionLibrary, project: string): Promise<string> {
  const sessions = await library.listSessions()
  const wanted = sessions.find((entry) => entry.projectName === project)
  expect(wanted, project).toBeDefined()
  return wanted!.id
}

describe('扫描建表', () => {
  it('第一次扫描之后，正文里的词就能搜到', async () => {
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\b.jsonl`]: B })
    )
    await library.scan(undefined, () => {})

    const response = await library.searchSessions({ query: 'enoent' })
    expect(await labelsOf(library, response.sessionIds)).toEqual(['proj-a'])
    // 表在、也没被裁过：这一条上不该有任何提示。
    expect(response.degraded).toBe(false)
    expect(response.notice).toBeNull()

    expect(await found(library, 'node_modules')).toEqual(['proj-b'])
    // 摘要字段和正文进的是同一张表，所以标题里的词一样搜得到。
    expect(await found(library, '部署')).toEqual(['proj-a'])
  })

  it('新增一个文件再扫一次，新旧都搜得到', async () => {
    const first = await makeLibrary(createFakeFs({ [`${ROOT}\\a.jsonl`]: A }))
    await first.scan(undefined, () => {})

    const grown = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\b.jsonl`]: B })
    )
    await grown.scan(undefined, () => {})

    expect(await found(grown, 'node_modules')).toEqual(['proj-b'])
    // a.jsonl 这次是复用的，压根没被重新解析 —— 它的 postings 只经过一次下标重映射。
    // 增量把旧的冲掉过一次，症状就是这一条。
    expect(await found(grown, 'enoent')).toEqual(['proj-a'])
  })

  it('文件内容换了之后，旧词搜不到、新词搜得到', async () => {
    const before = await makeLibrary(createFakeFs({ [`${ROOT}\\a.jsonl`]: A }))
    await before.scan(undefined, () => {})
    expect(await found(before, 'enoent')).toEqual(['proj-a'])

    const after = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: {
          content: sessionContent('s-new', 'proj-a', '换了个题目', '这次报的是 TS2345'),
          mtimeMs: Date.UTC(2026, 7, 29, 12, 0, 0)
        }
      })
    )
    await after.scan(undefined, () => {})

    expect(await found(after, 'ts2345')).toEqual(['proj-a'])
    // 是替换不是叠加：旧词条连表里都不该留着一个空壳。
    expect(await found(after, 'enoent')).toEqual([])
    expect(Object.keys((await onDisk())?.terms ?? {})).not.toContain('enoent')
  })

  it('文件删了之后，它的词条整条消失，没有 postings 指着它', async () => {
    const both = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\b.jsonl`]: B })
    )
    await both.scan(undefined, () => {})

    const left = await makeLibrary(createFakeFs({ [`${ROOT}\\a.jsonl`]: A }))
    await left.scan(undefined, () => {})

    expect(await found(left, 'node_modules')).toEqual([])

    const table = await onDisk()
    expect(table).not.toBeNull()
    expect(await tableProjects(left)).toEqual(['proj-a'])
    // 只出现在 b 里的词条要整条删掉，不留空数组 —— 空 postings 在 queryIndex 眼里
    // 是"命中了但没结果"，而它其实是"这个词已经不存在"。
    expect(table!.terms['node_modules']).toBeUndefined()
    for (const [term, postings] of Object.entries(table!.terms)) {
      expect(postings.length, term).toBeGreaterThan(0)
      // 越界的下标会让 queryIndex 交出一串 undefined 会话 id，那种坏法比搜不到难查十倍。
      for (const at of postings) expect(at, term).toBeLessThan(table!.sessionIds.length)
    }
  })

  it('扫描被取消时，整张表一个字节都不动', async () => {
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\b.jsonl`]: B })
    )
    await library.scan(undefined, () => {})
    const before = await onDisk()
    expect(before).not.toBeNull()

    const cancelled = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\b.jsonl`]: B })
    )
    const result = await cancelled.scan(undefined, () => {
      cancelled.cancelScan()
    })
    expect(result.cancelled).toBe(true)

    // 深比较整张表，不是抽查一个词：半份表最像的东西就是一张好表。builtAt 也在比较
    // 范围内 —— 只要写回发生过，那个字段就会变。
    expect(await onDisk()).toEqual(before)
  })
})

/*
 * 扫描"没看清"的那几种长相，`scanIndex.test.ts` 里各有一条。倒排表照抄同一个
 * staleIds，所以这里逐条再来一遍：只要有人在写回时重算一遍"哪些文件真的没了"，
 * 这一组里必定有一条挂掉。
 */
describe('扫描没看清的地方，表里也不许删', () => {
  it('目录读不动时，它底下会话的词条留着', async () => {
    const files = { [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\sub\\b.jsonl`]: B }
    const library = await makeLibrary(createFakeFs(files))
    await library.scan(undefined, () => {})
    expect(await found(library, 'node_modules')).toEqual(['proj-b'])

    const blocked = await makeLibrary(createFakeFs(files, { errors: { [`${ROOT}\\sub`]: 'EACCES' } }))
    const result = await blocked.scan(undefined, () => {})

    expect(result.issues.map((issue) => issue.kind)).toContain('unreadable')
    expect(await found(blocked, 'node_modules')).toEqual(['proj-b'])
  })

  it('调低搜索深度不会抹掉更深处的词条', async () => {
    const files = { [`${ROOT}\\top.jsonl`]: A, [`${ROOT}\\a\\b\\c.jsonl`]: DEEP }
    const library = await makeLibrary(createFakeFs(files))
    await library.updateSettings({ maxDepth: 8 })
    await library.scan(undefined, () => {})
    expect(await found(library, 'ts2345')).toEqual(['proj-deep'])

    const shallow = await makeLibrary(createFakeFs(files))
    await shallow.updateSettings({ maxDepth: 1 })
    await shallow.scan(undefined, () => {})

    expect(await found(shallow, 'ts2345')).toEqual(['proj-deep'])
  })

  it('文件超过大小上限只是跳过，词条不动', async () => {
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\big.jsonl`]: BIG })
    )
    await library.scan(undefined, () => {})
    expect(await found(library, 'sourcemap')).toEqual(['proj-big'])

    const grown = await makeLibrary(
      createFakeFs({
        [`${ROOT}\\a.jsonl`]: A,
        [`${ROOT}\\big.jsonl`]: { content: BIG, size: 64 * 1024 * 1024 }
      })
    )
    await grown.updateSettings({ maxFileSizeMb: 1 })
    const result = await grown.scan(undefined, () => {})

    expect(result.issues.map((issue) => issue.kind)).toContain('skipped-large')
    expect(await found(grown, 'sourcemap')).toEqual(['proj-big'])
  })

  it('整个目录被删掉后，表跟着清空', async () => {
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\sub\\b.jsonl`]: B })
    )
    await library.scan(undefined, () => {})

    // 用户把整个 .codex 删了 —— 这是确定的信息，表该空。
    const gone = await makeLibrary(createFakeFs({ 'D:\\unrelated\\x.txt': 'nothing' }))
    await gone.scan(undefined, () => {})

    expect((await onDisk())?.sessionIds).toEqual([])
    expect(await found(gone, 'enoent')).toEqual([])
  })
})

describe('清空索引', () => {
  it('清空之后磁盘上那份表也没了', async () => {
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\b.jsonl`]: B })
    )
    await library.scan(undefined, () => {})
    expect(await tableFileExists()).toBe(true)

    await library.clearIndex()

    // 只清会话索引也能让界面上什么都没有，但磁盘上会留着一份含全部会话正文的表 ——
    // 而那正是按这个按钮想消除的东西。
    expect(await tableFileExists()).toBe(false)
    expect(await onDisk()).toBeNull()
    expect(await found(library, 'enoent')).toEqual([])
  })
})

describe('全文索引开关', () => {
  it('开关关着时扫描不落表，只搜标题', async () => {
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\a.jsonl`]: A }))
    await library.updateSettings({ buildSearchIndex: false })
    await library.scan(undefined, () => {})

    expect(await tableFileExists()).toBe(false)

    const response = await library.searchSessions({ query: 'enoent' })
    expect(response.degraded).toBe(true)
    expect(response.notice).toContain('全文索引已关闭')
    // 下面两条得凑在一起看：正文里的词搜不到、标题里的词搜得到，合起来才是
    // "只搜了标题"。单看任何一条都可能只是"整个搜索都坏了"。
    expect(response.sessionIds).toEqual([])
    expect(await found(library, '部署')).toEqual(['proj-a'])
  })

  it('刚打开开关还没重扫时，提示指向重新扫描', async () => {
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\a.jsonl`]: A }))
    await library.updateSettings({ buildSearchIndex: false })
    await library.scan(undefined, () => {})
    await library.updateSettings({ buildSearchIndex: true })

    const response = await library.searchSessions({ query: 'enoent' })
    expect(response.degraded).toBe(true)
    expect(response.notice).toContain('重新扫描一次')
    // 关变开不触发扫描：那是几百个文件的全量重解析，不该由点一下开关引发。
    expect(await tableFileExists()).toBe(false)
  })

  it('打开开关后重扫一次，正文就搜得到了', async () => {
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\a.jsonl`]: A }))
    await library.updateSettings({ buildSearchIndex: false })
    await library.scan(undefined, () => {})
    await library.updateSettings({ buildSearchIndex: true })

    // 文件的大小和修改时间一个字节都没变，按"没变就复用"这条规则整个文件会被跳过 ——
    // 而跳过就意味着 onSession 不被调到、词条永远收不上来，于是"重新扫描一次就能建好"
    // 变成一句空话。这一条钉的是那个例外：词条还没进表的文件必须重新解析一遍。
    await library.scan(undefined, () => {})

    expect(await tableFileExists()).toBe(true)
    const response = await library.searchSessions({ query: 'enoent' })
    expect(response.degraded).toBe(false)
    expect(response.notice).toBeNull()
    expect(await labelsOf(library, response.sessionIds)).toEqual(['proj-a'])
  })

  it('开关由开变关的那一刻，文件立刻消失', async () => {
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\a.jsonl`]: A }))
    await library.scan(undefined, () => {})
    expect(await tableFileExists()).toBe(true)

    await library.updateSettings({ buildSearchIndex: false })

    // 不等下次扫描。用户关它的理由只有一个 —— 不想让这份正文留在磁盘上，
    // 那么"关掉之后就没有了"必须是当下为真的陈述，而不是一句承诺。
    expect(await tableFileExists()).toBe(false)
    expect(await onDisk()).toBeNull()
  })
})

describe('体积上限的提示', () => {
  it('表被裁过时，提示说清丢了多少个词，但不算降级', async () => {
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\a.jsonl`]: A }))
    await library.scan(undefined, () => {})

    // 改磁盘上那份再新开一个 library 读回来 —— 造一张真超 30 MB 的表不现实，
    // 而这里要验的只是"读到 droppedTerms > 0 之后那句话对不对"。
    const table = await onDisk()
    expect(table).not.toBeNull()
    await new LocalStore(storeDir).saveSearchIndex({ ...table!, droppedTerms: 3 })

    const reopened = await makeLibrary(createFakeFs({ [`${ROOT}\\a.jsonl`]: A }))
    const response = await reopened.searchSessions({ query: 'enoent' })

    // 裁过的表搜的仍然是全文，只是可能不全 —— 和"只搜了标题"是两件事，
    // 混成一件的话界面就没法说清该怎么办。
    expect(response.degraded).toBe(false)
    expect(response.notice).toContain('3 个高频词')
    expect(await labelsOf(reopened, response.sessionIds)).toEqual(['proj-a'])
  })
})

/*
 * 不经过扫描的两条写回路。扫描收尾那一处有自己的 staleIds，这两条走的是另一个
 * 函数——两边都得改到表，漏一边的症状分别是"导入的会话搜不到"和"删掉的文件还搜得到"。
 */
describe('不经扫描的写回路', () => {
  it('导入进来的会话，正文当场就搜得到', async () => {
    const files = { [`${ROOT}\\a.jsonl`]: A, 'D:\\backup\\old.jsonl': B }
    const library = await makeLibrary(createFakeFs(files))
    await library.scan(undefined, () => {})
    // 在扫描范围之外，所以扫不到它。
    expect(await found(library, 'node_modules')).toEqual([])

    await library.importFiles(['D:\\backup\\old.jsonl'])

    expect(await found(library, 'node_modules')).toEqual(['proj-b'])
    // 导入是增量的：扫描进来的那个不能被顶掉。
    expect(await found(library, 'enoent')).toEqual(['proj-a'])
    // 落盘了才算 —— 内存里对、磁盘上没有的话，重启之后这个会话就搜不到了。
    expect((await onDisk())?.terms['node_modules']).toBeDefined()
  })

  it('开关关着时导入不会偷偷把表建回来', async () => {
    const library = await makeLibrary(
      createFakeFs({ 'D:\\backup\\old.jsonl': B })
    )
    await library.updateSettings({ buildSearchIndex: false })

    await library.importFiles(['D:\\backup\\old.jsonl'])

    // 关掉开关几秒后又出现一份含正文的文件，等于那个开关根本没用。
    expect(await tableFileExists()).toBe(false)
  })

  it('点开一个文件已经没了的会话，它的词条一起清掉', async () => {
    const both = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\b.jsonl`]: B })
    )
    await both.scan(undefined, () => {})
    const target = await idOf(both, 'proj-b')

    // 同一个 storeDir：新 library 从磁盘读回那份还带着 proj-b 的索引，
    // 但它的假文件系统里已经没有 b.jsonl 了 —— 用户在应用外面删掉了它。
    const library = await makeLibrary(createFakeFs({ [`${ROOT}\\a.jsonl`]: A }))
    expect(await library.getSession(target)).toBeNull()

    expect(await found(library, 'node_modules')).toEqual([])
    expect(await tableProjects(library)).toEqual(['proj-a'])
  })
})

/*
 * 两种"用户主动不想看见它"的情形。表和列表在这里必须口径一致：正文躺在磁盘的表里、
 * 只是界面上不显示，跟"移除了"不是一回事。
 */
describe('用户移除掉的东西', () => {
  it('隐藏来源的会话根本不进表', async () => {
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\b.jsonl`]: B })
    )
    await library.updateSettings({ hiddenSources: [`${ROOT}\\b.jsonl`] })
    await library.scan(undefined, () => {})

    // 不是"搜出来了但被挡掉"—— 词条压根不该写进去。写进去的话它虽然不在界面上，
    // 正文还躺在磁盘那张表里，而那正是隐藏这个来源想避免的事。
    expect(Object.keys((await onDisk())?.terms ?? {})).not.toContain('node_modules')
    expect(await found(library, 'node_modules')).toEqual([])
  })

  it('从索引里移除一个会话之后，它不再出现在结果里', async () => {
    const library = await makeLibrary(
      createFakeFs({ [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\b.jsonl`]: B })
    )
    await library.scan(undefined, () => {})
    expect(await found(library, 'node_modules')).toEqual(['proj-b'])

    await library.forgetSession(await idOf(library, 'proj-b'))

    // 这一条靠的是排序那一步把"表里有、索引里没有"的 id 挡掉，而不是改表 ——
    // 下次扫描时那条 postings 才会随 staleIds 一起消失。挡不住的症状是搜出来
    // 一条点不开的结果。
    expect(await found(library, 'node_modules')).toEqual([])
    expect(await found(library, 'enoent')).toEqual(['proj-a'])
  })

  it('隐藏过的来源再次扫描时，旧词条被清掉', async () => {
    const files = { [`${ROOT}\\a.jsonl`]: A, [`${ROOT}\\b.jsonl`]: B }
    const library = await makeLibrary(createFakeFs(files))
    await library.scan(undefined, () => {})
    expect(await found(library, 'node_modules')).toEqual(['proj-b'])

    await library.updateSettings({ hiddenSources: [`${ROOT}\\b.jsonl`] })
    await library.scan(undefined, () => {})

    // 文件没变，所以"没变就复用"那条规则会想直接留着它 —— 隐藏来源必须比它更强势。
    expect(await tableProjects(library)).toEqual(['proj-a'])
    expect(Object.keys((await onDisk())?.terms ?? {})).not.toContain('node_modules')
  })
})
