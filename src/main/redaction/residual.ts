import {
  REDACTION_RESIDUAL_FULL_ENTROPY,
  REDACTION_RESIDUAL_FULL_LENGTH,
  REDACTION_RESIDUAL_MAX_TEXT,
  REDACTION_RESIDUAL_MIN_LENGTH
} from '@shared/constants'
import type { ResidualShape } from '@shared/types'

/**
 * 「可能漏了什么」那一段的打分。
 *
 * 全是纯函数：不 import `report.ts`，不 import `redact.ts`，不碰 I/O。这样
 * 「这个串为什么排第三」能被单测直接问，不用先攒出一个会话来。
 *
 * 这个模块回答的问题和打码规则完全相反。规则说的是「我认得它，所以打掉」；
 * 这里说的是「五个阶段都没认出它，但它看起来不像人写的字」—— 没有键名、没有
 * 已知格式，只剩下形态本身。所以这里给的是**排序**而不是判断：分数只用来把
 * 最值得看一眼的排在最前面，任何一条都不会因为分数低而消失。
 */

/** 一个候选片段。`at` 只给形态判定用（data URI 要回头看前面），不进报告。 */
export interface ResidualToken {
  text: string
  at: number
}

/**
 * 候选片段的字符集。
 *
 * 这张表是整个模块最要紧的一个决定，它故意**不含** `:` `;` `,` `@` `\` 和
 * 全部中日韩文字。三个后果都值得写下来：
 *
 * 1. **CJK 永远不会成词。** 设计文档担心的「中文按字节算熵很高」，在这里是被
 *    分词器解决的，不是被一个惩罚系数解决的 —— 用系数的话，一段中文正文照样会
 *    进候选、照样要打分、照样在极端情况下冒到前 20；不入表则是它压根不存在。
 * 2. **`[已打码]` 永远不会成词，也不会把它两边的文本粘起来。** 方括号和中文都
 *    不在表内，占位符天然是分隔符。所以这里不需要「跳过占位符」那种判断。
 * 3. **Windows 的 `\` 是分隔符，POSIX 的 `/` 不是。** `C:\Users\demo\project`
 *    会被切成一堆不到 20 字符的碎片、直接落榜；`/home/demo/project/src` 作为
 *    一个整词进来，然后吃 `path` 的降权。两条路径待遇不同，但都不会冒头。
 */
const TOKEN_PATTERN = new RegExp(
  `[A-Za-z0-9+/=_.~-]{${REDACTION_RESIDUAL_MIN_LENGTH},}`,
  'g'
)

/**
 * 形态判定往前看多少个字符。
 *
 * 只为一件事存在：认出 data URI 里的 base64。`;base64,` 是 8 个字符，16 有余量。
 */
const LOOKBEHIND = 16

/** 三项权重，和为 1。熵 > 混合度 > 长度：日志里长东西太多了，长度只该帮点忙。 */
const ENTROPY_WEIGHT = 0.45
const MIX_WEIGHT = 0.3
const LENGTH_WEIGHT = 0.25

/** 四个字符类。混合度 = (用到的类数 - 1) / (类数 - 1)。 */
const CHAR_CLASS_COUNT = 4

const INTEGRITY_PATTERN = /^sha(?:256|384|512)-/
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const GIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/
const NUMERIC_PATTERN = /^[0-9._,-]+$/
const LOWER_WORDS_PATTERN = /^[a-z][a-z0-9._-]*$/
/**
 * 点分的大小写混排标识符：`Microsoft.Extensions.Logging`、
 * `document.documentElement.dataset.theme` 这类。
 *
 * 它是 `lower-words` 的大小写混排版。分成两条而不是把 `lower-words` 放宽，
 * 是因为放宽会让「全小写的标识符」那句说法变成假话 —— 一个多出来的大写字母
 * 就是这一族之前躲过降权的全部原因，代价是它们靠混合度那一项拿到了高分。
 *
 * 只认 `.`，不认 `-` 和 `_`：base64url 的字母表里有 `-` 和 `_`，认了它们
 * 就会把真密钥一起降权。`.` 不在任何 base64 变体里，而三段点分的 JWT
 * 早在 `known-secret:jwt` 那一步就被打掉了，到不了这里。
 */
const DOTTED_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/
/**
 * 会话格式自己发的工具调用 id。
 *
 * 这是真实数据里量最大的一类残留 —— 24 个真实会话的高分残留里，三分之一是
 * 它。它不是「别人给的凭据」，是这个工具的管线自己写进 `call_id` 的东西，
 * 所以它挤在前面的每一行都是纯粹的浪费。
 *
 * 只认 `call_` 这一个前缀，不写成 `前缀_不透明串` 的通式：真实数据里除了
 * `call_` 没有第二个前缀成规模出现，而通式会连 `gs_…`、`oauth_…` 这种
 * **可能真是凭据**的东西一起降权 —— 那正是这一段要防的事。
 */
const CALL_ID_PATTERN = /^call_[A-Za-z0-9]+$/
/** 超过这个长度就算「数据块」而不是密钥：真密钥没这么长，PEM 块另有规则管。 */
const LONG_BLOB_LENGTH = 512
/** 认成路径至少要有两个 `/`，且不含 base64 独有的 `+` `=`。 */
const PATH_SEGMENTS = 2

/** 切出所有候选片段。 */
export function tokenize(text: string): ResidualToken[] {
  const tokens: ResidualToken[] = []
  TOKEN_PATTERN.lastIndex = 0
  for (let match = TOKEN_PATTERN.exec(text); match !== null; match = TOKEN_PATTERN.exec(text)) {
    tokens.push({ text: match[0], at: match.index })
  }
  return tokens
}

/** 片段前面那一小段原文，交给 `detectShape` 认 data URI。 */
export function lookBehind(text: string, at: number): string {
  return text.slice(Math.max(0, at - LOOKBEHIND), at)
}

/**
 * Shannon 熵，比特/字符。
 *
 * `Math.log2` 是 IEEE-754 规定的确定性运算，同一个输入在任何机器上同一个结果；
 * 何况分数最后要 `Math.round` 成整数，浮点末位的差别根本传不出来。
 */
export function shannonEntropy(value: string): number {
  const chars = [...value]
  if (chars.length === 0) return 0

  const counts = new Map<string, number>()
  for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1)

  let bits = 0
  for (const count of counts.values()) {
    const p = count / chars.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/** 用到了几个字符类：小写、大写、数字、其他。 */
export function charClasses(value: string): number {
  let lower = false
  let upper = false
  let digit = false
  let other = false

  for (const char of value) {
    if (char >= 'a' && char <= 'z') lower = true
    else if (char >= 'A' && char <= 'Z') upper = true
    else if (char >= '0' && char <= '9') digit = true
    else other = true
  }

  return [lower, upper, digit, other].filter(Boolean).length
}

/**
 * 这个片段长得像什么。**第一个匹配的赢**，所以下面的顺序本身就是语义。
 *
 * `before` 是唯一的外部输入，也是回报最高的一个：带截图的会话里，一张图的
 * base64 能有几十万字符，认不出它，前 20 条会被同一张图的碎片占满。
 *
 * 两处插队值得说明。`call-id` 排在 `git-sha` 前面：它带下划线，和前面几条
 * 都不冲突，早判早停。`dotted-name` 排在 `lower-words` **后面**：一个全小写
 * 的点分名字该说成「全小写的标识符」，那是更具体的一句话；落到 `dotted-name`
 * 的于是只剩下真正大小写混排的那些，正是之前躲过降权的那一族。
 */
export function detectShape(token: string, before: string): ResidualShape | null {
  if (before.endsWith('base64,')) return 'data-uri'
  if (INTEGRITY_PATTERN.test(token)) return 'integrity-hash'
  if (UUID_PATTERN.test(token)) return 'uuid'
  if (CALL_ID_PATTERN.test(token)) return 'call-id'
  if (GIT_SHA_PATTERN.test(token)) return 'git-sha'
  if (NUMERIC_PATTERN.test(token)) return 'numeric'
  if (LOWER_WORDS_PATTERN.test(token)) return 'lower-words'
  if (DOTTED_NAME_PATTERN.test(token)) return 'dotted-name'
  if (token.length >= LONG_BLOB_LENGTH) return 'long-blob'
  if (isPathLike(token)) return 'path'
  return null
}

/**
 * 路径的判定比别的形态多两个条件，为的是别把 base64 当成路径。
 *
 * base64 的字母表里有 `/`，一坨随机 base64 很容易凑出两三个斜杠。`+` 和 `=`
 * 只在 base64 里出现、不会出现在路径里，拿它们当排除项最省事。
 */
function isPathLike(token: string): boolean {
  if (token.includes('+') || token.includes('=')) return false
  let slashes = 0
  for (const char of token) {
    if (char === '/') slashes += 1
  }
  return slashes >= PATH_SEGMENTS
}

/**
 * 形态的降权系数。
 *
 * 每一个都**严格小于 1 且严格大于 0**，后半句和「排除只降权、不删除」是同一句话
 * 的两种说法：乘 0 就等于删除，而真密钥恰好长得像 UUID 的时候，删除是把唯一
 * 值得看的那一条彻底藏起来。
 */
export function shapePenalty(shape: ResidualShape | null): number {
  switch (shape) {
    // 一张截图、一串时间戳、工具自己发的调用 id —— 这三类的量最大，压得最狠。
    // `call-id` 还多一条理由：那串东西是这个工具的管线写出来的，压根不是
    // 任何人给的凭据。
    case 'data-uri':
      return 0.05
    case 'numeric':
      return 0.05
    case 'call-id':
      return 0.05
    // 锁文件哈希、minified 标识符、点分的代码名字、超长数据块：形态很明确，
    // 但不是零可能。
    case 'integrity-hash':
      return 0.1
    case 'lower-words':
      return 0.1
    case 'dotted-name':
      return 0.1
    case 'long-blob':
      return 0.1
    // UUID 和提交号压得最轻：这两种形态里**真的**可能藏着别人给的凭据。
    case 'uuid':
      return 0.15
    case 'git-sha':
      return 0.2
    case 'path':
      return 0.2
    case null:
      return 1
  }
}

/**
 * 可疑度，0—100 的整数。
 *
 * 三项加权之后乘形态系数。基准值都在 `residualScore.test.ts` 里钉死了：
 * 20 字符大小写数字混排、不落任何形态的密钥 63 分，44 字符的同类 79 分；
 * 长 POSIX 路径 13 分，40 位十六进制提交号 12 分，UUID、锁文件完整性串、
 * 超长数据块各 10 分，点分的代码名字 7 分，长小写包名 6 分，
 * data URI 里的 base64 5 分，工具调用 id 4 分，一串毫秒时间戳 2 分。
 * 真密钥和噪音之间隔着五倍，这才是排序有用的原因。
 *
 * 熵和混合度都只看开头 REDACTION_RESIDUAL_MAX_TEXT 个字符 —— 也就是面板上真正
 * 显示出来的那一段。这既省掉了对几十万字符求熵的开销，也让「分数」和「用户看到的
 * 东西」对得上。长度分用的是**真实**长度。
 */
export function scoreResidual(
  token: string,
  before: string
): { score: number; shape: ResidualShape | null } {
  const shape = detectShape(token, before)
  const head = token.slice(0, REDACTION_RESIDUAL_MAX_TEXT)

  const entropyPart = Math.min(1, shannonEntropy(head) / REDACTION_RESIDUAL_FULL_ENTROPY)
  const mixPart = (charClasses(head) - 1) / (CHAR_CLASS_COUNT - 1)
  const lengthPart = Math.min(
    1,
    Math.max(
      0,
      (token.length - REDACTION_RESIDUAL_MIN_LENGTH) /
        (REDACTION_RESIDUAL_FULL_LENGTH - REDACTION_RESIDUAL_MIN_LENGTH)
    )
  )

  const weighted =
    ENTROPY_WEIGHT * entropyPart + MIX_WEIGHT * mixPart + LENGTH_WEIGHT * lengthPart

  return { score: Math.round(100 * shapePenalty(shape) * weighted), shape }
}
