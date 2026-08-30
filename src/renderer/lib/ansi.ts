/**
 * 极简 ANSI 转义解析器。
 *
 * 命令输出里常带颜色码（比如测试框架的红绿输出）。直接原样显示会看到一堆
 * `[32m` 噪音，所以这里把 SGR 序列翻译成可渲染的样式片段，其余控制序列丢弃。
 * 换行与空格全部保留，交给 CSS 的 white-space: pre-wrap 处理。
 */

export interface AnsiSpan {
  text: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  background?: string
}

const BASIC_COLORS = [
  '#7d8590',
  '#f0716f',
  '#59c37a',
  '#d9a441',
  '#6aa9f0',
  '#b28ce8',
  '#4bb8b0',
  '#d7d2c8'
]

const BRIGHT_COLORS = [
  '#9aa2ad',
  '#ff8f8d',
  '#77d996',
  '#f0c05f',
  '#8ec0f7',
  '#c9a8f2',
  '#68d3cb',
  '#f2eee6'
]

function xterm256(index: number): string {
  if (index < 8) return BASIC_COLORS[index] ?? '#d7d2c8'
  if (index < 16) return BRIGHT_COLORS[index - 8] ?? '#f2eee6'
  if (index < 232) {
    const value = index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(value / 36) % 6] ?? 0
    const g = steps[Math.floor(value / 6) % 6] ?? 0
    const b = steps[value % 6] ?? 0
    return `rgb(${r}, ${g}, ${b})`
  }
  const gray = 8 + (index - 232) * 10
  return `rgb(${gray}, ${gray}, ${gray})`
}

interface Style {
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  background?: string
}

function applyCodes(style: Style, codes: number[]): Style {
  const next: Style = { ...style }

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0

    if (code === 0) {
      for (const key of Object.keys(next) as Array<keyof Style>) delete next[key]
      continue
    }
    if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 22) {
      delete next.bold
      delete next.dim
    } else if (code === 23) delete next.italic
    else if (code === 24) delete next.underline
    else if (code >= 30 && code <= 37) next.color = BASIC_COLORS[code - 30]
    else if (code === 39) delete next.color
    else if (code >= 40 && code <= 47) next.background = BASIC_COLORS[code - 40]
    else if (code === 49) delete next.background
    else if (code >= 90 && code <= 97) next.color = BRIGHT_COLORS[code - 90]
    else if (code >= 100 && code <= 107) next.background = BRIGHT_COLORS[code - 100]
    else if (code === 38 || code === 48) {
      const mode = codes[index + 1]
      const target = code === 38 ? 'color' : 'background'
      if (mode === 5) {
        const value = codes[index + 2]
        if (value !== undefined) next[target] = xterm256(value)
        index += 2
      } else if (mode === 2) {
        const r = codes[index + 2] ?? 0
        const g = codes[index + 3] ?? 0
        const b = codes[index + 4] ?? 0
        next[target] = `rgb(${r}, ${g}, ${b})`
        index += 4
      }
    }
  }

  return next
}

// CSI 序列（含 SGR）、OSC 序列、以及零散的控制字符。
// 这里必须匹配控制字符 —— 转义序列本身就是由 ESC(0x1B) 开头的控制码组成的。
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[([0-9;:]*)([A-Za-z])|\][^]*(?:|\\)|[@-Z\\-_]/g

export function parseAnsi(input: string): AnsiSpan[] {
  if (typeof input !== 'string' || input === '') return []

  const spans: AnsiSpan[] = []
  let style: Style = {}
  let lastIndex = 0

  const push = (text: string): void => {
    if (text === '') return
    spans.push({ text, ...style })
  }

  ANSI_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ANSI_PATTERN.exec(input)) !== null) {
    push(input.slice(lastIndex, match.index))
    lastIndex = match.index + match[0].length

    const parameters = match[1]
    const command = match[2]
    if (command === 'm') {
      const codes = (parameters ?? '')
        .split(';')
        .map((part) => (part === '' ? 0 : Number.parseInt(part, 10)))
        .filter((value) => Number.isFinite(value))
      style = applyCodes(style, codes)
    }
    // 其他 CSI 命令（光标移动、清屏等）在静态展示里没有意义，直接丢弃。
  }

  push(input.slice(lastIndex))
  return spans
}

/** 去掉全部转义序列，用于搜索与纯文本导出。 */
export function stripAnsi(input: string): string {
  if (typeof input !== 'string') return ''
  ANSI_PATTERN.lastIndex = 0
  return input.replace(ANSI_PATTERN, '')
}
