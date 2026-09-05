/**
 * 搜索框底下那一行字，以及"这次要不要发请求"。
 *
 * 放在 lib 里是因为这两件事都是纯函数：给同样的查询串与同样的响应，就该得到同样
 * 的一行话。组件里只剩下"把它显示出来"。
 */
import { SEARCH_MIN_ASCII_QUERY_LENGTH } from '@shared/constants'
import type { SearchResponse } from '@shared/types'

/** 表意文字与假名：这些字一个就够发查询。 */
function isIdeograph(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xac00 && code <= 0xd7af)
  )
}

/**
 * 这个查询串值不值得发一次全文请求。
 *
 * 门槛只看**够不够具体**，不看合不合法：太短的 ASCII 查询会扩展出成百上千个词条，
 * 返回几乎整个库，用户看到的是"搜索坏了"。中文一个字就发。
 */
export function shouldSearchFullText(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed === '') return false
  for (let at = 0; at < trimmed.length; at += 1) {
    if (isIdeograph(trimmed.charCodeAt(at))) return true
  }
  return trimmed.length >= SEARCH_MIN_ASCII_QUERY_LENGTH
}

/**
 * `unmatched` 里能原样念给用户听的那些词。
 *
 * 第一层交回来的 `unmatched` 是**词条**，而中文查询的词条是 bigram：`部署构建` 会切出
 * `部署` / `署构` / `构建` 三个，其中 `署构` 跨了两个词，用户从来没觉得自己打过这两个
 * 字。把它念出来只会让人怀疑是不是自己打错了。
 *
 * 判据是"用户自己分出来的那一段"：把查询串按分隔符（空白、标点、引号）切开，只念
 * **整段等于**这个词条的那些。于是 `部署 构建` 里没进索引的那一半会被念出来，而
 * `部署构建` 这一整串里的任何 bigram 都不念——那一串里压根没有能对上用户认知的词，
 * 而"命中 0 个会话"本身已经说清了结果。
 *
 * 大小写要放过：词条已折成小写，用户打的可能是 `ENOENT`。
 */
export function echoableTerms(query: string, unmatched: readonly string[]): string[] {
  const segments = new Set(splitSegments(query.toLowerCase()))
  return unmatched.filter((term) => segments.has(term.toLowerCase()))
}

/** 按分隔符切成"用户眼里的一个个词"。中文连写的一整串算一段，不再往里切。 */
function splitSegments(text: string): string[] {
  const segments: string[] = []
  let current = ''
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at)
    if (isWordChar(code) || isIdeograph(code)) {
      current += text.charAt(at)
      continue
    }
    if (current !== '') segments.push(current)
    current = ''
  }
  if (current !== '') segments.push(current)
  return segments
}

/** ASCII 词字符：与分词器同一套（下划线和数字属于词的一部分）。 */
function isWordChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f
  )
}

/**
 * 搜索框下面那一行。`null` 表示这一行不显示（还没搜过 / 查询串太短）。
 *
 * 这一行不能省：省掉它，用户就会把"降级只搜了标题"当成"库里真的没有这个词"，
 * 于是换个词再搜一遍 —— 而真正该做的事是重新扫描一次。
 *
 * 降级时只说降级那句话，不报数字：只搜了标题的那个"命中 N 个会话"会被当成全文结果。
 */
export function describeSearch(response: SearchResponse | null): string | null {
  if (response === null) return null

  const parts: string[] = []
  if (response.degraded) {
    parts.push(response.notice ?? '这次只搜了标题。')
  } else {
    parts.push(`全文命中 ${response.sessionIds.length} 个会话`)
    // 丢词那句话来自主进程 —— 丢了多少个词只有那边知道。
    if (response.notice !== null) parts.push(response.notice)
  }

  const echoable = echoableTerms(response.query, response.unmatched)
  if (echoable.length > 0) {
    parts.push(`${echoable.map((term) => `「${term}」`).join('')}没有出现在索引里`)
  }

  return parts.join('；')
}
