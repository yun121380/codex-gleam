import { diffLines } from 'diff'
import type { FileChange } from '@shared/types'

/** Diff 展示用的行模型。 */
export interface DiffRow {
  kind: 'add' | 'del' | 'context' | 'hunk' | 'meta'
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface DiffStats {
  additions: number
  deletions: number
}

/** 解析标准 unified diff 文本。 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('\\ No newline')) {
      rows.push({ kind: 'meta', text: raw, oldLine: null, newLine: null })
      continue
    }
    if (raw.startsWith('---') || raw.startsWith('+++')) {
      rows.push({ kind: 'meta', text: raw, oldLine: null, newLine: null })
      continue
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (hunk) {
      oldLine = Number.parseInt(hunk[1] ?? '1', 10)
      newLine = Number.parseInt(hunk[3] ?? '1', 10)
      rows.push({ kind: 'hunk', text: raw, oldLine: null, newLine: null })
      continue
    }

    if (raw.startsWith('+')) {
      rows.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine })
      newLine += 1
      continue
    }
    if (raw.startsWith('-')) {
      rows.push({ kind: 'del', text: raw.slice(1), oldLine, newLine: null })
      oldLine += 1
      continue
    }

    const text = raw.startsWith(' ') ? raw.slice(1) : raw
    rows.push({ kind: 'context', text, oldLine, newLine })
    oldLine += 1
    newLine += 1
  }

  // 去掉尾部因为文件结尾换行产生的空行
  while (rows.length > 0 && rows[rows.length - 1]?.text === '' && rows[rows.length - 1]?.kind === 'context') {
    rows.pop()
  }

  return rows
}

/** 只有修改前后全文时，直接在界面上算行级差异。 */
export function diffFromBeforeAfter(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 1
  let newLine = 1

  for (const part of diffLines(before, after)) {
    const lines = part.value.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

    for (const line of lines) {
      if (part.added) {
        rows.push({ kind: 'add', text: line, oldLine: null, newLine })
        newLine += 1
      } else if (part.removed) {
        rows.push({ kind: 'del', text: line, oldLine, newLine: null })
        oldLine += 1
      } else {
        rows.push({ kind: 'context', text: line, oldLine, newLine })
        oldLine += 1
        newLine += 1
      }
    }
  }

  return rows
}

/** 把一个文件改动转成可渲染的行；没有任何差异信息时返回空数组。 */
export function rowsForChange(change: FileChange): DiffRow[] {
  if (change.diff && change.diff.trim() !== '') return parseUnifiedDiff(change.diff)
  if (change.before !== undefined && change.after !== undefined) {
    return diffFromBeforeAfter(change.before, change.after)
  }
  if (change.after !== undefined) {
    return change.after
      .split(/\r?\n/)
      .map((text, index) => ({ kind: 'add' as const, text, oldLine: null, newLine: index + 1 }))
  }
  return []
}

export function statsForRows(rows: readonly DiffRow[]): DiffStats {
  return rows.reduce<DiffStats>(
    (accumulator, row) => ({
      additions: accumulator.additions + (row.kind === 'add' ? 1 : 0),
      deletions: accumulator.deletions + (row.kind === 'del' ? 1 : 0)
    }),
    { additions: 0, deletions: 0 }
  )
}

/**
 * 差异行数很多时只展示改动附近的内容，避免几千行卡住界面。
 * 返回被折叠掉的行数，界面上会提示"已折叠 N 行"。
 */
export function collapseContext(
  rows: readonly DiffRow[],
  contextLines = 3
): { rows: DiffRow[]; collapsed: number } {
  const hasChanges = rows.some((row) => row.kind === 'add' || row.kind === 'del')
  if (!hasChanges || rows.length <= 60) return { rows: [...rows], collapsed: 0 }

  const keep = new Set<number>()
  rows.forEach((row, index) => {
    if (row.kind === 'add' || row.kind === 'del' || row.kind === 'hunk' || row.kind === 'meta') {
      for (let offset = -contextLines; offset <= contextLines; offset += 1) {
        const target = index + offset
        if (target >= 0 && target < rows.length) keep.add(target)
      }
    }
  })

  const result: DiffRow[] = []
  let collapsed = 0
  rows.forEach((row, index) => {
    if (keep.has(index)) result.push(row)
    else collapsed += 1
  })

  return { rows: result, collapsed }
}
