import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileText } from 'lucide-react'
import type { FileChange } from '@shared/types'
import { collapseContext, rowsForChange, statsForRows, type DiffRow } from '../lib/diffView'
import { cx } from '../lib/format'
import { Badge } from './ui'

const KIND_LABEL: Record<FileChange['kind'], string> = {
  write: '新建 / 覆盖',
  edit: '修改',
  delete: '删除',
  rename: '重命名',
  read: '读取',
  unknown: '改动'
}

const KIND_STYLE: Record<FileChange['kind'], string> = {
  write: 'bg-file-soft text-file',
  edit: 'bg-diff-soft text-diff',
  delete: 'bg-error-soft text-error',
  rename: 'bg-tool-soft text-tool',
  read: 'bg-neutral-soft text-ink-faint',
  unknown: 'bg-neutral-soft text-ink-faint'
}

export function DiffViewer({
  changes,
  showFullPaths
}: {
  changes: readonly FileChange[]
  showFullPaths: boolean
}): React.JSX.Element {
  if (changes.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] text-ink-soft">
        这一步没有记录具体的文件差异内容。
      </p>
    )
  }

  return (
    <div className="space-y-2.5">
      {changes.map((change, index) => (
        <FileDiff
          key={`${change.path}-${index}`}
          change={change}
          showFullPaths={showFullPaths}
          defaultOpen={changes.length <= 3}
        />
      ))}
    </div>
  )
}

function FileDiff({
  change,
  showFullPaths,
  defaultOpen
}: {
  change: FileChange
  showFullPaths: boolean
  defaultOpen: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const [showAll, setShowAll] = useState(false)

  const rows = useMemo(() => rowsForChange(change), [change])
  const stats = useMemo(() => statsForRows(rows), [rows])
  const collapsed = useMemo(() => collapseContext(rows), [rows])
  const displayRows = showAll ? rows : collapsed.rows
  const path = showFullPaths ? change.path : change.displayPath

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-ink-faint" />
        )}
        <FileText size={14} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink" title={path}>
          {path}
        </span>
        <Badge className={KIND_STYLE[change.kind]}>{KIND_LABEL[change.kind]}</Badge>
        {stats.additions > 0 || change.additions > 0 ? (
          <span className="font-mono text-[11px] text-file">
            +{Math.max(stats.additions, change.additions)}
          </span>
        ) : null}
        {stats.deletions > 0 || change.deletions > 0 ? (
          <span className="font-mono text-[11px] text-error">
            -{Math.max(stats.deletions, change.deletions)}
          </span>
        ) : null}
      </button>

      {open ? (
        rows.length === 0 ? (
          <p className="border-t border-line px-3 py-2.5 text-[12.5px] text-ink-soft">
            日志里只记录了这个文件被改动过，没有保存具体的差异内容。
          </p>
        ) : (
          <div className="border-t border-line">
            <div className="max-h-[520px] overflow-auto font-mono text-[12px] leading-[1.6]">
              {displayRows.map((row, index) => (
                <DiffLine key={index} row={row} />
              ))}
            </div>
            {!showAll && collapsed.collapsed > 0 ? (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full border-t border-line bg-surface-2 py-1.5 text-[11px] text-ink-soft hover:text-ink"
              >
                已折叠 {collapsed.collapsed} 行未改动内容，点击展开全部
              </button>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  )
}

const ROW_STYLE: Record<DiffRow['kind'], string> = {
  add: 'bg-file-soft/55 text-ink',
  del: 'bg-error-soft/50 text-ink',
  context: 'text-ink-soft',
  hunk: 'bg-raised text-assistant',
  meta: 'bg-raised/60 text-ink-faint'
}

const ROW_PREFIX: Record<DiffRow['kind'], string> = {
  add: '+',
  del: '-',
  context: ' ',
  hunk: '',
  meta: ''
}

function DiffLine({ row }: { row: DiffRow }): React.JSX.Element {
  return (
    <div className={cx('flex', ROW_STYLE[row.kind])}>
      <span className="w-11 shrink-0 border-r border-line/60 px-1.5 text-right text-[11px] text-ink-faint select-none">
        {row.oldLine ?? ''}
      </span>
      <span className="w-11 shrink-0 border-r border-line/60 px-1.5 text-right text-[11px] text-ink-faint select-none">
        {row.newLine ?? ''}
      </span>
      <span className="w-4 shrink-0 pl-1.5 select-none">{ROW_PREFIX[row.kind]}</span>
      <span className="flex-1 pr-3 break-words whitespace-pre-wrap">{row.text || ' '}</span>
    </div>
  )
}
