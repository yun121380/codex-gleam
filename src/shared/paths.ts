import type { Platform } from './types'

/**
 * 路径展示里唯一一段两个进程都要用的逻辑。
 *
 * 主进程用它算 displayTitle / displayCommand；渲染进程用它处理**用户随时能改的**
 * 那些路径 —— 自定义扫描目录是设置页现场输入的，主进程没法提前算好一份展示版，
 * 算好了也会立刻过期。
 *
 * 放在 shared 里不会削弱什么：渲染进程本来就必须拿到真实绝对路径
 * （relatedFiles、sourceFile、workingDirectory 都得原样传过去，
 * 否则「在文件管理器中定位」无从谈起）。这里要防的是**显示**，不是持有。
 */

/**
 * 把**夹在文本里**的用户主目录换成 `~`。
 *
 * 整串就是一个路径时用 toDisplayPath；这个函数处理路径长在句子中间的情况 ——
 * 事件标题（`读取 C:\Users\alice\proj\a.ts`）、整条 shell 命令都是这样。
 *
 * 边界不能省：主目录后面必须紧跟分隔符、字符串末尾，或一个不可能出现在路径名里的
 * 字符。否则 `C:\Users\bob` 会把 `C:\Users\bobby\x` 也啃掉一半 —— 用户名没藏住，
 * 路径还成了假的。
 */
export function maskHomePaths(
  text: string,
  options: { homeDir?: string | null; platform?: Platform }
): string {
  if (!text) return text

  const home = options.homeDir
  if (!home) return text

  const trimmed = home.trim().replace(/[\\/]+$/, '')
  // 没有分隔符的“主目录”（`C:`、空串）不认：拿它去替换只会伤到无关文本。
  if (trimmed === '' || !/[\\/]/.test(trimmed)) return text

  const platform = options.platform ?? 'win32'
  // 日志里两种分隔符都会出现，所以每个分隔位都放宽成 `[\\/]+`。
  const body = trimmed
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]+')

  const pattern = new RegExp(`${body}(?=[\\\\/]|$|[^\\w.\\-])`, platform === 'win32' ? 'gi' : 'g')
  return text.replace(pattern, '~')
}
