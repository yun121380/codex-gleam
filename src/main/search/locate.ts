/**
 * 第二层：在**一个**会话里定位命中的具体位置。
 *
 * 和第一层的分工是硬的。第一层只回答"哪些会话里有这些词"，全程不碰文件系统，
 * 那是 674 会话下 < 200 ms 的那条路；这一层要把一个会话重新解析一遍，贵一个
 * 量级，所以只在用户点进某个会话之后才跑，而且一次只跑一个。
 *
 * 搜的字段严格是第一层索引过的那一套 —— 两边调的是同一个 `eventTextFields`。
 * 少了这个约束，症状是"搜索把这个会话列出来了，点进去却写着命中 0 处"。
 *
 * 这一层同样不读时钟、不写文件：给它一个会话和一个查询，它就该给出同一个答案。
 */
import { SEARCH_MAX_HITS_PER_SESSION, SEARCH_SNIPPET_LENGTH } from '../../shared/constants'
import type { CodexEvent, CodexSession, SearchHit } from '../../shared/types'
import { eventTextFields } from './sessionText'
import { isWordChar, type ParsedQuery } from './tokenize'

/**
 * 片段两端的省略号。
 *
 * 它是 snippet 字符串的一部分，所以长度要参与 `ranges` 的偏移计算 —— 写成常量
 * 是为了让那个偏移只能从这里取，不会有人手写一个 1。
 */
const ELLIPSIS = '…'

/**
 * 在一个会话里找出所有命中，顺序就是事件顺序。
 *
 * 一个事件最多出一个 `SearchHit`：界面上一个事件就是一行，一行里高亮几处是自然的，
 * 而一个事件出三个 hit 会让"命中 N 处"这个数字和用户数得出来的行数对不上。
 *
 * 不做相关度排序。用户点进一个会话是要顺着时间线走的，把第 40 步排到第 3 步前面
 * 只会让「下一处」这个按钮变得没法预测。
 */
export function locateHits(session: CodexSession, parsed: ParsedQuery): SearchHit[] {
  // 有引号就只找引号里的原文。拆开的词照样参与第一层筛选，但这一层不认它们 ——
  // 用户加引号要的就是"这几个字连在一起"。
  const source = parsed.phrase !== null ? [parsed.phrase] : parsed.terms
  const needles: string[] = []
  for (const word of source) {
    // 词条来自 `tokenize`，本来就是小写，折一遍是幂等的；引号里那串是用户原样打的，
    // 折这一下才是它需要的。统一走同一条路，省掉"这里该不该折"的判断。
    const needle = foldCase(word)
    if (needle !== '') needles.push(needle)
  }
  if (needles.length === 0) return []

  const hits: SearchHit[] = []
  for (const [at, event] of session.events.entries()) {
    const hit = locateInEvent(session.id, event, at, needles)
    if (hit !== null) hits.push(hit)
    // 上限是给界面兜底的：一个几万条事件的会话里搜「的」会命中几千处，
    // 而那个数字对用户没有任何用处，翻页却要翻到手酸。
    if (hits.length >= SEARCH_MAX_HITS_PER_SESSION) break
  }
  return hits
}

/** 一处命中在某段文本里的位置，`[start, end)`。 */
interface Span {
  start: number
  end: number
}

/** 片段在原文里的取值范围，`[from, to)`。 */
interface Frame {
  from: number
  to: number
}

/**
 * 一个事件里的命中。
 *
 * **第一个命中的字段代表这个事件**：`SearchHit` 只有一个 `field` 和一个 `snippet`，
 * 片段没法横跨两个字段。拿第一个而不是"最好的那个"是因为 `eventTextFields` 的字段
 * 顺序本来就是"越像摘要的越靠前"（标题 → 内容 → 命令 → 工具 → 文件 → 差异 → 测试），
 * 于是"第一个"是个能向用户解释的选择，而"最好的"要先定义什么叫好。
 */
function locateInEvent(
  sessionId: string,
  event: CodexEvent,
  eventIndex: number,
  needles: readonly string[]
): SearchHit | null {
  for (const { label, text } of eventTextFields(event)) {
    const folded = foldCase(text)
    const anchor = earliest(folded, needles)
    if (anchor === null) continue

    const frame = frameAround(text, anchor)
    const spans = merge(within(folded, needles, frame))
    const head = frame.from > 0 ? ELLIPSIS : ''
    const tail = frame.to < text.length ? ELLIPSIS : ''
    // 省略号进 snippet，所以它的长度必须一次性算进偏移里：`ranges` 的下标是相对
    // 交出去的这个 snippet 的，界面拿它直接 slice。少算这一位，整条高亮偏一位。
    const offset = head.length - frame.from

    return {
      sessionId,
      eventId: event.id,
      eventIndex,
      eventType: event.type,
      field: label,
      snippet: head + text.slice(frame.from, frame.to) + tail,
      // 超出右边界的那一截截掉：片段里看不见的字不该被算进高亮区间。
      ranges: spans.map((span) => [span.start + offset, Math.min(span.end, frame.to) + offset])
    }
  }
  return null
}

/**
 * 最早的那一处命中。每个词一次 `indexOf`，不铺开全部命中。
 *
 * 分两步（先找锚点、再在窗口里找全部）不是为了好看，是为了不被一个字的词拖死：
 * 一个 64 KB 的输出里搜「的」有上万处，全找出来再排序再合并纯属白干 —— 交出去的
 * 片段只有 160 字符，窗口外面的命中一个都用不上。
 */
function earliest(folded: string, needles: readonly string[]): Span | null {
  let best: Span | null = null
  for (const needle of needles) {
    const at = folded.indexOf(needle)
    if (at === -1) continue
    const end = at + needle.length
    // 同一个起点上取长的：`部署` 和 `部署构建` 都命中时，长的那个更贴近用户打的字。
    if (best === null || at < best.start || (at === best.start && end > best.end)) {
      best = { start: at, end }
    }
  }
  return best
}

/**
 * 围着锚点切出一段窗口，命中尽量居中。
 *
 * 先按"两边各留一半"算，撞到文本末尾就整段往左推 —— 让最后一段片段也是满的 160
 * 字符，而不是"只剩 20 个字"。两端再对齐到词边界（见 `alignStart` / `alignEnd`）。
 */
function frameAround(text: string, anchor: Span): Frame {
  const room = SEARCH_SNIPPET_LENGTH - (anchor.end - anchor.start)
  let from = room > 0 ? anchor.start - Math.floor(room / 2) : anchor.start
  if (from < 0) from = 0
  let to = from + SEARCH_SNIPPET_LENGTH
  if (to > text.length) {
    to = text.length
    from = Math.max(0, to - SEARCH_SNIPPET_LENGTH)
  }
  return { from: alignStart(text, from, anchor.start), to: alignEnd(text, to, anchor.end) }
}

/**
 * 起点往后挪，直到不落在一个 ASCII 词的中间。
 *
 * 切在 `node_modules` 中间会留下 `de_modules` 这种看着像另一个词的残片，用户会以为
 * 自己搜到了别的东西。宁可少显示几个字。
 *
 * 上限是命中点本身：再往后就把要高亮的东西也切掉了，那比残片严重得多。
 * 中日韩不参与对齐 —— 每个字都是独立的意思，切在哪儿都不会拼出一个假词。
 */
function alignStart(text: string, from: number, limit: number): number {
  let at = from
  while (at > 0 && at < limit && isWordChar(text.charCodeAt(at - 1)) && isWordChar(text.charCodeAt(at))) {
    at += 1
  }
  return at
}

/** 终点往前挪，同理。下限是命中的末尾。 */
function alignEnd(text: string, to: number, limit: number): number {
  let at = to
  while (
    at > limit &&
    at < text.length &&
    isWordChar(text.charCodeAt(at - 1)) &&
    isWordChar(text.charCodeAt(at))
  ) {
    at -= 1
  }
  return at
}

/**
 * 窗口里的全部命中，按起点升序。
 *
 * 只在窗口里找，所以规模天然是有界的：窗口 160 字符，同一个词最多命中 160 处。
 * 起点相同时长的排前面，`merge` 靠这个顺序一遍扫完。
 */
function within(folded: string, needles: readonly string[], frame: Frame): Span[] {
  const spans: Span[] = []
  for (const needle of needles) {
    let at = folded.indexOf(needle, frame.from)
    while (at !== -1 && at < frame.to) {
      spans.push({ start: at, end: at + needle.length })
      // 同一个词的重叠出现只算一处：`aaa` 里搜 `aa` 是一处命中，不是两处。
      at = folded.indexOf(needle, at + needle.length)
    }
  }
  spans.sort((left, right) => (left.start !== right.start ? left.start - right.start : right.end - left.end))
  return spans
}

/**
 * 合并**真正重叠**的区间；紧挨着的不合。
 *
 * 中文 bigram 天生互相重叠：查询「部署构建」切出 部署 / 署构 / 构建 三个词，在原文
 * 里它们首尾相扣。不合并就是交出三段互相交叉的区间，界面上画不出来。
 *
 * 而恰好首尾相接的两段（`部署` 后面紧跟 `构建`，中间没有重叠）**不合** —— 那是两处
 * 独立的命中，各自都能在 snippet 上切回一个完整的词。合掉的话 `snippet.slice(...)`
 * 拿到的是一串跨了两个词的字，而"切回来正好等于命中的词"是这一层最要紧的一条性质。
 */
function merge(spans: readonly Span[]): Span[] {
  const merged: Span[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.start < last.end) {
      if (span.end > last.end) last.end = span.end
      continue
    }
    merged.push({ start: span.start, end: span.end })
  }
  return merged
}

/**
 * 转小写，**且保证长度不变**。
 *
 * 折一份小写副本出来用原生 `indexOf` 找位置，比逐字符比大小写快得多，但前提是
 * 副本和原文的下标能一一对上 —— 找到的下标是要拿回原文上去切片段的。
 *
 * 绝大多数字符转小写是一对一的，个别不是：土耳其语的 `İ`（U+0130）小写之后是两个
 * 码元，一个这样的字符就能让它后面所有的高亮整体偏一位。碰上这种就逐码元折，
 * 折不动的原样留着 —— 少匹配一个生僻字，好过交出一串错位的区间。
 */
function foldCase(text: string): string {
  const lowered = text.toLowerCase()
  if (lowered.length === text.length) return lowered

  let out = ''
  for (let at = 0; at < text.length; at += 1) {
    const one = text.charAt(at)
    const small = one.toLowerCase()
    out += small.length === 1 ? small : one
  }
  return out
}
