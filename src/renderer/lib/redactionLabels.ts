/**
 * 报告里那些规则名与排除理由的中文说法。
 *
 * 放在 lib 里而不是写进 JSX，图的是两件事：这些说法能单测（每一条都得非空、互不
 * 相同），以及**没有兜底文案**。一个认不出规则就回「未知规则」的标签函数，会让
 * 「加了新规则但忘了配文案」这件事在界面上完全看不出来 —— 而这个面板全部的用处
 * 就在于它说的话是准的。
 *
 * 所以做法是：五条固定规则穷举，`known-secret:` 那一族按模式名拼出来。
 * `KNOWN_SECRET_PATTERNS` 将来加一条，标签自动变成「已知格式的密钥 · 新名字」，
 * 解释退成一句仍然为真的话 —— 不假装认识它。
 */
import type { KeptReason } from '@shared/types'

/** `known-secret:openai` 里冒号连着的那一半。 */
const KNOWN_SECRET_PREFIX = 'known-secret:'

const KNOWN_SECRET_LABEL = '已知格式的密钥'

/** 五条固定规则。`known-secret:` 不在这里 —— 它带模式名，得拼。 */
const RULE_LABELS: Record<string, string> = {
  'cookie-line': 'Cookie 行',
  'auth-scheme': 'Authorization 头',
  'cli-flag': '命令行参数',
  'key-value': '键值对赋值',
  'sensitive-key': '原始数据里的敏感键名'
}

const RULE_HINTS: Record<string, string> = {
  'cookie-line': '整行一起打掉 —— 一行 Cookie 里哪一段是会话凭据，从行里看不出来。',
  'auth-scheme': 'Bearer / Basic / Token / ApiKey 后面跟着的那一串。',
  'cli-flag': '命令里 --token、--api-key 这类参数带的值。',
  'key-value': '文本里 key: value 或 key=value 这种写法，键名带敏感词时打掉值。',
  'sensitive-key': '原始 JSON 里键名带敏感词的字段，逐层往下找出来的。'
}

/**
 * 每种已知格式一句话。
 *
 * 这一族的规则是"这串东西自己长什么样"，不看键名也不看上下文 —— 所以每句话说的都是
 * 那个格式的写法。认不出的名字走 `unknownSecretHint`，不假装认识。
 */
const KNOWN_SECRET_HINTS: Record<string, string> = {
  openai: 'OpenAI 那种 sk- 开头的密钥，按它自己的格式认出来的。',
  'github-token': 'GitHub 的 ghp_ / gho_ / github_pat_ 开头的访问令牌。',
  slack: 'Slack 的 xoxb- / xoxp- 这类令牌。',
  'aws-access-key': 'AWS 的 AKIA / ASIA 开头的访问密钥 ID。',
  'google-api-key': 'Google 的 AIza 开头的 API 密钥。',
  'google-oauth': 'Google 的 ya29. 开头的 OAuth 访问令牌。',
  'npm-token': 'npm 的 npm_ 开头的发布令牌。',
  jwt: '三段点号分隔的 JWT。里面通常带着身份信息，哪怕没过期也不该分享。',
  'private-key-block': 'PEM 私钥块，从 BEGIN 到 END 整段打掉。',
  'url-credentials': '网址里 user:password@host 这种写在链接里的密码。'
}

/** 认不出的模式名。把名字说出来，让"忘了配文案"这件事在界面上看得见。 */
function unknownSecretHint(name: string): string {
  return `按 KNOWN_SECRET_PATTERNS 里名为「${name}」的那条格式认出来的；界面上还没有给它配说明。`
}

/**
 * 规则的中文名。
 *
 * 认不出来时返回规则名本身，**不**返回「未知规则」—— 界面上冒出一个英文规则名，
 * 是在说"这里少了一条文案"，而「未知规则」什么都没说。
 */
export function ruleLabel(rule: string): string {
  if (rule.startsWith(KNOWN_SECRET_PREFIX)) {
    return `${KNOWN_SECRET_LABEL} · ${rule.slice(KNOWN_SECRET_PREFIX.length)}`
  }
  return RULE_LABELS[rule] ?? rule
}

/** 规则底下那一句解释：这条规则凭什么认定那是密钥。 */
export function ruleHint(rule: string): string {
  if (rule.startsWith(KNOWN_SECRET_PREFIX)) {
    const name = rule.slice(KNOWN_SECRET_PREFIX.length)
    return KNOWN_SECRET_HINTS[name] ?? unknownSecretHint(name)
  }
  return RULE_HINTS[rule] ?? `界面上还没有给「${rule}」这条规则配说明。`
}

/**
 * 为什么这一条**没**被打码。
 *
 * 说的是理由而不是规则名：用户看到 `author` 被排除，要能立刻明白是"词形不符"，
 * 而不是去猜 `name-not-matched` 是什么意思。
 */
export function keptReasonLabel(reason: KeptReason): string {
  return KEPT_REASON_LABELS[reason]
}

const KEPT_REASON_LABELS: Record<KeptReason, string> = {
  'metric-name': '键名是计数或配置项，不是密钥（input_tokens、keyboard 这类）',
  'name-not-matched': '键名里有敏感词，但不是独立的词（author 里的 auth）',
  'value-too-short': '值不到 4 个字符，短到不可能是密钥（源码里的 password: str）',
  'value-is-template': '值是占位符或模板（<your-key>、{{TOKEN}}）',
  'value-not-secret': '值是 true / false / 数字这类，本身不是秘密'
}
