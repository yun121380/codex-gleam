/**
 * 规模与时延：把表撑到验收规模，再看查询要多久。
 *
 * 验收行写的是 **674 会话下查询 < 200 ms**。674 是实测这台机器上的会话数，所以这里
 * 也不把它凑成 700 —— 那个数字就是这条线的由来。
 *
 * 这是仓库里唯一一条看墙上时钟的断言，值得说清它为什么不算 flaky：一张正常的表上
 * 最慢的那条查询是十几毫秒，离 200 ms 还有一个数量级的余量。它挂掉几乎只会是因为
 * 有人把一个 O(词表) 的动作挪进了每个查询词的循环里（最可能的那个：每个词都重新
 * `Object.keys(index.terms)` 一次），而不是因为 CI 那台机器今天慢了三倍。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { SEARCH_MAX_EXPANSION } from '../../src/shared/constants'
import { emptyIndex, mergeIndex, queryIndex } from '../../src/main/search/invertedIndex'
import { parseQuery } from '../../src/main/search/tokenize'
import type { SearchIndexFile } from '../../src/shared/types'

/** 验收行里的那个数。 */
const SESSION_COUNT = 674

/** 每个会话取多少个词。实测一个中等长度的会话去重之后是一两千个词条。 */
const TERMS_PER_SESSION = 1200

/** 词池大小。674 × 1200 次抽样铺在四万个词上，跟真实词表的量级对得上。 */
const POOL_SIZE = 40_000

const QUERY_BUDGET_MS = 200

/** 每个会话都有的词：真实会话里 lint、node_modules、路径片段就是这样无处不在。 */
const HOT_TERMS: readonly string[] = [
  'lint',
  'build',
  'node_modules',
  'src',
  'main',
  'ts2345',
  'enoent',
  'pnpm',
  'vitest',
  '部署',
  '构建',
  '会话'
]

/**
 * 词形要像真的。
 *
 * 长度分布直接决定前缀与子串扫描的成本，全造成等长的短词会让这个测试撒谎 —— 真实
 * 词表里既有 `ts1a` 也有四十字符的路径。
 */
function poolTerm(at: number): string {
  const tag = at.toString(36)
  switch (at % 4) {
    case 0:
      return `module_${tag}`
    case 1:
      return `src/renderer/components/panel_${tag}.tsx`
    case 2:
      return `ts${tag}`
    default:
      return `changed_file_${tag}_diff`
  }
}

/**
 * 一个会话的词条。
 *
 * 977 / 1597 都与 POOL_SIZE 互质：让每个会话抽到的那 1200 个词铺满整个词池，而不是
 * 几百个会话反复共享同一段 —— 那样交集会快得不真实。
 */
function sessionTerms(at: number): Set<string> {
  const terms = new Set(HOT_TERMS)
  for (let k = 0; k < TERMS_PER_SESSION; k += 1) {
    terms.add(poolTerm((at * 977 + k * 1597) % POOL_SIZE))
  }
  return terms
}

let index: SearchIndexFile

beforeAll(() => {
  const added = new Map<string, ReadonlySet<string>>()
  for (let at = 0; at < SESSION_COUNT; at += 1) {
    added.set(`session-${at.toString().padStart(4, '0')}`, sessionTerms(at))
  }
  index = mergeIndex({
    previous: emptyIndex(),
    removed: new Set<string>(),
    added,
    builtAt: '2026-09-05T12:00:00.000Z'
  })
})

/**
 * 跑三次取最快的一次。
 *
 * 取最小值而不是平均：这里问的是"这个算法够不够快"，一次 GC 或者一次被操作系统抢走
 * 时间片不该算进答案。循环外面那一次是热身，让 JIT 先把代码编出来。
 */
function measure(query: string): { elapsedMs: number; result: ReturnType<typeof queryIndex> } {
  const parsed = parseQuery(query)
  let result = queryIndex(index, parsed)
  let best = Number.POSITIVE_INFINITY
  for (let round = 0; round < 3; round += 1) {
    const startedAt = performance.now()
    result = queryIndex(index, parsed)
    best = Math.min(best, performance.now() - startedAt)
  }
  return { elapsedMs: best, result }
}

/** 把耗时写进断言消息里：挂在 CI 上时，日志里得能看见它到底跑了多久。 */
function expectWithinBudget(label: string, elapsedMs: number): void {
  expect(elapsedMs, `${label}：${elapsedMs.toFixed(2)} ms`).toBeLessThan(QUERY_BUDGET_MS)
}

describe('674 会话的表', () => {
  it('规模是按验收行来的，而且没被预算裁过', () => {
    expect(index.sessionIds).toHaveLength(SESSION_COUNT)
    // 裁过的表查得更快 —— 那样这个测试就是在给一张缩水的表计时。
    expect(index.droppedTerms).toBe(0)
    expect(Object.keys(index.terms).length).toBeGreaterThan(POOL_SIZE / 2)
  })

  it('热词精确命中：全表最长的那条 postings', () => {
    const { elapsedMs, result } = measure('lint')
    expect(result.sessionIds).toHaveLength(SESSION_COUNT)
    expectWithinBudget('热词', elapsedMs)
  })

  it('两个热词求交集：两条 674 长的 postings 对撞', () => {
    const { elapsedMs, result } = measure('lint node_modules')
    expect(result.sessionIds).toHaveLength(SESSION_COUNT)
    expectWithinBudget('双热词交集', elapsedMs)
  })

  it('中文查询：跨词边界的那个 bigram 命中不了，铺一次词表也在预算内', () => {
    // `部署构建` 切出 部署 / 署构 / 构建 三个 bigram，中间那个横跨两个词，任何真实
    // 文本里都不会有 —— 于是它必然走到扩展那一层，把四万个词条铺开扫一遍。中文查询
    // 里这是常态而不是例外，所以这条路必须自己就在预算内。
    const { elapsedMs, result } = measure('部署构建')
    expect(result.unmatched).toEqual(['署构'])
    expect(result.sessionIds).toHaveLength(SESSION_COUNT)
    expectWithinBudget('中文跨词 bigram', elapsedMs)
  })

  it('热词配一个低频词：交集退化到低频词那一侧', () => {
    // 会话 0 的第 3 个抽样，所以它一定在表里 —— 猜一个词的话，这条测试可能变成
    // "查一个不存在的词"，那当然快。
    const probe = poolTerm((1597 * 3) % POOL_SIZE)
    const postings = index.terms[probe]
    expect(postings, probe).toBeDefined()

    const { elapsedMs, result } = measure(`lint ${probe}`)
    // 热词在每个会话里都有，所以交集必须正好是低频词的那些会话，不多不少。
    expect(result.sessionIds).toHaveLength(postings?.length ?? -1)
    expectWithinBudget('热词 + 低频词', elapsedMs)
  })

  it('前缀扩展：上万个词以它开头，扩展上限兜住', () => {
    const { elapsedMs, result } = measure('module_')
    expect(result.terms).toHaveLength(SEARCH_MAX_EXPANSION)
    expectWithinBudget('前缀扩展', elapsedMs)
  })

  it('一个词都命中不了：四万个词条被完整扫两遍', () => {
    // 最坏的那一条：前缀找不到，子串也找不到，两层都得走满整张词表才能确定没有。
    const { elapsedMs, result } = measure('zzqqxx')
    expect(result.sessionIds).toEqual([])
    expect(result.unmatched).toEqual(['zzqqxx'])
    expectWithinBudget('全表扫两遍', elapsedMs)
  })
})
