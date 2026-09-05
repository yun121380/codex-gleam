import { REDACTION_PLACEHOLDER } from '@shared/constants'
import type { KeptReason } from '@shared/types'

/**
 * 敏感键名判定。
 *
 * 两个容易出错的地方在这里被专门处理：
 *   1. `author` 里含有 "auth"，不能因此被当成敏感字段；
 *   2. `input_tokens` / `token_count` 是用量统计，不是密钥。
 */

const SENSITIVE_KEY_PATTERN =
  /(?:^|[^a-z0-9])(api[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|id[_-]?tokens?|auth[_-]?tokens?|session[_-]?tokens?|bearer[_-]?tokens?|tokens?|passwords?|passwd|pwd|secrets?|client[_-]?secrets?|authorization|cookies?|credentials?|passphrase|private[_-]?keys?|secret[_-]?keys?|signing[_-]?keys?|encryption[_-]?keys?|connection[_-]?strings?|dsn)(?:$|[^a-z0-9])/i

/** 这些键名带 token/key 字样，但其实是计数或配置，不能打码。 */
const TOKEN_METRIC_PATTERN =
  /(token[_-]?(count|counts|usage|used|limit|budget|window|per[_-]?second)|(input|output|total|cached|max|min|prompt|completion|reasoning|num|new|remaining)[_-]?tokens?|tokenizer|tokenize|keyboard|keywords?|keypath|keystrokes?|key[_-]?(name|order|code|press)|monkey|turkey)/i

/** 把 camelCase / kebab-case 统一成 snake_case，方便用同一套规则匹配。 */
export function normalizeKeyName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toLowerCase()
}

export function isSensitiveKey(key: string): boolean {
  if (typeof key !== 'string' || key === '') return false
  const normalized = normalizeKeyName(key)
  if (TOKEN_METRIC_PATTERN.test(normalized)) return false
  return SENSITIVE_KEY_PATTERN.test(normalized)
}

const NON_SECRET_VALUE_PATTERN =
  /^(?:true|false|null|none|nil|undefined|empty|n\/a|-|\?+|\*+|x{3,}|•+|<[^>]*>|\[[^\]]*\]|\{[^}]*\}|\d+(?:\.\d+)?)$/i

/** 值明显不是密钥时不打码，避免把 `"token": 0` 也变成一堆方块。 */
export function shouldMaskValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 4) return false
  // 已经被前面的规则打过码了（可能只截到一半，比如 "[已打码"），不要再打一次。
  if (trimmed.includes(REDACTION_PLACEHOLDER) || trimmed.includes('已打码')) return false
  // 占位符、模板变量、括号包裹的内容都不是真正的密钥。
  if (/^[[<({]/.test(trimmed)) return false
  if (NON_SECRET_VALUE_PATTERN.test(trimmed)) return false
  return true
}

/**
 * 沾没沾敏感词。宽松版：不管词形，只问「值不值得解释」。
 *
 * 它存在的唯一理由是**别把面板灌满**。`keyKeptReason` 要回答的是「这个键名为什么
 * 没被当成敏感的」，而库里绝大多数键名（`id`、`timestamp`、`content`）跟这件事
 * 毫无关系 —— 它们不是「被排除的敏感键名」，报出来会把真正值得看的那几条埋掉。
 */
const SENSITIVE_HINT_PATTERN = /auth|token|key|secret|pass|pwd|cookie|credential|dsn/i

/**
 * 键名为什么**没**被判为敏感。
 *
 * `null` 有两种含义，都表示「没什么可解释的」：它确实敏感（那是命中，不是排除），
 * 或者它跟敏感词毫无关系。
 *
 * 顺序有讲究：TOKEN_METRIC 必须排在 isSensitiveKey 前面。isSensitiveKey 内部对
 * 计数类键名也返回 false，两种「false」在它那里是一样的，在这里必须分开 ——
 * `input_tokens` 是「这是个计数」，`author` 是「词形不符」，用户读到的是两句话。
 */
export function keyKeptReason(key: string): KeptReason | null {
  if (typeof key !== 'string' || key === '') return null
  const normalized = normalizeKeyName(key)
  if (!SENSITIVE_HINT_PATTERN.test(normalized)) return null
  if (TOKEN_METRIC_PATTERN.test(normalized)) return 'metric-name'
  if (isSensitiveKey(key)) return null
  return 'name-not-matched'
}

/**
 * 值为什么**没**被打码。只在键名已经判为敏感时问这个。
 *
 * 这里的判断顺序和 shouldMaskValue 只差一处：**占位符挪到了最前面**。
 * shouldMaskValue 先看长度再看占位符，两个顺序的结果一样、先看长度还更省；
 * 但这里不行 —— 被前面阶段截半的 `[已打码` 有 4 个字符、还以 `[` 开头，顺序反了
 * 就会被报成 value-is-template，那是在说「这个值是个模板变量」，而它其实是
 * 「这个值刚刚已经被打过码了」。已经打过码不是排除，返回 null。
 *
 * 其余三条保持和 shouldMaskValue 完全相同的先后，因为这份报告要能被反驳：
 * 报出来的原因必须是**真正让 shouldMaskValue 返回 false 的那一行**。
 */
export function valueKeptReason(value: string): KeptReason | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.includes(REDACTION_PLACEHOLDER) || trimmed.includes('已打码')) return null
  if (trimmed.length < 4) return 'value-too-short'
  if (/^[[<({]/.test(trimmed)) return 'value-is-template'
  if (NON_SECRET_VALUE_PATTERN.test(trimmed)) return 'value-not-secret'
  return null
}

export interface TextPattern {
  name: string
  pattern: RegExp
  /** 需要打码的捕获组序号；0 表示整段。 */
  group: number
}

/**
 * 已知格式的密钥。即使没有键名提示，只要长得像密钥就打码。
 * 全部使用虚构示例验证，不针对任何真实密钥。
 */
export const KNOWN_SECRET_PATTERNS: readonly TextPattern[] = [
  { name: 'openai', pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g, group: 0 },
  { name: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, group: 0 },
  { name: 'slack', pattern: /\bxox[abpsroe]-[A-Za-z0-9-]{10,}\b/g, group: 0 },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0 },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, group: 0 },
  { name: 'google-oauth', pattern: /\bya29\.[A-Za-z0-9_-]{20,}\b/g, group: 0 },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g, group: 0 },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, group: 0 },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    group: 0
  },
  // https://user:password@host
  { name: 'url-credentials', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, group: 2 }
]

/** `Authorization: Bearer xxx` 这类"方案 + 凭据"的写法。 */
export const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic|Token|ApiKey)\s+([A-Za-z0-9._~+/=-]{8,})/gi

/** `Cookie: a=1; b=2` 整行打码。 */
export const COOKIE_LINE_PATTERN = /\b(set-cookie|cookie)(\s*[:=]\s*)([^\r\n]+)/gi

/** `--token xxx` / `--api-key=xxx` 这类命令行参数。 */
export const CLI_FLAG_PATTERN =
  /(--?(?:token|api[-_]?key|password|passwd|secret|auth|authorization|credential|pass)(?:[=\s]+))(["']?)([^\s"']{4,})\2/gi

/**
 * `KEY: value` / `KEY=value` / `"KEY": "value"` 通用写法。
 *
 * 值的边界规则是这里唯一复杂的地方，三条都是实测踩出来的：
 *
 *   1. **允许空格**。`password: my secret phrase` 里的密码是三个词。
 *      不允许空格的话，要么只打码第一个词、要么（第一个词不足 4 字符时）
 *      整条都不打码 —— 实测 `"password": "my secret phrase"` 原样泄露。
 *   2. **但遇到下一个运算符就停**。既然允许空格，值就会一路吞到行尾，
 *      两种情况都会出事：
 *        - `user=demo password=x` 被整条当成 user 的值，后面那个真密钥
 *          永远轮不到检查；
 *        - 源码里的 `password: str = Field(min_length=6)` 会被整段糊掉 ——
 *          `str` 是类型名不是密码，而这个工具的正事就是让人看清代码改了什么。
 *      所以空白后面接着 `键=` / `键:` 或者直接接着 `=` / `:` 时，值就到此为止。
 *   3. **遇到 `\n` `\r` `\t` `\u` 这类字面转义序列就停**。在被转义过的
 *      JSON 字符串里（"原始数据"面板就是这个形态），否则一次打码会吞掉后面一整行。
 */
export const KEY_VALUE_PATTERN =
  /(["'`]?)([A-Za-z][A-Za-z0-9_.-]{1,60})\1(\s*(?::|=>|=)\s*)(["'`]?)((?:(?!\s+(?:[A-Za-z][A-Za-z0-9_.-]{0,60}\s*)?(?::|=>|=))(?!\\[nrtu])[^\r\n"'`,;)\]}]){1,2048})\4/g
