import type { FileChange } from '@shared/types'
import { parsePatchText } from './patch'

/**
 * 工具脚本解析器。
 *
 * 有些 Codex / 智能体 harness 的工具调用参数不是 JSON，而是一小段代码：
 *
 *   const r = await tools.exec_command({ cmd: "npm test", workdir: "C:\\proj" })
 *
 *   const patch = "*** Begin Patch\n*** Update File: src/a.ts\n...";
 *   const r = await tools.apply_patch({ input: patch })
 *
 * 真正有价值的信息（执行了什么命令、改了哪个文件）藏在字符串字面量里。
 * 这个模块把它们抽出来，好让时间线显示「npm test」而不是干巴巴的「执行命令」。
 *
 * 注意：这里只做**文本抽取**，绝不执行任何代码。
 */

interface StringLiteral {
  value: string
  /** 字面量起始引号的下标。 */
  start: number
  /** 结束引号之后的下标。 */
  end: number
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '`': '`',
  '\n': ''
}

/**
 * 从 index 处读取一个 JS 字符串字面量（支持单引号、双引号、反引号与转义）。
 * index 处不是引号时返回 null。
 */
export function readStringLiteral(source: string, index: number): StringLiteral | null {
  const quote = source[index]
  if (quote !== '"' && quote !== "'" && quote !== '`') return null

  let out = ''
  let cursor = index + 1

  while (cursor < source.length) {
    const char = source[cursor]

    if (char === '\\') {
      const next = source[cursor + 1]
      if (next === undefined) break

      if (next === 'u') {
        // \uXXXX 或 \u{XXXXX}
        if (source[cursor + 2] === '{') {
          const close = source.indexOf('}', cursor + 3)
          const hex = close < 0 ? '' : source.slice(cursor + 3, close)
          const code = Number.parseInt(hex, 16)
          if (close > 0 && Number.isFinite(code)) {
            out += String.fromCodePoint(code)
            cursor = close + 1
            continue
          }
        } else {
          const code = Number.parseInt(source.slice(cursor + 2, cursor + 6), 16)
          if (Number.isFinite(code)) {
            out += String.fromCharCode(code)
            cursor += 6
            continue
          }
        }
        out += 'u'
        cursor += 2
        continue
      }

      if (next === 'x') {
        const code = Number.parseInt(source.slice(cursor + 2, cursor + 4), 16)
        if (Number.isFinite(code)) {
          out += String.fromCharCode(code)
          cursor += 4
          continue
        }
      }

      out += ESCAPES[next] ?? next
      cursor += 2
      continue
    }

    if (char === quote) {
      return { value: out, start: index, end: cursor + 1 }
    }

    // 普通引号里不允许裸换行；遇到就当字面量没闭合，避免吞掉整段代码。
    if (char === '\n' && quote !== '`') break

    out += char
    cursor += 1
  }

  return null
}

/** 跳过空白与注释，返回下一个有效字符的下标。 */
function skipBlank(source: string, index: number): number {
  let cursor = index
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      cursor += 1
      continue
    }
    if (char === '/' && source[cursor + 1] === '/') {
      const newline = source.indexOf('\n', cursor)
      cursor = newline < 0 ? source.length : newline + 1
      continue
    }
    if (char === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2)
      cursor = close < 0 ? source.length : close + 2
      continue
    }
    break
  }
  return cursor
}

/**
 * 读取 `键: 值` 里的值，支持字符串与字符串数组。
 * 数组会按空格拼成一条命令（["bash","-lc","npm test"] → npm test）。
 */
function readValueAt(source: string, index: number): string | null {
  const cursor = skipBlank(source, index)

  const literal = readStringLiteral(source, cursor)
  if (literal) return literal.value

  if (source[cursor] === '[') {
    const parts: string[] = []
    let inner = cursor + 1
    for (let guard = 0; guard < 64; guard += 1) {
      inner = skipBlank(source, inner)
      if (source[inner] === ']') break
      const entry = readStringLiteral(source, inner)
      if (!entry) break
      parts.push(entry.value)
      inner = skipBlank(source, entry.end)
      if (source[inner] === ',') inner += 1
      else break
    }
    if (parts.length === 0) return null
    return normalizeArgv(parts)
  }

  return null
}

/** ["bash","-lc","npm test"] 这种包装只保留真正的命令。 */
function normalizeArgv(parts: readonly string[]): string {
  const shell = (parts[0] ?? '').toLowerCase()
  const isWrapper = /(^|[\\/])(bash|sh|zsh|dash|cmd(\.exe)?|powershell(\.exe)?|pwsh)$/.test(shell)
  const flagIndex = parts.findIndex((part) => /^(-lc|-c|-ic|\/c|\/k|-Command|-command)$/.test(part))
  if (isWrapper && flagIndex >= 0 && parts.length > flagIndex + 1) {
    return parts.slice(flagIndex + 1).join(' ')
  }
  return parts.join(' ')
}

/** 找出 `键:` 后面的值；同一个键可能出现多次（Promise.all 里并发多个调用）。 */
function collectField(source: string, keys: readonly string[]): string[] {
  const found: string[] = []
  const pattern = new RegExp(`\\b(?:${keys.join('|')})\\s*:`, 'g')

  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const value = readValueAt(source, match.index + match[0].length)
    if (value !== null && value.trim() !== '') found.push(value)
  }
  return found
}

export interface ToolScriptCall {
  /** tools.xxx 里的 xxx。 */
  toolName: string | null
  command: string | null
  workingDirectory: string | null
}

export interface ToolScriptInfo {
  /** 看起来确实是一段调用 tools.* 的代码。 */
  looksLikeToolScript: boolean
  calls: ToolScriptCall[]
  /** 代码里内嵌的补丁（apply_patch 的参数）。 */
  patches: FileChange[]
  /** 抽出的全部命令，按出现顺序。 */
  commands: string[]
  workingDirectory: string | null
}

const TOOL_CALL_PATTERN = /\btools\s*\.\s*([A-Za-z_$][\w$]*)/g
const COMMAND_KEYS = ['cmd', 'command', 'commandLine', 'command_line', 'argv', 'script'] as const
const WORKDIR_KEYS = ['workdir', 'cwd', 'working_directory', 'workingDirectory'] as const

/**
 * 解析一段工具脚本。不是脚本时返回 looksLikeToolScript = false，调用方走原来的逻辑。
 */
export function parseToolScript(source: string): ToolScriptInfo {
  const empty: ToolScriptInfo = {
    looksLikeToolScript: false,
    calls: [],
    patches: [],
    commands: [],
    workingDirectory: null
  }

  if (typeof source !== 'string' || source.trim() === '') return empty

  // 判定标准放得比较严：必须出现 tools.xxx( 或 await + 花括号参数，
  // 否则一段普通的 shell 命令文本也会被误判成代码。
  const hasToolCall = /\btools\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.test(source)
  const hasPatch = /\*\*\* Begin Patch/.test(source)
  if (!hasToolCall && !hasPatch) return empty

  // 按 tools.xxx 的位置把代码切成若干段，每段里找自己的 cmd / workdir。
  const marks: Array<{ name: string; index: number }> = []
  TOOL_CALL_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOOL_CALL_PATTERN.exec(source)) !== null) {
    marks.push({ name: match[1] ?? '', index: match.index })
  }

  const calls: ToolScriptCall[] = []
  const commands: string[] = []
  let workingDirectory: string | null = null

  if (marks.length === 0) {
    // 只有补丁、没有 tools. 调用。
    for (const command of collectField(source, COMMAND_KEYS)) commands.push(command)
    workingDirectory = collectField(source, WORKDIR_KEYS)[0] ?? null
  } else {
    marks.forEach((mark, order) => {
      const from = mark.index
      const to = marks[order + 1]?.index ?? source.length
      const segment = source.slice(from, to)

      const segmentCommands = collectField(segment, COMMAND_KEYS)
      const segmentWorkdir = collectField(segment, WORKDIR_KEYS)[0] ?? null
      if (workingDirectory === null) workingDirectory = segmentWorkdir

      if (segmentCommands.length === 0) {
        calls.push({ toolName: mark.name, command: null, workingDirectory: segmentWorkdir })
        return
      }
      for (const command of segmentCommands) {
        commands.push(command)
        calls.push({ toolName: mark.name, command, workingDirectory: segmentWorkdir })
      }
    })
  }

  // 补丁可能在任意字符串字面量里（常见写法是先 const patch = "..." 再传进去）。
  const patches: FileChange[] = []
  if (hasPatch) {
    for (const literal of allStringLiterals(source)) {
      if (!literal.includes('*** Begin Patch')) continue
      for (const change of parsePatchText(literal)) patches.push(change)
    }
    // 补丁也可能直接写在代码里（没有被引号包住）。
    if (patches.length === 0) {
      for (const change of parsePatchText(source)) patches.push(change)
    }
  }

  return {
    looksLikeToolScript: true,
    calls,
    patches,
    commands,
    workingDirectory
  }
}

/** 扫出源码里所有字符串字面量的值。 */
function allStringLiterals(source: string): string[] {
  const values: string[] = []
  let cursor = 0

  while (cursor < source.length) {
    const char = source[cursor]
    if (char === '"' || char === "'" || char === '`') {
      const literal = readStringLiteral(source, cursor)
      if (literal) {
        values.push(literal.value)
        cursor = literal.end
        continue
      }
    }
    cursor += 1
  }

  return values
}

/**
 * 从输出文本里找命令耗时。
 * 有些 harness 不记录 duration 字段，只在输出末尾写一行 `Wall time 1.2 seconds`。
 */
export function durationFromText(text: string): number | null {
  if (typeof text !== 'string' || text === '') return null

  const seconds = /\bwall(?:[\s_-]?clock)?\s*time[:\s]+([\d.]+)\s*(?:s|sec|secs|seconds?)\b/i.exec(text)
  if (seconds?.[1]) {
    const value = Number.parseFloat(seconds[1])
    if (Number.isFinite(value)) return Math.round(value * 1000)
  }

  const millis = /\bwall(?:[\s_-]?clock)?\s*time[:\s]+([\d.]+)\s*ms\b/i.exec(text)
  if (millis?.[1]) {
    const value = Number.parseFloat(millis[1])
    if (Number.isFinite(value)) return Math.round(value)
  }

  return null
}

/**
 * 只在**毫无歧义**的情况下从输出文本判定失败。
 *
 * 为什么要这么保守：很多 harness 压根不记录退出码，诱惑是"输出里有 error 就算失败"，
 * 但那样 `rg error`、`npm run lint` 打印告警都会被误判成失败 ——
 * 把成功的步骤标成红色比"结果未记录"糟糕得多。
 * 所以这里只认工具自己抛出的错误，以及 shell 明确的\"找不到命令\"。
 */
const HARD_FAILURE_MARKERS: readonly RegExp[] = [
  // harness 自己报告执行失败
  /\bexec_command failed for\b/,
  /^\s*Script error:/m,
  /^\s*ParserError\b/m,
  /\bCommandNotFoundException\b/,
  // shell 找不到命令
  /^\s*bash: .*: command not found\s*$/m,
  /^\s*[a-z]*sh: .*: not found\s*$/m,
  /\bis not recognized as (?:the name of )?an? (?:cmdlet|internal or external command)/i,
  /^\s*'.*' is not recognized as/m,
  // 权限与路径
  /^\s*bash: .*: (?:Permission denied|No such file or directory)\s*$/m
]

export function hasHardFailureMarker(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false
  return HARD_FAILURE_MARKERS.some((pattern) => pattern.test(text))
}

/**
 * 从命令输出的文本里找退出码。
 * 有些 harness 不把退出码放进结构化字段，只在输出里写一行。
 */
export function exitCodeFromText(text: string): number | null {
  if (typeof text !== 'string' || text === '') return null

  const patterns = [
    /\bexit(?:ed)?[\s_-]*(?:code|status)\s*[:=]?\s*(-?\d{1,5})\b/i,
    /\bexit(?:ed)? with (?:code|status)\s*(-?\d{1,5})\b/i,
    /\breturn(?:ed)? code\s*[:=]?\s*(-?\d{1,5})\b/i,
    /\bprocess exited with\s*(-?\d{1,5})\b/i
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)
    const code = match?.[1] === undefined ? null : Number.parseInt(match[1], 10)
    if (code !== null && Number.isFinite(code)) return code
  }

  return null
}
