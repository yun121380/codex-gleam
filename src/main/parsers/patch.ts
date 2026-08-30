import { createTwoFilesPatch } from 'diff'
import type { FileChange, FileChangeKind } from '@shared/types'

/**
 * 补丁解析。会话日志里的文件修改主要有两种写法：
 *
 *   1. Codex 的 apply_patch 格式：
 *        *** Begin Patch
 *        *** Update File: src/app.ts
 *        @@ ... @@
 *        -旧行
 *        +新行
 *        *** End Patch
 *
 *   2. 标准 unified diff（git diff 输出）。
 *
 * 两种都转换成统一的 FileChange[]，用于右侧 Diff 面板与统计。
 */

const APPLY_PATCH_MARKER = '*** Begin Patch'

export function looksLikeApplyPatch(text: string): boolean {
  return text.includes(APPLY_PATCH_MARKER) || /^\*\*\* (Update|Add|Delete) File:/m.test(text)
}

export function looksLikeUnifiedDiff(text: string): boolean {
  return /^diff --git /m.test(text) || (/^--- /m.test(text) && /^\+\+\+ /m.test(text))
}

function emptyChange(path: string, kind: FileChangeKind): FileChange {
  return {
    path,
    displayPath: path,
    kind,
    diff: '',
    additions: 0,
    deletions: 0
  }
}

/** 解析 Codex apply_patch 文本。 */
export function parseApplyPatch(text: string): FileChange[] {
  const lines = text.split(/\r?\n/)
  const changes: FileChange[] = []
  let current: FileChange | null = null
  const buffer: string[] = []

  const flush = (): void => {
    if (!current) return
    current.diff = buffer.join('\n').trim() === '' ? undefined : buffer.join('\n')
    changes.push(current)
    current = null
    buffer.length = 0
  }

  for (const line of lines) {
    const header = /^\*\*\* (Update|Add|Delete|Move) File: (.+)$/.exec(line)
    if (header) {
      flush()
      const action = header[1] ?? 'Update'
      const path = (header[2] ?? '').trim()
      const kind: FileChangeKind =
        action === 'Add' ? 'write' : action === 'Delete' ? 'delete' : action === 'Move' ? 'rename' : 'edit'
      current = emptyChange(path, kind)
      continue
    }

    if (line.startsWith('*** End Patch') || line.startsWith('*** Begin Patch')) {
      if (line.startsWith('*** End Patch')) flush()
      continue
    }

    if (!current) continue

    buffer.push(line)
    if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1
  }

  flush()
  return changes
}

/** 解析标准 unified diff。 */
export function parseUnifiedDiff(text: string): FileChange[] {
  const lines = text.split(/\r?\n/)
  const changes: FileChange[] = []
  let current: FileChange | null = null
  let buffer: string[] = []

  const flush = (): void => {
    if (!current) return
    current.diff = buffer.length > 0 ? buffer.join('\n') : undefined
    changes.push(current)
    current = null
    buffer = []
  }

  for (const line of lines) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (gitHeader) {
      flush()
      current = emptyChange((gitHeader[2] ?? gitHeader[1] ?? '').trim(), 'edit')
      buffer.push(line)
      continue
    }

    const oldFile = /^--- (?:a\/)?(.+)$/.exec(line)
    const newFile = /^\+\+\+ (?:b\/)?(.+)$/.exec(line)

    if (oldFile && !current) {
      const path = (oldFile[1] ?? '').trim()
      current = emptyChange(path === '/dev/null' ? '' : path, 'edit')
      buffer.push(line)
      continue
    }

    if (newFile && current) {
      const path = (newFile[1] ?? '').trim()
      if (path !== '/dev/null' && path !== '') {
        current.path = path
        current.displayPath = path
      } else {
        current.kind = 'delete'
      }
      buffer.push(line)
      continue
    }

    if (!current) continue

    buffer.push(line)
    if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1
  }

  flush()
  return changes.filter((change) => change.path !== '')
}

/** 自动判断格式并解析。识别不出补丁结构时返回空数组。 */
export function parsePatchText(text: string): FileChange[] {
  if (typeof text !== 'string' || text.trim() === '') return []
  if (looksLikeApplyPatch(text)) {
    const changes = parseApplyPatch(text)
    if (changes.length > 0) return changes
  }
  if (looksLikeUnifiedDiff(text)) {
    const changes = parseUnifiedDiff(text)
    if (changes.length > 0) return changes
  }
  return []
}

/**
 * 从"修改前 / 修改后"两份全文生成 unified diff。
 * 有些日志只记录了改动前后的完整内容，没有现成的 diff，这时需要自己算。
 */
export function buildUnifiedDiff(path: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(path, path, before, after, '', '', { context: 3 })
  // jsdiff 在两侧文件名相同时会加上 "Index:" 和一行等号，展示时是噪音。
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('Index: ') && !/^=+$/.test(line))
    .join('\n')
    .trimStart()
}

/** 统计一组文件改动的增删行数。 */
export function sumChanges(changes: readonly FileChange[]): { additions: number; deletions: number } {
  return changes.reduce(
    (accumulator, change) => ({
      additions: accumulator.additions + change.additions,
      deletions: accumulator.deletions + change.deletions
    }),
    { additions: 0, deletions: 0 }
  )
}
