import type { Platform } from '@shared/types'

/**
 * resume 命令的模板填充。
 *
 * 这里只做一件事：把模板里的占位符换成这个会话的真实值，或者说清为什么换不了。
 * **绝不执行**任何东西——执行外部程序要 `child_process`，那是本应用的红线，
 * `tests/security/offline.test.ts` 扫整个 `src/` 拦着它。命令拼好只进剪贴板。
 */

/** 我们认识的占位符。模板里其它 `{…}` 一律当字面文本，原样留着。 */
const PLACEHOLDERS = ['dir', 'threadId'] as const

type Placeholder = (typeof PLACEHOLDERS)[number]

/**
 * 各平台的默认模板。
 *
 * 设计稿写的是 `cd -- {dir} && codex resume {threadId}`，那是 POSIX 的写法：
 * Windows 上 cmd.exe 的 `cd` 不认 `--`，而且不带 `/d` 时**不会跨盘符切换**
 * ——项目在 D: 而终端在 C: 时，那条命令会一声不响地留在原地。
 * 默认值必须在本机直接可用，所以按平台分开给。
 *
 * 引号写在模板里，不做自动补引号：路径里有空格是常态，
 * 而"用户看到的模板 = 他拿到的命令"这条比省几个字符重要。
 */
export function defaultResumeTemplate(platform: Platform): string {
  return platform === 'win32'
    ? 'cd /d "{dir}" && codex resume {threadId}'
    : 'cd -- "{dir}" && codex resume {threadId}'
}

export interface ResumeInput {
  /** 模板；空字符串或全空白表示跟随平台默认。 */
  template: string
  platform: Platform
  /** 真实项目目录，不是打码后的显示路径——缩写路径 cd 不过去。 */
  dir: string | null
  /** Codex 自己的会话 id（rollout 里的 session_id）。 */
  threadId: string | null
}

export type ResumeCommand =
  | { ok: true; command: string }
  /** reason 直接显示在界面上，detail 进 title 讲清为什么。 */
  | { ok: false; reason: string; detail: string }

/**
 * 拼出 resume 命令，或说清拼不出来的原因。
 *
 * 拼不出来时不返回半成品：`codex resume {threadId}` 粘到终端里会真的执行，
 * 报出来的错跟"我们没这个数据"隔着好几层，用户得自己反推。
 */
export function buildResumeCommand(input: ResumeInput): ResumeCommand {
  const template = input.template.trim() === ''
    ? defaultResumeTemplate(input.platform)
    : input.template

  const values: Record<Placeholder, string | null> = {
    dir: clean(input.dir),
    threadId: clean(input.threadId)
  }

  // 只看模板真的用到的占位符：用户把 `cd` 那一段删掉之后，
  // 会话没记项目目录就不该再挡着他复制。
  const missing = PLACEHOLDERS.filter(
    (name) => template.includes(`{${name}}`) && values[name] === null
  )
  if (missing.length > 0) return explain(missing)

  // 一次扫完，不逐个 replaceAll：先填进去的值里若正好含 `{threadId}`
  // （目录可以叫这个名字），第二轮会把它当占位符再替换一次。
  // 用函数形式的替换，值里的 `$&` 之类也就不会被当成特殊记法。
  const command = template.replace(/\{(dir|threadId)\}/g, (_match, name: Placeholder) => {
    return values[name] ?? ''
  })

  return { ok: true, command }
}

/**
 * 剥掉控制字符再填进命令里。
 *
 * 这串字符是要粘到终端里跑的：路径里只要混进一个换行，一条命令就变成两条，
 * 第二条是什么完全取决于路径长什么样。剥完剩空串就当没有这个值。
 */
function clean(value: string | null): string | null {
  if (value === null) return null
  // 这里必须匹配控制字符 —— 要剥掉的正是它们本身。
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return stripped === '' ? null : stripped
}

/** 缺哪个说哪个。两个都缺就两句都给。 */
function explain(missing: Placeholder[]): ResumeCommand {
  const reasons: string[] = []
  const details: string[] = []

  if (missing.includes('threadId')) {
    reasons.push('日志没记会话 id')
    details.push('codex resume 认的是 rollout 文件里的 session_id，这份日志里没有。')
  }
  if (missing.includes('dir')) {
    reasons.push('日志没记项目目录')
    details.push('这份日志里没有项目目录，cd 不知道该去哪儿。')
  }

  return {
    ok: false,
    reason: `${reasons.join('、')}，拼不出 resume 命令`,
    detail: `${details.join('')}模板里的占位符填不出来，所以这里不给一条半成品命令。`
  }
}
