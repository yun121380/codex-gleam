import { CODEX_SESSION_INDEX_FILE, MAX_SESSION_INDEX_LINES } from '@shared/constants'
import { firstString, isRecord, safeJsonParse } from '@shared/validators'
import type { FileSystemAccess } from './fsAccess'

/**
 * Codex 自己给会话起的名字。
 *
 * 从第一条用户消息猜标题永远是猜：Codex Desktop 每次开场都会先注入一段
 * `<recommended_plugins>`，猜出来的标题就全是它。而 Codex 本身在主目录下维护着
 * 一份 `session_index.jsonl`，里面是它为每个会话生成的真实名字
 * （"构思 Codex 生态助力项目"这种）。能读到就用它，读不到再回退去猜。
 *
 * 实测这台机器上 591 个会话里 379 个（64%）能在索引里查到名字。
 *
 * 全程只读，且只读 Codex 目录下的这一个文件 —— 不联网、不写回。
 */
export type ThreadTitles = ReadonlyMap<string, string>

export const EMPTY_THREAD_TITLES: ThreadTitles = new Map()

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/**
 * 从文件名里认出会话 id。
 *
 * Codex 的滚动日志叫 `rollout-<时间>-<会话uuid>.jsonl`，有的还会再跟一个分支 uuid。
 * 会话 id 是第一个 —— 后面那个是这次续写的 id，在索引里查不到。
 */
export function sessionIdsFromFileName(fileName: string): string[] {
  return [...fileName.matchAll(UUID_PATTERN)].map((match) => match[0].toLowerCase())
}

/**
 * 一个文件所有可能的"上级目录"。
 *
 * 手动导入单个文件时没有扫描根目录可用，只能顺着 `…/.codex/sessions/2026/08/29/xxx.jsonl`
 * 一路往上找，看哪一层放着 session_index.jsonl。多试几次失败的 open 很便宜。
 */
export function ancestorDirs(filePath: string, maxLevels = 8): string[] {
  const parts = filePath.split(/[\\/]+/)
  const separator = filePath.includes('\\') ? '\\' : '/'
  const dirs: string[] = []

  for (let end = parts.length - 1; end > 0 && dirs.length < maxLevels; end -= 1) {
    const dir = parts.slice(0, end).join(separator)
    if (dir.trim() !== '') dirs.push(dir)
  }

  return dirs
}

/** 单条索引记录 → [id, 名字]。认不出的行返回 null（坏行不影响其余）。 */
function parseIndexLine(line: string): [string, string] | null {
  const text = line.trim()
  if (text === '' || !text.startsWith('{')) return null

  const parsed = safeJsonParse(text)
  if (!parsed.ok || !isRecord(parsed.value)) return null

  const id = firstString(parsed.value, ['id', 'thread_id', 'threadId', 'session_id', 'sessionId'])
  const name = firstString(parsed.value, ['thread_name', 'threadName', 'title', 'name'])
  if (id === null || name === null) return null

  const trimmed = name.trim()
  if (trimmed === '') return null
  return [id.trim().toLowerCase(), trimmed]
}

/**
 * 读取若干个 Codex 目录下的会话名索引，合并成一张表。
 *
 * 索引不存在、读不出来、内容损坏，都只当作"没有名字"，绝不让扫描失败 ——
 * 标题只是锦上添花，拿不到就回退到猜。
 */
export async function loadThreadTitles(args: {
  fs: FileSystemAccess
  /** 候选根目录。只有直接放着 session_index.jsonl 的那个（Codex 主目录）会命中。 */
  roots: readonly string[]
}): Promise<ThreadTitles> {
  const { fs, roots } = args
  const titles = new Map<string, string>()

  for (const root of roots) {
    if (root.trim() === '') continue
    const indexPath = `${root.replace(/[\\/]+$/, '')}/${CODEX_SESSION_INDEX_FILE}`

    try {
      for await (const chunk of fs.streamLines(indexPath, {
        maxLines: MAX_SESSION_INDEX_LINES,
        maxBytes: 32 * 1024 * 1024
      })) {
        const entry = parseIndexLine(chunk.line)
        // 同一个 id 出现多次时后写的更新，直接覆盖。
        if (entry) titles.set(entry[0], entry[1])
      }
    } catch {
      // 这个目录下没有索引（绝大多数目录都没有），继续看下一个。
      continue
    }
  }

  return titles
}

/** 按会话 id 或文件名查 Codex 给的名字。查不到返回 null。 */
export function lookupThreadTitle(
  titles: ThreadTitles,
  options: { sessionId?: string | null; fileName?: string | null }
): string | null {
  if (titles.size === 0) return null

  const sessionId = options.sessionId?.trim().toLowerCase()
  if (sessionId) {
    const direct = titles.get(sessionId)
    if (direct !== undefined) return direct
  }

  for (const candidate of sessionIdsFromFileName(options.fileName ?? '')) {
    const found = titles.get(candidate)
    if (found !== undefined) return found
  }

  return null
}
