/**
 * 分词。
 *
 * 这个模块只认字符：不认会话、不认设置、不碰文件系统。它是整期最热的循环
 * （674 个会话的全部文本都要过一遍），所以按字符码一次扫完，不用正则回溯，
 * 也不给马上要丢掉的长串复制字符串。
 *
 * 建表与查表必须共用这里的同一条扫描 —— 建表时切成一种、查表时切成另一种，
 * 结果是"永远搜不到"，而这种错在界面上看不出任何异常。
 */
import { SEARCH_MAX_NUMERIC_LENGTH, SEARCH_MAX_TERM_LENGTH } from '../../shared/constants'

export interface ParsedQuery {
  /** 参与倒排求交集的词条，已去重。 */
  terms: string[]
  /** 引号里的原文，第二层据此做精确匹配；没有引号时为 null。 */
  phrase: string | null
}

/**
 * 组成词条的 ASCII 字符：字母、数字、下划线。
 *
 * 下划线和数字**属于词的一部分**，不是分隔符：`node_modules` 得是一个词而不是
 * `node` + `modules`，`TS2345` 得是一个词而不是 `TS` + `2345`。代价是搜
 * `modules` 搜不到 `node_modules` —— 那个由查询时的词条扩展补上，不在这里存
 * 子串。存子串会让表膨胀好几倍，而且"为什么搜 de 能搜到 node_modules"没法
 * 向用户解释。
 *
 * 导出是给第二层切片段用的：`locate.ts` 把片段两端对齐到词边界时，认的必须是
 * 同一套"什么算一个词"。各写一份的话一边认下划线一边不认，片段就会正好在
 * `node_modules` 中间切开，露出 `de_modules` 这种像是另一个词的残片。
 */
export function isWordChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f // _
  )
}

/**
 * 拉丁扩展、希腊、西里尔字母。按 ASCII 的规矩走（整词、转小写），不切 bigram：
 * `café` 得是一个词。
 *
 * 刻意只列字母区，不图省事写成"凡是非 ASCII 非表意文字都算词" —— 全角标点、
 * 弯引号、emoji 都该是分隔符，不该变成词条。
 */
function isLetterChar(code: number): boolean {
  return (
    (code >= 0x00c0 && code <= 0x024f) || // 拉丁补充与扩展 A/B
    (code >= 0x0370 && code <= 0x03ff) || // 希腊
    (code >= 0x0400 && code <= 0x04ff) // 西里尔
  )
}

/** 需要按 bigram 切的字符：中日韩表意文字与假名。 */
function isIdeograph(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 平假名、片假名
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
    (code >= 0xac00 && code <= 0xd7af) // 谚文
  )
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

/**
 * 切词。返回顺序即出现顺序，已去重。
 *
 * 中英混排不需要任何特殊分支：扫到字符类别边界就收尾当前词，`修复ENOENT错误`
 * 自然切出 `修复` / `enoent` / `错误`。
 */
export function tokenize(text: string): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  const length = text.length
  let index = 0

  while (index < length) {
    const code = text.charCodeAt(index)

    if (isWordChar(code) || isLetterChar(code)) {
      const start = index
      let onlyDigits = isDigit(code)
      index += 1
      while (index < length) {
        const next = text.charCodeAt(index)
        if (!isWordChar(next) && !isLetterChar(next)) break
        if (onlyDigits && !isDigit(next)) onlyDigits = false
        index += 1
      }
      // 先量长度再切片：一段 5000 字符的 base64 不该为了立刻丢掉而先被复制一遍。
      //
      // 两条长度规则都是**体积**规则，不是安全规则：48 字符以上的连续标识符
      // 实际上只有哈希、base64、data URI 和压缩过的代码，8 位以上的纯数字是
      // 毫秒时间戳与行号偏移 —— 搜不到它们没有损失，留着它们能把表撑到几百 MB。
      // 密钥搜不到靠的是 sessionText 里的无条件打码，与这两个数字无关。
      const size = index - start
      if (size <= SEARCH_MAX_TERM_LENGTH && !(onlyDigits && size > SEARCH_MAX_NUMERIC_LENGTH)) {
        // 统一小写：搜 `enoent` 要能命中日志里的 `ENOENT`。
        push(terms, seen, text.slice(start, index).toLowerCase())
      }
      continue
    }

    if (isIdeograph(code)) {
      const start = index
      index += 1
      while (index < length && isIdeograph(text.charCodeAt(index))) index += 1
      if (index - start === 1) {
        // 单字成段（夹在英文里的一个"的"）就出这一个字，否则它彻底搜不到。
        push(terms, seen, text.slice(start, index))
      } else {
        // 相邻两字一组：`离线自检` → `离线` / `线自` / `自检`。
        //
        // 不引词典、不引分词库：bigram 在"筛掉 99% 的会话"这件事上够用，
        // 而第二层还会在会话内做一次精确匹配，误召回在那里被挡掉。
        for (let at = start; at < index - 1; at += 1) push(terms, seen, text.slice(at, at + 2))
      }
      continue
    }

    index += 1
  }

  return terms
}

function push(terms: string[], seen: Set<string>, term: string): void {
  if (term === '' || seen.has(term)) return
  seen.add(term)
  terms.push(term)
}

/**
 * 引号里的原文。`"离线自检"` 与 `“离线自检”` 都认 —— 中文输入法默认打出的是
 * 后者，为了一个引号要求用户切输入法太苛刻了。
 */
const PHRASE_PATTERN = /"([^"]+)"|“([^”]+)”/

/**
 * 解析查询串。
 *
 * 词条与 `tokenize` 完全同源；引号只是**额外**给第二层一个精确匹配的目标，
 * 不改变第一层筛会话的方式 —— 引号里的词照样参与求交集。
 */
export function parseQuery(text: string): ParsedQuery {
  const matched = PHRASE_PATTERN.exec(text)
  const phrase = (matched?.[1] ?? matched?.[2] ?? '').trim()
  return { terms: tokenize(text), phrase: phrase === '' ? null : phrase }
}
