import { describe, expect, it } from 'vitest'
import { SEARCH_INDEX_VERSION, SEARCH_MIN_SUBSTRING_LENGTH } from '../../src/shared/constants'
import {
  collectTerms,
  emptyIndex,
  mergeIndex,
  queryIndex,
  readIndexFile
} from '../../src/main/search/invertedIndex'
import { parseQuery } from '../../src/main/search/tokenize'
import type { SearchIndexFile } from '../../src/shared/types'
import { loadFixture, testFixturePath } from '../support/fixtures'

const BUILT_AT = '2026-09-05T12:00:00.000Z'

/** 从"会话 id → 词条"这张明细表造一张索引。这一层压根不需要真会话。 */
function indexOf(sessions: Record<string, string[]>, budgetBytes?: number): SearchIndexFile {
  const added = new Map<string, ReadonlySet<string>>()
  for (const [id, terms] of Object.entries(sessions)) added.set(id, new Set(terms))
  return mergeIndex({
    previous: emptyIndex(),
    removed: new Set<string>(),
    added,
    builtAt: BUILT_AT,
    ...(budgetBytes === undefined ? {} : { budgetBytes })
  })
}

function ids(index: SearchIndexFile, query: string): string[] {
  return queryIndex(index, parseQuery(query)).sessionIds
}

/** 全表体检：每个 posting 都必须指向一个真实存在的会话。 */
function expectPostingsValid(index: SearchIndexFile): void {
  for (const [term, postings] of Object.entries(index.terms)) {
    expect(postings.length, term).toBeGreaterThan(0)
    for (const at of postings) {
      expect(index.sessionIds[at], `${term} → ${at}`).toBeDefined()
    }
    // 升序无重复：查表时的求交集依赖这一点，坏了不会报错只会少结果。
    const sorted = [...postings].slice().sort((left, right) => left - right)
    expect(postings, term).toEqual(sorted)
    expect(new Set(postings).size, term).toBe(postings.length)
  }
}

describe('查表', () => {
  const index = indexOf({
    's-1': ['lint', 'node_modules', '离线', '线自', '自检'],
    's-2': ['lint', 'build'],
    's-3': ['build', 'staging']
  })

  it('单个词返回所有出现过它的会话', () => {
    expect(ids(index, 'lint')).toEqual(['s-1', 's-2'])
  })

  it('多个词是求交集', () => {
    expect(ids(index, 'lint build')).toEqual(['s-2'])
    expect(ids(index, 'lint staging')).toEqual([])
  })

  it('精确命中就短路，不把更长的词一起算进来', () => {
    // 搜 build 不该把 s-1 也拽出来（它有 node_modules 但没有 build）。
    const result = queryIndex(index, parseQuery('build'))
    expect(result.terms).toEqual(['build'])
    expect(result.sessionIds).toEqual(['s-2', 's-3'])
  })

  it('前缀扩展：表里没有这个词但有以它开头的', () => {
    const result = queryIndex(index, parseQuery('stag'))
    expect(result.terms).toEqual(['staging'])
    expect(result.sessionIds).toEqual(['s-3'])
  })

  it('子串扩展：前缀一个都没有才退到中间匹配', () => {
    const result = queryIndex(index, parseQuery('modules'))
    expect(result.terms).toEqual(['node_modules'])
    expect(result.sessionIds).toEqual(['s-1'])
  })

  it('太短的词不做子串扩展', () => {
    // 两个字符的针在任何真实词表里都能扎到一堆词。这条钉住那道门槛：
    // `de` 不许命中 node_modules，`ui` 不许命中 build。
    expect(SEARCH_MIN_SUBSTRING_LENGTH).toBe(3)
    expect(ids(index, 'de')).toEqual([])
    expect(ids(index, 'ui')).toEqual([])
    // 前缀那一层不受这道门槛限制 —— "以 li 开头"还能向用户解释。
    expect(ids(index, 'li')).toEqual(['s-1', 's-2'])
  })

  it('中文按 bigram 精确命中', () => {
    expect(ids(index, '离线自检')).toEqual(['s-1'])
  })

  it('没命中的词记进 unmatched，不当它不存在', () => {
    const result = queryIndex(index, parseQuery('lint 压根没有的词'))
    // 命中的那部分照样出结果，界面另外说清哪个词没命中。
    expect(result.sessionIds).toEqual(['s-1', 's-2'])
    expect(result.unmatched).toContain('压根')
  })

  it('一个词都没命中时结果为空，词条列表也为空', () => {
    const result = queryIndex(index, parseQuery('zzzz'))
    expect(result.sessionIds).toEqual([])
    expect(result.terms).toEqual([])
    expect(result.unmatched).toEqual(['zzzz'])
  })

  it('空查询不返回全部会话', () => {
    // 搜索框刚清空的那一帧会打进来一个空查询，不能理解成"匹配所有"。
    expect(ids(index, '')).toEqual([])
    expect(ids(index, '   ，。 ')).toEqual([])
  })

  it('空表查不出东西也不抛异常', () => {
    expect(ids(emptyIndex(), 'lint')).toEqual([])
  })
})

describe('合表', () => {
  const first = indexOf({
    's-1': ['lint', 'only_in_one'],
    's-2': ['lint', 'build'],
    's-3': ['build']
  })

  it('移除会话之后，全表没有一个 posting 指向它', () => {
    const next = mergeIndex({
      previous: first,
      removed: new Set(['s-1']),
      added: new Map(),
      builtAt: BUILT_AT
    })

    expect(next.sessionIds).toEqual(['s-2', 's-3'])
    // 只有 s-1 有过的词条整条消失，不留空数组。
    expect(next.terms).not.toHaveProperty('only_in_one')
    expectPostingsValid(next)
    // 下标重映射对了没有，看查询结果最直接：lint 现在只剩 s-2。
    expect(ids(next, 'lint')).toEqual(['s-2'])
    expect(ids(next, 'build')).toEqual(['s-2', 's-3'])
  })

  it('新增会话不打扰旧命中', () => {
    const next = mergeIndex({
      previous: first,
      removed: new Set<string>(),
      added: new Map([['s-4', new Set(['build', 'staging'])]]),
      builtAt: BUILT_AT
    })

    expect(next.sessionIds).toEqual(['s-1', 's-2', 's-3', 's-4'])
    expectPostingsValid(next)
    expect(ids(next, 'lint')).toEqual(['s-1', 's-2'])
    expect(ids(next, 'build')).toEqual(['s-2', 's-3', 's-4'])
    expect(ids(next, 'staging')).toEqual(['s-4'])
  })

  it('内容变了的会话是重建：旧词条不留残余', () => {
    // s-1 原来有 lint 和 only_in_one，重新解析之后只剩 staging。
    const next = mergeIndex({
      previous: first,
      removed: new Set<string>(),
      added: new Map([['s-1', new Set(['staging'])]]),
      builtAt: BUILT_AT
    })

    expectPostingsValid(next)
    expect(next.sessionIds).toContain('s-1')
    expect(next.terms).not.toHaveProperty('only_in_one')
    expect(ids(next, 'lint')).toEqual(['s-2'])
    expect(ids(next, 'staging')).toEqual(['s-1'])
  })

  it('移除全部会话之后是一张空表', () => {
    const next = mergeIndex({
      previous: first,
      removed: new Set(['s-1', 's-2', 's-3']),
      added: new Map(),
      builtAt: BUILT_AT
    })
    expect(next.sessionIds).toEqual([])
    expect(next.terms).toEqual({})
  })

  it('建成时间由调用方给，这一层不读时钟', () => {
    expect(first.builtAt).toBe(BUILT_AT)
    expect(emptyIndex().builtAt).toBe('')
  })
})

describe('体积预算', () => {
  // common 出现在三个会话里（postings 最长），rare 只在一个会话里。
  const sessions = { 'a': ['common', 'rare'], 'b': ['common'], 'c': ['common'] }

  it('超预算先丢 df 最高的词，并把条数记下来', () => {
    const trimmed = indexOf(sessions, 20)
    // 丢的是 common 而不是 rare：一个出现在所有会话里的词筛不掉任何东西，
    // postings 却是全表最长的那条。
    expect(trimmed.terms).not.toHaveProperty('common')
    expect(trimmed.terms).toHaveProperty('rare')
    expect(trimmed.droppedTerms).toBe(1)
  })

  it('裁过的表照样能查', () => {
    const trimmed = indexOf(sessions, 20)
    expectPostingsValid(trimmed)
    expect(ids(trimmed, 'rare')).toEqual(['a'])
    // 被丢掉的词落到 unmatched —— 界面据此说"结果可能不全"，绝不静默。
    expect(queryIndex(trimmed, parseQuery('common')).unmatched).toEqual(['common'])
  })

  it('没超预算时一个都不丢', () => {
    const full = indexOf(sessions)
    expect(full.droppedTerms).toBe(0)
    expect(full.terms).toHaveProperty('common')
  })

  it('丢掉的条数会累加，不会因为下次没超预算就归零', () => {
    // 上次被裁掉的词条不会自己回来，表还是不全的 —— 这个数只在整份重建时归零。
    const trimmed = indexOf(sessions, 20)
    const next = mergeIndex({
      previous: trimmed,
      removed: new Set<string>(),
      added: new Map([['d', new Set(['fresh'])]]),
      builtAt: BUILT_AT
    })
    expect(next.droppedTerms).toBe(1)
    expect(ids(next, 'fresh')).toEqual(['d'])
  })
})

describe('读表', () => {
  const index = indexOf({ 's-1': ['lint', '离线'], 's-2': ['lint'] })

  /** 落盘再读回来的形状：这一层收到的永远是 unknown，不是内存里那个对象。 */
  function onDisk(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(index)) as Record<string, unknown>
  }

  function withTerms(terms: unknown): Record<string, unknown> {
    return { ...onDisk(), terms }
  }

  it('好表原样读回来，而且能直接查', () => {
    const read = readIndexFile(onDisk())
    expect(read).toEqual(index)
    // 读回来的表要能当索引用 —— 只比字段相等还不够，postings 的下标得真指得动。
    expect(read === null ? [] : ids(read, 'lint')).toEqual(['s-1', 's-2'])
  })

  it('压根不是对象就返回 null', () => {
    for (const value of [null, undefined, 42, 'x', [], true]) {
      expect(readIndexFile(value), String(value)).toBeNull()
    }
  })

  it('版本对不上就整份丢掉', () => {
    // 分词规则变了之后，老词条和新查询词不是同一套东西，修不如重建。
    expect(readIndexFile({ ...onDisk(), version: SEARCH_INDEX_VERSION + 1 })).toBeNull()
    expect(readIndexFile({ ...onDisk(), version: '1' })).toBeNull()
  })

  it('会话 id 列表坏了就返回 null', () => {
    expect(readIndexFile({ ...onDisk(), sessionIds: undefined })).toBeNull()
    expect(readIndexFile({ ...onDisk(), sessionIds: 's-1' })).toBeNull()
    expect(readIndexFile({ ...onDisk(), sessionIds: ['s-1', 7] })).toBeNull()
    // 空 id 查出来是个查不开的会话，比没有索引更难查。
    expect(readIndexFile({ ...onDisk(), sessionIds: ['s-1', ''] })).toBeNull()
  })

  it('词条表坏了就返回 null', () => {
    expect(readIndexFile(withTerms(undefined))).toBeNull()
    expect(readIndexFile(withTerms([]))).toBeNull()
    // 空词条名扩展不出任何东西，只会白占一条 postings。
    expect(readIndexFile(withTerms({ '': [0] }))).toBeNull()
    // 空 postings 会被 queryIndex 当成"命中了但没有结果"，而它其实是"这个词不存在"。
    expect(readIndexFile(withTerms({ lint: [] }))).toBeNull()
    expect(readIndexFile(withTerms({ lint: 0 }))).toBeNull()
  })

  it('postings 里不是整数下标就返回 null', () => {
    expect(readIndexFile(withTerms({ lint: ['0'] }))).toBeNull()
    expect(readIndexFile(withTerms({ lint: [0.5] }))).toBeNull()
    expect(readIndexFile(withTerms({ lint: [Number.NaN] }))).toBeNull()
    expect(readIndexFile(withTerms({ lint: [null] }))).toBeNull()
  })

  it('下标越界就返回 null，这是这个函数存在的主要理由', () => {
    // 越界的下标会让 queryIndex 交出一堆 undefined 会话 id —— 界面上是一片查不开的
    // 空条目，谁也想不到去怀疑索引文件。整份丢掉重建反而快得多。
    expect(readIndexFile(withTerms({ lint: [2] }))).toBeNull()
    expect(readIndexFile(withTerms({ lint: [-1] }))).toBeNull()
  })

  it('只影响界面提示的两个字段坏了不丢表', () => {
    // droppedTerms 与 builtAt 只喂一句提示文案，为它们把一张好表整个丢掉不值当。
    const bad = readIndexFile({ ...onDisk(), droppedTerms: 'many', builtAt: 12345 })
    expect(bad?.droppedTerms).toBe(0)
    expect(bad?.builtAt).toBe('')
    expect(bad?.terms).toHaveProperty('lint')
    expect(readIndexFile({ ...onDisk(), droppedTerms: -3 })?.droppedTerms).toBe(0)
    expect(readIndexFile({ ...onDisk(), droppedTerms: 2.7 })?.droppedTerms).toBe(2)
  })
})

describe('从真会话收词', () => {
  it('中英混排的会话，两边的词都收得到', async () => {
    const { sessions } = await loadFixture(testFixturePath('concurrent-commands.jsonl'))
    const session = sessions[0]
    if (!session) throw new Error('fixture 没有解析出会话')

    const terms = collectTerms(session)
    // 会话标题/项目名那一路（sessionTextFields）与事件那一路（eventTextFields）
    // 各出一个词：少接一路的话，这个断言就挂在哪一路上说得清。
    expect(terms.has('lint')).toBe(true)
    expect(terms.has('构建')).toBe(true)
    // 去重是 Set 的事，但这里钉一下：同一个词在几十条事件里出现不该变成几十份。
    expect([...terms].filter((term) => term === 'lint')).toHaveLength(1)
  })
})
