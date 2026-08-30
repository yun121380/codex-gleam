import { describe, expect, it } from 'vitest'
import { walkForCandidates } from '../../src/main/scanner/walker'
import { createFakeFs } from '../support/fakeFs'
import { DEFAULT_MAX_DEPTH } from '../../src/shared/constants'

const ROOT = 'C:\\Users\\demo\\.codex'
const BIG = 200 * 1024 * 1024

function run(
  fs: ReturnType<typeof createFakeFs>,
  overrides: Partial<Parameters<typeof walkForCandidates>[0]> = {}
) {
  return walkForCandidates({
    roots: [ROOT],
    maxDepth: DEFAULT_MAX_DEPTH,
    maxFileSizeBytes: 100 * 1024 * 1024,
    fs,
    ...overrides
  })
}

describe('目录遍历', () => {
  it('只收录 .json 与 .jsonl，忽略其他扩展名', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\a.jsonl`]: '{}',
      [`${ROOT}\\b.json`]: '{}',
      [`${ROOT}\\c.JSON`]: '{}',
      [`${ROOT}\\notes.txt`]: 'hello',
      [`${ROOT}\\data.log`]: 'hello',
      [`${ROOT}\\archive.json.gz`]: 'binary'
    })

    const result = await run(fs)
    const names = result.candidates.map((candidate) => candidate.path.split('\\').pop())

    expect(names.sort()).toEqual(['a.jsonl', 'b.json', 'c.JSON'])
  })

  it('遵守最大递归深度：maxDepth=3 时第 4 层的文件不会被收录', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\d1.json`]: '{}',
      [`${ROOT}\\a\\d2.json`]: '{}',
      [`${ROOT}\\a\\b\\d3.json`]: '{}',
      [`${ROOT}\\a\\b\\c\\d4.json`]: '{}',
      [`${ROOT}\\a\\b\\c\\d\\d5.json`]: '{}'
    })

    const result = await run(fs, { maxDepth: 3 })
    const names = result.candidates.map((candidate) => candidate.path.split('\\').pop()).sort()

    expect(names).toEqual(['d1.json', 'd2.json', 'd3.json'])
  })

  it('默认深度 6 能收录第 6 层、但不会收录第 7 层', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\1\\2\\3\\4\\5\\deep6.json`]: '{}',
      [`${ROOT}\\1\\2\\3\\4\\5\\6\\deep7.json`]: '{}'
    })

    const result = await run(fs)
    const names = result.candidates.map((candidate) => candidate.path.split('\\').pop())

    expect(names).toEqual(['deep6.json'])
  })

  it('记录每个文件相对根目录的层级', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\top.json`]: '{}',
      [`${ROOT}\\a\\nested.json`]: '{}'
    })

    const result = await run(fs)
    const byName = new Map(
      result.candidates.map((candidate) => [candidate.path.split('\\').pop(), candidate.depth])
    )

    expect(byName.get('top.json')).toBe(1)
    expect(byName.get('nested.json')).toBe(2)
  })

  it('跳过忽略目录：node_modules / .git / dist / build / Cache / Temp / Logs', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\keep.json`]: '{}',
      [`${ROOT}\\node_modules\\pkg\\package.json`]: '{}',
      [`${ROOT}\\.git\\index.json`]: '{}',
      [`${ROOT}\\dist\\out.json`]: '{}',
      [`${ROOT}\\build\\out.json`]: '{}',
      [`${ROOT}\\Cache\\c.json`]: '{}',
      [`${ROOT}\\Temp\\t.json`]: '{}',
      [`${ROOT}\\Logs\\l.json`]: '{}'
    })

    const result = await run(fs)
    expect(result.candidates.map((candidate) => candidate.path)).toEqual([`${ROOT}\\keep.json`])
  })

  it('忽略目录名不区分大小写', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\NODE_MODULES\\x.json`]: '{}',
      [`${ROOT}\\CACHE\\y.json`]: '{}',
      [`${ROOT}\\ok.json`]: '{}'
    })

    const result = await run(fs)
    expect(result.candidates).toHaveLength(1)
  })

  it('跳过超过大小上限的文件，并给出可执行的建议', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\huge.jsonl`]: { content: '{}', size: BIG },
      [`${ROOT}\\small.jsonl`]: '{}'
    })

    const issues: Array<{ kind: string; reason: string; suggestion: string }> = []
    const result = await run(fs, { onIssue: (issue) => issues.push(issue) })

    expect(result.candidates.map((candidate) => candidate.path)).toEqual([`${ROOT}\\small.jsonl`])
    expect(issues).toHaveLength(1)
    expect(issues[0]?.kind).toBe('skipped-large')
    expect(issues[0]?.reason).toContain('超过')
    expect(issues[0]?.suggestion).not.toBe('')
  })

  it('提高上限后超大文件可以被收录', async () => {
    const fs = createFakeFs({ [`${ROOT}\\huge.jsonl`]: { content: '{}', size: BIG } })
    const result = await run(fs, { maxFileSizeBytes: BIG + 1 })
    expect(result.candidates).toHaveLength(1)
  })

  it('目录不存在时不算错误（这台电脑可能没装过 Codex）', async () => {
    const fs = createFakeFs({ 'D:\\other\\a.json': '{}' })
    const issues: Array<{ kind: string }> = []

    const result = await run(fs, { onIssue: (issue) => issues.push(issue) })

    expect(result.candidates).toEqual([])
    expect(issues).toEqual([])
  })

  it('权限不足时报告为可读性问题并继续扫描其他目录', async () => {
    const fs = createFakeFs(
      {
        [`${ROOT}\\ok.json`]: '{}',
        [`${ROOT}\\locked\\secret.json`]: '{}'
      },
      { errors: { [`${ROOT}\\locked`]: 'EPERM' } }
    )

    const issues: Array<{ kind: string; path: string }> = []
    const result = await run(fs, { onIssue: (issue) => issues.push(issue) })

    expect(result.candidates.map((candidate) => candidate.path)).toEqual([`${ROOT}\\ok.json`])
    expect(issues.map((issue) => issue.kind)).toEqual(['unreadable'])
  })

  /*
   * 上层要靠这两个字段判断"某个索引条目对应的文件是不是真的没了"。
   * 判错的代价是把用户的索引悄悄删掉，所以宁可少报，绝不能多报。
   */
  describe('哪些目录算看清了', () => {
    it('顺利读完的目录才进 enumeratedDirs', async () => {
      const fs = createFakeFs({
        [`${ROOT}\\a.json`]: '{}',
        [`${ROOT}\\sub\\b.json`]: '{}'
      })

      const result = await run(fs)
      expect(result.enumeratedDirs.sort()).toEqual([ROOT, `${ROOT}\\sub`])
      expect(result.absentDirs).toEqual([])
    })

    it('读不动的目录不算看清了', async () => {
      const fs = createFakeFs(
        { [`${ROOT}\\ok.json`]: '{}', [`${ROOT}\\locked\\secret.json`]: '{}' },
        { errors: { [`${ROOT}\\locked`]: 'EPERM' } }
      )

      const result = await run(fs, { onIssue: () => {} })
      expect(result.enumeratedDirs).toEqual([ROOT])
      expect(result.absentDirs).toEqual([])
    })

    it('超过 maxDepth 没进去的目录不算看清了', async () => {
      const fs = createFakeFs({ [`${ROOT}\\a\\b\\deep.json`]: '{}' })

      const result = await run(fs, { maxDepth: 1 })
      expect(result.enumeratedDirs).toEqual([ROOT])
    })

    it('命中忽略名单的目录不算看清了', async () => {
      const fs = createFakeFs({
        [`${ROOT}\\keep.json`]: '{}',
        [`${ROOT}\\node_modules\\pkg.json`]: '{}'
      })

      const result = await run(fs)
      expect(result.enumeratedDirs).toEqual([ROOT])
    })

    it('目录不存在是确定信息，记进 absentDirs', async () => {
      const fs = createFakeFs({ 'D:\\other\\a.json': '{}' })

      const result = await run(fs)
      expect(result.absentDirs).toEqual([ROOT])
      expect(result.enumeratedDirs).toEqual([])
    })
  })

  /*
   * "这个文件在磁盘上"和"这次要不要解析它"是两个问题。
   * 因为太大、stat 失败而被跳过的文件依然实实在在存在着。
   */
  describe('看到过的文件', () => {
    it('被大小上限挡下的文件也照样报告为看到过', async () => {
      const fs = createFakeFs({
        [`${ROOT}\\huge.jsonl`]: { content: '{}', size: BIG },
        [`${ROOT}\\small.jsonl`]: '{}'
      })

      const observed: string[] = []
      const result = await run(fs, {
        onIssue: () => {},
        onFileObserved: (path) => observed.push(path)
      })

      expect(result.candidates.map((candidate) => candidate.path)).toEqual([`${ROOT}\\small.jsonl`])
      expect(observed.sort()).toEqual([`${ROOT}\\huge.jsonl`, `${ROOT}\\small.jsonl`])
    })

    it('不看的扩展名不报告', async () => {
      const fs = createFakeFs({ [`${ROOT}\\a.jsonl`]: '{}', [`${ROOT}\\notes.txt`]: 'hi' })

      const observed: string[] = []
      await run(fs, { onFileObserved: (path) => observed.push(path) })

      expect(observed).toEqual([`${ROOT}\\a.jsonl`])
    })
  })

  it('可以被取消，并把 cancelled 标记带回来', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\a.json`]: '{}',
      [`${ROOT}\\b.json`]: '{}',
      [`${ROOT}\\c.json`]: '{}'
    })

    const cancellation = { cancelled: false }
    const result = await run(fs, {
      cancellation,
      onProgress: ({ filesScanned }) => {
        if (filesScanned >= 1) cancellation.cancelled = true
      }
    })

    expect(result.cancelled).toBe(true)
    expect(result.candidates.length).toBeLessThan(3)
  })

  /**
   * 候选文件上限必须在遍历阶段就生效。
   *
   * 原来是先无限制地把所有候选攒进数组、之后才在扫描器里截断到 20000 个 ——
   * 用户选了一个塞满 JSON 的项目目录时，光这个数组就能吃掉几百兆。
   */
  it('候选文件触顶后停止遍历，并把原因带回来', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 50; index += 1) files[`${ROOT}\\f${index}.json`] = '{}'

    const result = await run(createFakeFs(files), { maxCandidates: 10 })

    expect(result.candidates).toHaveLength(10)
    expect(result.reachedCandidateLimit).toBe(true)
  })

  it('触顶后不再往下钻子目录', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 20; index += 1) files[`${ROOT}\\f${index}.json`] = '{}'
    for (let index = 0; index < 20; index += 1) files[`${ROOT}\\deep\\g${index}.json`] = '{}'

    const result = await run(createFakeFs(files), { maxCandidates: 5 })

    expect(result.candidates).toHaveLength(5)
    expect(result.candidates.every((candidate) => !candidate.path.includes('deep'))).toBe(true)
  })

  it('没触顶时这个标记是 false，行为完全不变', async () => {
    const result = await run(
      createFakeFs({ [`${ROOT}\\a.json`]: '{}', [`${ROOT}\\b.json`]: '{}' })
    )

    expect(result.candidates).toHaveLength(2)
    expect(result.reachedCandidateLimit).toBe(false)
  })

  it('统计访问过的目录数与查看过的文件数', async () => {
    const fs = createFakeFs({
      [`${ROOT}\\a.json`]: '{}',
      [`${ROOT}\\sub\\b.json`]: '{}'
    })

    const result = await run(fs)
    expect(result.dirsVisited).toBe(2)
    expect(result.filesScanned).toBe(2)
  })

  it('目录数超过上限时提前结束并标记出来', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 30; index += 1) {
      files[`${ROOT}\\dir${index}\\a.json`] = '{}'
    }

    const result = await run(createFakeFs(files), { maxDirectories: 5 })
    expect(result.reachedDirectoryLimit).toBe(true)
    expect(result.dirsVisited).toBeLessThanOrEqual(5)
  })
})
