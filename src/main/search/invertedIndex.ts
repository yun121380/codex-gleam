/**
 * 倒排表：词 → 出现过这个词的会话。
 *
 * 这一层是搜索的第一层，也是 "674 会话下查询 < 200 ms" 这条验收线唯一的承担者。
 * 它只在内存里的一张表上做集合运算：**不碰文件系统、不解析会话、不读时钟**。
 * 一旦这里出现一次文件读取，200 ms 就守不住了——这也是为什么建成时间要由调用方
 * 传进来，而不是这里自己 `new Date()`。
 *
 * 表里存的是**下标而不是会话 id**：674 个 id 每个 38 字符，一个高频词的 postings
 * 光是 id 就有 25 KB，换成下标是 2 KB 出头。代价是会话被移除时得重映射一遍全表，
 * 那件事在 `mergeIndex` 里一次扫完。
 */
import {
  SEARCH_INDEX_BUDGET_BYTES,
  SEARCH_INDEX_VERSION,
  SEARCH_MAX_EXPANSION,
  SEARCH_MIN_SUBSTRING_LENGTH
} from '../../shared/constants'
import type { CodexSession, SearchIndexFile, SessionSummary } from '../../shared/types'
import { isRecord } from '../../shared/validators'
import { eventTextFields, sessionTextFields } from './sessionText'
import { tokenize, type ParsedQuery } from './tokenize'

/**
 * 一个会话摘要上的词条：标题、项目名、文件名、子代理那几个字段。
 *
 * 单独拆出来是给"没有全文索引"那条降级路用的 —— 它只有摘要可搜。让降级路走
 * 这个函数而不是另写一套字段清单，是为了保证它搜的字段严格是全文那一套的子集：
 * 两份清单迟早会各自漂一点，而漂出来的症状是"同一个词开着索引搜得到、关了搜不到，
 * 反之也有"，谁也说不清哪次是对的。
 */
export function collectSummaryTerms(summary: SessionSummary): Set<string> {
  const terms = new Set<string>()
  for (const { text } of sessionTextFields(summary)) {
    for (const term of tokenize(text)) terms.add(term)
  }
  return terms
}

/**
 * 一个会话的全部词条。
 *
 * 在扫描过程里、事件还在内存里的那一刻调用；调完这一份，事件就可以丢掉了——
 * 这是"不留正向索引"的直接后果，也是它成立的前提。
 */
export function collectTerms(session: CodexSession): Set<string> {
  const terms = collectSummaryTerms(session)
  for (const event of session.events) {
    for (const { text } of eventTextFields(event)) {
      for (const term of tokenize(text)) terms.add(term)
    }
  }
  return terms
}

/**
 * 空表。
 *
 * `builtAt` 是空串而不是某个纪元时间：界面据此判断"还没建过"，写个 1970 年
 * 反而要让每个读它的人再想一遍那是不是真的建成时间。
 */
export function emptyIndex(): SearchIndexFile {
  return {
    version: SEARCH_INDEX_VERSION,
    sessionIds: [],
    terms: {},
    droppedTerms: 0,
    builtAt: ''
  }
}

export interface MergeInput {
  /** 上一次的表；没有就传 `emptyIndex()`。 */
  previous: SearchIndexFile
  /** 本次要移除的会话 id（library 那边算出来的 staleIds）。 */
  removed: ReadonlySet<string>
  /** 本次新产出的会话 id → 词条。同一个 id 已经在表里就是"重建"。 */
  added: ReadonlyMap<string, ReadonlySet<string>>
  /** 建成时间，由调用方传进来（这一层不读时钟，测试才能钉住结果）。 */
  builtAt: string
  /**
   * 体积预算，默认 `SEARCH_INDEX_BUDGET_BYTES`。
   *
   * 留这个参数只为一件事：测试要能用一个几百字节的预算钉住裁剪行为，而不是先
   * 造一张 30 MB 的表。生产路径上没人传它。
   */
  budgetBytes?: number
}

/**
 * 增量合表。
 *
 * 一次扫完，复杂度是 O(词条数 + 总 postings 长度)，与"有多少个会话变了"无关。
 * 听起来像是给一个会话改名也要重排全表，但它换来的是**不需要正向索引**——
 * 不必为了知道"会话 A 有哪些词"而把每个会话的词条再存一份（那是表体积翻倍）。
 *
 * 出现在 `added` 里的 id 一律先抹掉旧 postings 再从表尾重新接上：内容变了的会话
 * 和全新的会话走同一条路，省掉"就地覆盖某个下标"那种要小心 postings 里残留旧
 * 词条的写法。
 */
export function mergeIndex(input: MergeInput): SearchIndexFile {
  const { previous, removed, added, builtAt } = input

  // 旧下标 → 新下标。留下来的会话保持原相对顺序，所以这张映射是单调递增的，
  // 下面重映射出来的 postings 天然还是升序，不用再排一遍。
  const remap = new Map<number, number>()
  const kept: string[] = []
  for (let at = 0; at < previous.sessionIds.length; at += 1) {
    const id = previous.sessionIds[at]
    if (id === undefined || removed.has(id) || added.has(id)) continue
    remap.set(at, kept.length)
    kept.push(id)
  }

  const sessionIds = [...kept, ...added.keys()]
  const terms: Record<string, number[]> = {}

  for (const [term, postings] of Object.entries(previous.terms)) {
    const next: number[] = []
    for (const at of postings) {
      const mapped = remap.get(at)
      if (mapped !== undefined) next.push(mapped)
    }
    // 词条的最后一个会话被移除了就整条删掉，不留空数组：空 postings 会让
    // `queryIndex` 把它当"命中了但没有结果"，而它其实是"这个词已经不存在"。
    if (next.length > 0) terms[term] = next
  }

  let at = kept.length
  for (const sessionTerms of added.values()) {
    for (const term of sessionTerms) {
      const postings = terms[term]
      // `at` 一路只增，所以直接 push 就是升序。
      if (postings === undefined) terms[term] = [at]
      else postings.push(at)
    }
    at += 1
  }

  return {
    version: SEARCH_INDEX_VERSION,
    sessionIds,
    terms,
    // 累加而不是只记本次：上次被裁掉的词条不会因为这次没超预算就自己回来，
    // 表还是不全的。这个数只在整份重建（previous 是空表）时才归零。
    droppedTerms: previous.droppedTerms + trimToBudget(terms, input.budgetBytes),
    builtAt
  }
}

/**
 * 一个词条在落盘 JSON 里占多少字节。
 *
 * `"词":[1,2,3],` —— 两个引号、一个冒号、两个中括号、一个逗号，六个固定字符，
 * 加上词本身的 UTF-8 长度（中文 bigram 是 6 字节，不是 2），再加每个下标算 4 字节
 * （674 个会话下最多三位数加一个逗号）。
 *
 * 用算术估而不是 `JSON.stringify(...).length`：后者要先把整张表序列化成一个几十
 * MB 的字符串才能知道它超没超预算，而超预算这件事本身就是"内存快扛不住了"。
 */
function termBytes(term: string, postings: number[]): number {
  return Buffer.byteLength(term) + 6 + postings.length * 4
}

function estimateBytes(terms: Record<string, number[]>): number {
  let bytes = 0
  for (const [term, postings] of Object.entries(terms)) bytes += termBytes(term, postings)
  return bytes
}

/**
 * 超预算时就地裁表，返回丢掉的词条数。
 *
 * 丢 **df 最高** 的词：一个出现在 600/674 个会话里的词条筛不掉任何东西，postings
 * 却是全表最长的那几条——它是纯粹的体积负担。同 df 的先丢长的（长词更可能是
 * 一串没意义的标识符）。
 *
 * 丢掉的条数会一路累加进 `droppedTerms`，界面据此说"结果可能不全"。
 * **绝不静默丢弃**：搜不到东西而界面一句话都不说，用户会以为自己记错了。
 */
function trimToBudget(terms: Record<string, number[]>, budgetBytes?: number): number {
  const budget = budgetBytes ?? SEARCH_INDEX_BUDGET_BYTES
  let bytes = estimateBytes(terms)
  if (bytes <= budget) return 0

  const ordered = Object.keys(terms).sort((left, right) => {
    const byFrequency = (terms[right]?.length ?? 0) - (terms[left]?.length ?? 0)
    return byFrequency !== 0 ? byFrequency : right.length - left.length
  })

  let dropped = 0
  for (const term of ordered) {
    if (bytes <= budget) break
    const postings = terms[term]
    if (postings === undefined) continue
    bytes -= termBytes(term, postings)
    delete terms[term]
    dropped += 1
  }
  return dropped
}

/**
 * 把落盘的表当外部数据读。
 *
 * 这份文件在用户的应用数据目录里，可以被手改、被同步工具截断、被上一个版本的
 * 程序写成另一种形状。任何一处对不上就返回 `null`，调用方据此当"没有索引"走
 * 降级重建——**不做半信半疑的修补**：一张下标越界的表会让 `queryIndex` 返回
 * 一堆 `undefined` 会话 id，那种坏法比"没有索引"难查十倍。
 *
 * 唯一被容忍的是 `droppedTerms` 与 `builtAt`：它们只影响界面上一句提示，坏了
 * 就当 0 和空串，不值得为它们把一张好表整个丢掉。
 */
export function readIndexFile(value: unknown): SearchIndexFile | null {
  if (!isRecord(value)) return null
  // 版本对不上直接丢：分词规则变了之后，老词条和新查询词根本不是同一套东西。
  if (value.version !== SEARCH_INDEX_VERSION) return null

  const rawIds = value.sessionIds
  if (!Array.isArray(rawIds)) return null
  const sessionIds: string[] = []
  for (const id of rawIds) {
    if (typeof id !== 'string' || id === '') return null
    sessionIds.push(id)
  }

  const rawTerms = value.terms
  if (!isRecord(rawTerms)) return null
  const terms: Record<string, number[]> = {}
  for (const [term, rawPostings] of Object.entries(rawTerms)) {
    if (term === '' || !Array.isArray(rawPostings) || rawPostings.length === 0) return null
    const postings: number[] = []
    for (const at of rawPostings) {
      // 下标必须落在 sessionIds 里。这一条是这个函数存在的主要理由。
      if (typeof at !== 'number' || !Number.isInteger(at)) return null
      if (at < 0 || at >= sessionIds.length) return null
      postings.push(at)
    }
    terms[term] = postings
  }

  const droppedTerms = value.droppedTerms
  const builtAt = value.builtAt
  return {
    version: SEARCH_INDEX_VERSION,
    sessionIds,
    terms,
    droppedTerms:
      typeof droppedTerms === 'number' && Number.isFinite(droppedTerms) && droppedTerms > 0
        ? Math.floor(droppedTerms)
        : 0,
    builtAt: typeof builtAt === 'string' ? builtAt : ''
  }
}

export interface QueryResult {
  /** 候选会话 id，顺序是表内顺序；排序交给上层（它知道显示顺序）。 */
  sessionIds: string[]
  /** 实际参与检索的词条，回给界面解释"为什么这条也算命中"。 */
  terms: string[]
  /** 有词一个都没扩展出来（打错字，或那个词被预算裁掉了）。 */
  unmatched: string[]
}

/**
 * 查表。多个词之间是 AND。
 *
 * 有的词命中不了时不整个查询返回空，而是把它记进 `unmatched` 让界面说清——
 * "五个词里有一个没命中"和"什么都没搜到"对用户是两件事。
 */
export function queryIndex(index: SearchIndexFile, parsed: ParsedQuery): QueryResult {
  const used: string[] = []
  const unmatched: string[] = []
  const groups: number[][] = []
  // 词表只在"有词精确命中不了"的时候才铺开：百万词条的表 `Object.keys` 本身就要
  // 几十毫秒，而中文 bigram 与常见标识符几乎都是精确命中，那条路上一次都不用铺。
  let vocabulary: string[] | null = null

  for (const word of parsed.terms) {
    let expanded: string[]
    if (index.terms[word] !== undefined) {
      // 精确命中就短路：搜 `node` 不该把 `node_modules` 一起算进来——用户打出一个
      // 表里真有的词，说明他要的就是这个词。代价是搜 `test` 命中不了 `tests`。
      expanded = [word]
    } else {
      if (vocabulary === null) vocabulary = Object.keys(index.terms)
      expanded = expand(vocabulary, word)
    }
    if (expanded.length === 0) {
      unmatched.push(word)
      continue
    }
    for (const term of expanded) used.push(term)
    groups.push(union(index, expanded))
  }

  if (groups.length === 0) return { sessionIds: [], terms: [], unmatched }

  // 最短的一组当基底：AND 的结果不可能比它更大。一个高频词配一个低频词时，
  // 这一下把工作量从"高频词的长度"降到"低频词的长度"。
  groups.sort((left, right) => left.length - right.length)
  let survivors = groups[0] ?? []
  for (let at = 1; at < groups.length && survivors.length > 0; at += 1) {
    const filter = new Set(groups[at])
    survivors = survivors.filter((session) => filter.has(session))
  }

  const sessionIds: string[] = []
  for (const at of survivors) {
    const id = index.sessionIds[at]
    if (id !== undefined) sessionIds.push(id)
  }
  return { sessionIds, terms: dedupe(used), unmatched }
}

/**
 * 一个查询词能对上表里的哪些词条。前缀优先，前缀一个都没有才退到子串。
 *
 * 分层而不是一次全找：搜 `modules` 时 `node_modules` 是想要的，但如果表里同时有
 * `modules_loaded`，前缀那一层就够了，没必要把子串命中也混进来稀释结果。
 *
 * 太短的词不做子串扩展（见 `SEARCH_MIN_SUBSTRING_LENGTH`）—— 搜 `sk` 命中
 * `desktop` 这种事没法向用户解释，更要紧的是它会让"搜密钥搜不到"这条断言失效。
 */
function expand(vocabulary: string[], word: string): string[] {
  const prefixed = collect(vocabulary, word, true)
  if (prefixed.length > 0) return prefixed
  if (word.length < SEARCH_MIN_SUBSTRING_LENGTH) return []
  return collect(vocabulary, word, false)
}

function collect(vocabulary: string[], word: string, prefixOnly: boolean): string[] {
  const found: string[] = []
  for (const term of vocabulary) {
    if (prefixOnly ? term.startsWith(word) : term.includes(word)) found.push(term)
  }
  // 短的排前面：搜 `node` 时 `node_modules` 比 `node_modules_backup_20260101` 更
  // 可能是要找的那个。截断在排序之后，所以 64 这个上限拿到的是最短的 64 个，
  // 而不是碰巧排在词表前面的 64 个。
  found.sort((left, right) => {
    if (left.length !== right.length) return left.length - right.length
    return left < right ? -1 : 1
  })
  return found.length > SEARCH_MAX_EXPANSION ? found.slice(0, SEARCH_MAX_EXPANSION) : found
}

/** 一个查询词扩展出的所有词条的 postings 并集。 */
function union(index: SearchIndexFile, expanded: string[]): number[] {
  const only = expanded[0]
  // 常见情况是精确命中，只有一个词条 —— 直接把那条 postings 交出去，不复制。
  // 下面的 AND 只读不写，交出引用是安全的。
  if (expanded.length === 1 && only !== undefined) return index.terms[only] ?? []

  const merged = new Set<number>()
  for (const term of expanded) {
    for (const at of index.terms[term] ?? []) merged.add(at)
  }
  return [...merged]
}

function dedupe(terms: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const term of terms) {
    if (seen.has(term)) continue
    seen.add(term)
    unique.push(term)
  }
  return unique
}
