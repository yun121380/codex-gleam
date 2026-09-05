import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FilePen,
  FolderSearch,
  Import,
  ListFilter,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X
} from 'lucide-react'
import type { SearchResponse, SessionSummary } from '@shared/types'
import { cx, formatDuration, formatListTime, truncateMiddle } from '../lib/format'
import { describeAgent, foldSubAgents } from '../lib/sessionGroups'
import { describeSearch } from '../lib/searchNotice'
import { Badge, EmptyState, IconButton } from './ui'

type SortMode = 'recent' | 'project' | 'events'
type FilterMode = 'all' | 'failed' | 'changed' | 'success'

/** 列表一次渲染的条数上限。 */
const PAGE_SIZE = 120

const FILTER_LABELS: Record<FilterMode, string> = {
  all: '全部',
  failed: '有失败',
  changed: '改过代码',
  success: '全部成功'
}

const CONFIDENCE_LABEL: Record<SessionSummary['confidence'], string> = {
  high: '识别可信度：高',
  medium: '识别可信度：中',
  low: '识别可信度：低'
}

const CONFIDENCE_STYLE: Record<SessionSummary['confidence'], string> = {
  high: 'bg-file-soft text-file',
  medium: 'bg-tool-soft text-tool',
  low: 'bg-neutral-soft text-ink-faint'
}

/** 只看标题 / 项目 / 文件名的本地匹配。**即时**，不等 IPC。 */
function matches(session: SessionSummary, keyword: string): boolean {
  if (keyword === '') return true
  const needle = keyword.toLowerCase()
  return (
    session.title.toLowerCase().includes(needle) ||
    session.projectName.toLowerCase().includes(needle) ||
    session.displaySourceFile.toLowerCase().includes(needle) ||
    session.changedFiles.some((file) => file.toLowerCase().includes(needle))
  )
}

function passesFilter(session: SessionSummary, filter: FilterMode): boolean {
  switch (filter) {
    case 'failed':
      return session.hasFailures
    case 'changed':
      return session.hasCodeChanges
    case 'success':
      return !session.hasFailures
    default:
      return true
  }
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onForget,
  onRescan,
  onImport,
  onPickFolder,
  showFullPaths,
  searchQuery,
  searchResult,
  onSearchQueryChange
}: {
  sessions: SessionSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  onForget: (id: string) => void
  onRescan: () => void
  onImport: () => void
  onPickFolder: () => void
  showFullPaths: boolean
  /** 搜索框原文。放在外面是因为全文查询要用它，命中步进器也要用它。 */
  searchQuery: string
  /** 最近一次全文查询的结果，`null` = 没搜过 / 还没到发请求的长度。 */
  searchResult: SearchResponse | null
  onSearchQueryChange: (query: string) => void
}): React.JSX.Element {
  const keyword = searchQuery
  const [sort, setSort] = useState<SortMode>('recent')
  const [filter, setFilter] = useState<FilterMode>('all')
  const [groupByProject, setGroupByProject] = useState(false)
  /**
   * 一次最多渲染多少条。
   * 一台用了很久的机器可能有上千个会话，全渲染出来会明显卡顿。
   * key 里带上筛选条件，条件一变就自然回到第一页。
   */
  const [pagination, setPagination] = useState({ key: '', count: PAGE_SIZE })

  /**
   * 全文命中的会话 id。
   *
   * 不校验 `searchResult.query === keyword`：防抖那 200 ms 里手上这份结果对应的是
   * 更短的前缀，而更短的前缀命中的是**超集**——留着它只会多显示几个会话，而丢掉它
   * 会让列表空一下再填回来，那是 Step 1 明令禁止的。
   */
  const fullTextIds = useMemo(
    () => (searchResult === null ? null : new Set(searchResult.sessionIds)),
    [searchResult]
  )

  const visible = useMemo(() => {
    const trimmed = keyword.trim()
    const filtered = sessions.filter(
      (session) =>
        // 全文命中的会话很可能标题、项目、文件名一个都不含这个词。
        (matches(session, trimmed) || fullTextIds?.has(session.id) === true) &&
        // 筛选条按钮是用户明确的选择，全文命中不能把它顶掉。
        passesFilter(session, filter)
    )
    const sorted = [...filtered]
    sorted.sort((a, b) => {
      if (sort === 'events') return b.eventCount - a.eventCount
      if (sort === 'project') {
        const byProject = a.projectName.localeCompare(b.projectName, 'zh-CN')
        if (byProject !== 0) return byProject
      }
      return recencyOf(b) - recencyOf(a)
    })
    return sorted
  }, [sessions, keyword, fullTextIds, filter, sort])

  /**
   * 并行子代理折叠到派出它们的会话下面 —— 一百多行标题相同的条目会挤爆列表。
   * 分页与"按项目分组"都在折叠之后进行，所以一屏的条数指的是顶层会话数。
   */
  const folded = useMemo(() => foldSubAgents(visible), [visible])

  /** 搜索框底下那一行。措辞全在 `describeSearch` 里，这里只负责显示。 */
  const searchNotice = useMemo(() => describeSearch(searchResult), [searchResult])

  const paginationKey = `${keyword}|${filter}|${sort}|${groupByProject}|${sessions.length}`
  const shownCount = pagination.key === paginationKey ? pagination.count : PAGE_SIZE
  const shown = useMemo(() => folded.slice(0, shownCount), [folded, shownCount])
  const remaining = folded.length - shown.length

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  /** 选中的正好是某个折叠起来的子代理时，自动把它那一组展开。 */
  const parentOfSelected = useMemo(() => {
    if (selectedId === null) return null
    const hit = folded.find((group) => group.children.some((child) => child.id === selectedId))
    return hit?.parent.id ?? null
  }, [folded, selectedId])

  const groups = useMemo(() => {
    if (!groupByProject) return [{ name: '', items: shown }]
    const map = new Map<string, typeof shown>()
    for (const entry of shown) {
      const list = map.get(entry.parent.projectName) ?? []
      list.push(entry)
      map.set(entry.parent.projectName, list)
    }
    return [...map.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, items]) => ({ name, items }))
  }, [shown, groupByProject])

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-line bg-surface">
      <div className="shrink-0 border-b border-line px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-[13px] font-semibold text-ink">
            会话列表
            <span className="ml-1.5 text-xs font-normal text-ink-faint">
              {visible.length === sessions.length
                ? `共 ${sessions.length} 个`
                : `${visible.length} / ${sessions.length}`}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            <IconButton icon={RefreshCw} title="重新扫描" onClick={onRescan} />
            <IconButton icon={Import} title="导入单个文件" onClick={onImport} />
            <IconButton icon={FolderSearch} title="扫描其他文件夹" onClick={onPickFolder} />
          </div>
        </div>

        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint"
          />
          <input
            value={keyword}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="搜索标题、项目或会话内容"
            className="h-8 w-full rounded-lg border border-line bg-canvas pr-7 pl-8 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
          />
          {keyword !== '' ? (
            <button
              type="button"
              onClick={() => onSearchQueryChange('')}
              title="清除搜索"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-faint hover:text-ink"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>

        {/*
          这次搜了什么，说清楚。省掉这一行，用户就会把"降级只搜了标题"当成
          "库里真的没有这个词"——那两种情况下该做的事完全不同。
        */}
        {searchNotice !== null ? (
          <div className="mt-1.5 text-[11px] leading-snug text-ink-faint">{searchNotice}</div>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {(Object.keys(FILTER_LABELS) as FilterMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setFilter(mode)}
              className={cx(
                'rounded-md px-2 py-1 text-[11px] transition-colors',
                filter === mode
                  ? 'bg-accent-soft text-accent-ink'
                  : 'text-ink-faint hover:bg-raised hover:text-ink-soft'
              )}
            >
              {FILTER_LABELS[mode]}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              title="按项目分组"
              onClick={() => setGroupByProject((value) => !value)}
              className={cx(
                'rounded-md px-2 py-1 text-[11px] transition-colors',
                groupByProject
                  ? 'bg-accent-soft text-accent-ink'
                  : 'text-ink-faint hover:bg-raised hover:text-ink-soft'
              )}
            >
              <ListFilter size={12} className="inline" /> 分组
            </button>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortMode)}
              title="排序方式"
              className="rounded-md border border-line bg-canvas px-1.5 py-1 text-[11px] text-ink-soft outline-none"
            >
              <option value="recent">最近使用</option>
              <option value="project">按项目</option>
              <option value="events">事件最多</option>
            </select>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <EmptyState
            icon={FolderSearch}
            title={sessions.length === 0 ? '还没有会话' : '没有符合条件的会话'}
            description={
              sessions.length === 0
                ? '点右上角的刷新按钮开始扫描，或者导入一个会话文件。'
                : '试着换个关键词，或者把筛选条件切回"全部"。'
            }
          />
        ) : (
          groups.map((group) => (
            <div key={group.name || '__all__'}>
              {group.name ? (
                <div className="sticky top-0 z-10 border-y border-line bg-surface-2 px-3 py-1.5 text-[11px] font-medium text-ink-soft">
                  {group.name}
                  <span className="ml-1 text-ink-faint">（{group.items.length}）</span>
                </div>
              ) : null}
              {group.items.map((entry) => {
                const open = expanded.has(entry.parent.id) || parentOfSelected === entry.parent.id
                return (
                  <div key={entry.parent.id}>
                    <SessionRow
                      session={entry.parent}
                      selected={entry.parent.id === selectedId}
                      showFullPaths={showFullPaths}
                      onSelect={() => onSelect(entry.parent.id)}
                      onForget={() => onForget(entry.parent.id)}
                      agentCount={entry.children.length}
                      agentsOpen={open}
                      onToggleAgents={() => toggle(entry.parent.id)}
                    />
                    {open
                      ? entry.children.map((child) => (
                          <SessionRow
                            key={child.id}
                            session={child}
                            selected={child.id === selectedId}
                            showFullPaths={showFullPaths}
                            onSelect={() => onSelect(child.id)}
                            onForget={() => onForget(child.id)}
                            asAgent
                          />
                        ))
                      : null}
                  </div>
                )
              })}
            </div>
          ))
        )}

        {remaining > 0 ? (
          <button
            type="button"
            onClick={() => setPagination({ key: paginationKey, count: shownCount + PAGE_SIZE })}
            className="w-full border-b border-line-soft bg-surface-2 py-2.5 text-[12px] text-ink-soft hover:text-ink"
          >
            还有 {remaining} 个会话，点击继续显示
          </button>
        ) : null}
      </div>
    </div>
  )
}

function SessionRow({
  session,
  selected,
  showFullPaths,
  onSelect,
  onForget,
  agentCount = 0,
  agentsOpen = false,
  onToggleAgents,
  asAgent = false
}: {
  session: SessionSummary
  selected: boolean
  showFullPaths: boolean
  onSelect: () => void
  onForget: () => void
  /** 这个会话派出了几个并行子代理。0 表示没有，不显示折叠按钮。 */
  agentCount?: number
  agentsOpen?: boolean
  onToggleAgents?: () => void
  /** 这一行本身就是个子代理，缩进显示，并用代号代替千篇一律的标题。 */
  asAgent?: boolean
}): React.JSX.Element {
  const path = showFullPaths ? session.sourceFile : session.displaySourceFile

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cx(
        'group relative w-full cursor-pointer border-b border-line-soft py-2.5 text-left transition-colors',
        asAgent ? 'bg-canvas/40 pr-3 pl-7' : 'px-3',
        selected ? 'bg-accent-soft/45' : 'hover:bg-surface-2'
      )}
    >
      {selected ? <span className="absolute top-0 left-0 h-full w-[3px] bg-accent" /> : null}
      {asAgent ? (
        <span className="absolute top-0 left-3 h-full w-px bg-line" aria-hidden="true" />
      ) : null}

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[11px] text-ink-faint">{session.projectName}</span>
            <span className="text-[11px] text-ink-faint">·</span>
            <span className="shrink-0 text-[11px] text-ink-faint">
              {formatListTime(session.endedAt ?? session.startedAt ?? session.indexedAt)}
            </span>
          </div>
          <div className={cx('mt-0.5 line-clamp-2 text-[13px] leading-snug', selected ? 'text-ink' : 'text-ink')}>
            {/* 子代理的标题都一样（收到的是同一段任务），改用它的代号与分工。 */}
            {asAgent ? describeAgent(session) : session.title}
          </div>

          {agentCount > 0 && onToggleAgents ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onToggleAgents()
              }}
              title={agentsOpen ? '收起并行子代理' : '展开并行子代理'}
              className="mt-1 inline-flex items-center gap-1 rounded-md bg-tool-soft px-1.5 py-0.5 text-[11px] text-tool transition-colors hover:brightness-110"
            >
              {agentsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <Users size={11} />
              {agentCount} 个并行子代理
            </button>
          ) : null}
        </div>

        <button
          type="button"
          title="从本地索引中移除（不会删除原始文件）"
          onClick={(event) => {
            event.stopPropagation()
            onForget()
          }}
          className="mt-0.5 shrink-0 rounded p-1 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-error-soft hover:text-error focus-visible:opacity-100"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Badge className="bg-neutral-soft text-ink-faint" title="事件数量">
          {session.eventCount} 步
        </Badge>
        {session.durationMs > 0 ? (
          <Badge className="bg-neutral-soft text-ink-faint" title="会话持续时长">
            {formatDuration(session.durationMs)}
          </Badge>
        ) : null}
        {session.changedFileCount > 0 ? (
          <Badge className="bg-file-soft text-file" title="修改的文件数量">
            <FilePen size={10} />
            {session.changedFileCount}
          </Badge>
        ) : null}
        {session.hasFailures ? (
          <Badge className="bg-error-soft text-error" title="包含失败的命令、测试或错误">
            <CircleAlert size={10} />
            有失败
          </Badge>
        ) : (
          <Badge className="bg-file-soft/60 text-file" title="没有失败记录">
            顺利
          </Badge>
        )}
        <Badge
          className={CONFIDENCE_STYLE[session.confidence]}
          title={`${CONFIDENCE_LABEL[session.confidence]}（${Math.round(session.confidenceScore * 100)}%）`}
        >
          {Math.round(session.confidenceScore * 100)}%
        </Badge>
      </div>

      <div className="mt-1 truncate text-[11px] text-ink-faint" title={path}>
        {truncateMiddle(path, 52)}
      </div>
    </div>
  )
}

function recencyOf(session: SessionSummary): number {
  for (const candidate of [session.endedAt, session.startedAt, session.fileModifiedAt, session.indexedAt]) {
    if (!candidate) continue
    const parsed = Date.parse(candidate)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}
