import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FilePen,
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  X
} from 'lucide-react'
import { CODE_CHANGE_EVENT_TYPES } from '@shared/constants'
import type { CodexEvent, CodexSession } from '@shared/types'
import { stripAnsi } from '../lib/ansi'
import { cx, formatTimeOnly } from '../lib/format'
import { EventIcon, metaFor, tonesFor } from '../lib/eventMeta'
import { useTimelinePlayer } from '../hooks/useTimelinePlayer'
import { Badge, EmptyState, IconButton } from './ui'

/** 一次最多渲染这么多条，其余用"载入更多"按钮，避免长会话卡顿。 */
const PAGE_SIZE = 150

export function Timeline({
  session,
  selectedIndex,
  onSelectIndex,
  playbackIntervalMs
}: {
  session: CodexSession
  selectedIndex: number
  onSelectIndex: (index: number) => void
  playbackIntervalMs: number
}): React.JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [onlyFailures, setOnlyFailures] = useState(false)
  const [onlyChanges, setOnlyChanges] = useState(false)
  /** 思考过程默认不显示：它能占到一个会话近一半的步骤，混在里面会看不清主线。 */
  const [showReasoning, setShowReasoning] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /**
   * 分页状态带上"它属于哪一组筛选条件"。
   * 这样切换会话或改筛选条件时，页数自然回到第一页，不需要用 effect 去重置。
   */
  const [pagination, setPagination] = useState({ key: '', count: PAGE_SIZE })
  const listRef = useRef<HTMLDivElement | null>(null)

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    return session.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => {
        if (!showReasoning && event.type === 'reasoning') return false
        if (onlyFailures && event.success !== false && event.type !== 'error') return false
        if (onlyChanges && !CODE_CHANGE_EVENT_TYPES.includes(event.type)) return false
        if (needle === '') return true
        return (
          event.title.toLowerCase().includes(needle) ||
          stripAnsi(event.content).toLowerCase().includes(needle) ||
          (event.command ?? '').toLowerCase().includes(needle) ||
          event.relatedFiles.some((file) => file.toLowerCase().includes(needle))
        )
      })
  }, [session.events, keyword, onlyFailures, onlyChanges, showReasoning])

  const reasoningCount = useMemo(
    () => session.events.filter((event) => event.type === 'reasoning').length,
    [session.events]
  )

  const paginationKey = `${session.id}|${keyword}|${onlyFailures}|${onlyChanges}|${showReasoning}`
  const positionInFiltered = filtered.findIndex((entry) => entry.index === selectedIndex)

  // 选中项如果落在当前页之后，直接把渲染范围扩到能包含它，避免"跳到某一步却看不到"。
  const requestedCount = pagination.key === paginationKey ? pagination.count : PAGE_SIZE
  const requiredCount =
    positionInFiltered >= 0 ? Math.ceil((positionInFiltered + 1) / PAGE_SIZE) * PAGE_SIZE : PAGE_SIZE
  const visibleCount = Math.max(requestedCount, requiredCount)

  const step = (delta: number): void => {
    if (filtered.length === 0) return
    const current = positionInFiltered >= 0 ? positionInFiltered : 0
    const next = Math.min(filtered.length - 1, Math.max(0, current + delta))
    const target = filtered[next]
    if (target) onSelectIndex(target.index)
  }

  const player = useTimelinePlayer({
    intervalMs: playbackIntervalMs,
    canAdvance: positionInFiltered < filtered.length - 1,
    onTick: () => step(1)
  })

  /*
   * 换了会话就把时间线滚回顶部。
   *
   * 这个滚动容器不随会话切换重建，scrollTop 会原样留着 —— 于是点开另一个会话，
   * 一上来看到的是半截中间内容。下面那个"选中项滚动进视野"的 effect 兜不住：
   * 切换会话时选中步骤本来就回到第 0 步，依赖没有变化，它压根不会触发。
   */
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [session.id])

  // 选中项滚动进视野。
  useEffect(() => {
    const node = listRef.current?.querySelector(`[data-event-index="${selectedIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, visibleCount])

  // 键盘操作：← → 上一步/下一步，空格播放暂停。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault()
        step(1)
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault()
        step(-1)
      } else if (event.key === ' ') {
        event.preventDefault()
        player.toggle()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const toggleExpanded = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const visible = filtered.slice(0, visibleCount)

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-line bg-canvas">
      <div className="shrink-0 border-b border-line bg-surface px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <IconButton icon={SkipBack} title="上一步（← 键）" onClick={() => step(-1)} />
          <IconButton
            icon={player.playing ? Pause : Play}
            title={player.playing ? '暂停（空格）' : '播放（空格）'}
            onClick={player.toggle}
            active={player.playing}
          />
          <IconButton icon={SkipForward} title="下一步（→ 键）" onClick={() => step(1)} />

          <div className="mx-1 text-[11px] whitespace-nowrap text-ink-faint">
            {filtered.length === 0
              ? '0 / 0'
              : `${Math.max(1, positionInFiltered + 1)} / ${filtered.length}`}
          </div>

          <div className="relative min-w-0 flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint"
            />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="在这个会话里搜索"
              className="h-8 w-full rounded-lg border border-line bg-canvas pr-7 pl-8 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
            />
            {keyword !== '' ? (
              <button
                type="button"
                onClick={() => setKeyword('')}
                title="清除搜索"
                className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-faint hover:text-ink"
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <FilterChip
            active={onlyFailures}
            onClick={() => setOnlyFailures((value) => !value)}
            icon={<CircleAlert size={11} />}
            label="只看失败"
          />
          <FilterChip
            active={onlyChanges}
            onClick={() => setOnlyChanges((value) => !value)}
            icon={<FilePen size={11} />}
            label="只看代码修改"
          />
          {reasoningCount > 0 ? (
            <FilterChip
              active={showReasoning}
              onClick={() => setShowReasoning((value) => !value)}
              icon={<Brain size={11} />}
              label={`思考过程 ${reasoningCount}`}
            />
          ) : null}
          {(onlyFailures || onlyChanges || keyword !== '') && filtered.length === 0 ? (
            <span className="text-[11px] text-ink-faint">没有符合条件的步骤</span>
          ) : null}
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title="这里没有可显示的步骤"
            description="把筛选条件关掉，或者换一个搜索词试试。"
          />
        ) : (
          <>
            {visible.map(({ event, index }) => (
              <TimelineRow
                key={event.id}
                event={event}
                index={index}
                selected={index === selectedIndex}
                expanded={expanded.has(event.id)}
                onSelect={() => onSelectIndex(index)}
                onToggle={() => toggleExpanded(event.id)}
              />
            ))}
            {filtered.length > visible.length ? (
              <button
                type="button"
                onClick={() => setPagination({ key: paginationKey, count: visibleCount + PAGE_SIZE })}
                className="mt-2 mb-3 w-full rounded-lg border border-line bg-surface py-2 text-xs text-ink-soft hover:bg-raised"
              >
                还有 {filtered.length - visible.length} 步，点击载入更多
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors',
        active ? 'bg-accent-soft text-accent-ink' : 'text-ink-faint hover:bg-raised hover:text-ink-soft'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function TimelineRow({
  event,
  index,
  selected,
  expanded,
  onSelect,
  onToggle
}: {
  event: CodexEvent
  index: number
  selected: boolean
  expanded: boolean
  onSelect: () => void
  onToggle: () => void
}): React.JSX.Element {
  const meta = metaFor(event.type)
  const tones = tonesFor(event.type)
  const preview = stripAnsi(event.content).trim()
  const failed = event.success === false || event.type === 'error'

  return (
    <div
      data-event-index={index}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(keyEvent) => {
        if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault()
          onSelect()
        }
      }}
      className={cx(
        'group relative mb-1 cursor-pointer rounded-lg border px-2.5 py-2 transition-colors',
        selected
          ? 'border-accent/45 bg-surface-2'
          : 'border-transparent hover:border-line hover:bg-surface'
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex flex-col items-center pt-0.5">
          <span
            className={cx(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
              tones.chip,
              failed && 'ring-1 ring-error/50'
            )}
          >
            <EventIcon type={event.type} size={13} />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] tabular-nums text-ink-faint">#{index + 1}</span>
            <span className={cx('text-[11px] font-medium', tones.text)}>{meta.label}</span>
            <span className="text-[10px] tabular-nums text-ink-faint">
              {formatTimeOnly(event.timestamp)}
            </span>
            {failed ? (
              <Badge className="bg-error-soft text-error">
                {event.exitCode !== null && event.exitCode !== undefined
                  ? `退出码 ${event.exitCode}`
                  : '失败'}
              </Badge>
            ) : null}
            {event.test ? (
              <Badge className={event.test.failed > 0 ? 'bg-error-soft text-error' : 'bg-test-soft text-test'}>
                {event.test.passed} 通过 / {event.test.failed} 失败
              </Badge>
            ) : null}
            {event.fileChanges && event.fileChanges.length > 0 ? (
              <Badge className="bg-file-soft text-file">{event.fileChanges.length} 个文件</Badge>
            ) : null}
          </div>

          <div
            className={cx(
              'mt-0.5 text-[13px] leading-snug break-words',
              event.type === 'shell_command' || event.type === 'test_start'
                ? 'font-mono text-[12px] text-ink'
                : 'text-ink'
            )}
          >
            {event.title}
          </div>

          {expanded && preview !== '' ? (
            <pre className="mt-1.5 max-h-72 overflow-auto rounded-md border border-line bg-canvas px-2.5 py-2 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-ink-soft">
              {preview}
            </pre>
          ) : null}
        </div>

        {preview !== '' ? (
          <button
            type="button"
            title={expanded ? '收起内容' : '展开内容'}
            onClick={(clickEvent) => {
              clickEvent.stopPropagation()
              onToggle()
            }}
            className="shrink-0 rounded p-1 text-ink-faint hover:bg-raised hover:text-ink"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : null}
      </div>
    </div>
  )
}
