import { cx, formatNumber } from '../lib/format'

/**
 * 手写的极简图表。
 *
 * 刻意不引入图表库：这里只需要"横向柱状图"和"按天趋势"两种形态，
 * 用 div 和 SVG 就能画得干净，还能保证完全离线、深浅主题都可读。
 *
 * 取舍：
 *   - 同一系列只用一种颜色（琥珀色强调色），不搞彩虹配色；
 *   - 数值直接标在条子旁边，不用图例；
 *   - 数字统一使用 tabular-nums，纵向对齐才好比较。
 */

export function HorizontalBars({
  items,
  emptyText = '暂无数据',
  valueSuffix = '',
  tone = 'accent'
}: {
  items: ReadonlyArray<{ label: string; count: number }>
  emptyText?: string
  valueSuffix?: string
  tone?: 'accent' | 'file' | 'error'
}): React.JSX.Element {
  if (items.length === 0) {
    return <p className="py-6 text-center text-[12.5px] text-ink-faint">{emptyText}</p>
  }

  const max = Math.max(...items.map((item) => item.count), 1)
  const barTone =
    tone === 'file' ? 'bg-file' : tone === 'error' ? 'bg-error' : 'bg-accent'

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[12.5px] text-ink" title={item.label}>
              {item.label}
            </span>
            <span className="shrink-0 text-[12px] tabular-nums text-ink-soft">
              {formatNumber(item.count)}
              {valueSuffix}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
            <div
              className={cx('h-full rounded-full', barTone)}
              style={{ width: `${Math.max(2, (item.count / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function DailyTrend({
  data,
  emptyText = '最近两周没有会话记录'
}: {
  data: ReadonlyArray<{ date: string; sessions: number; commands: number }>
  emptyText?: string
}): React.JSX.Element {
  const max = Math.max(...data.map((item) => item.sessions), 1)
  const hasAny = data.some((item) => item.sessions > 0)

  if (!hasAny) {
    return <p className="py-6 text-center text-[12.5px] text-ink-faint">{emptyText}</p>
  }

  return (
    <div>
      <div className="flex h-32 items-end gap-1.5">
        {data.map((item) => {
          const height = item.sessions === 0 ? 2 : Math.max(6, (item.sessions / max) * 100)
          return (
            <div key={item.date} className="group flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="text-[10px] tabular-nums text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
                {item.sessions}
              </span>
              <div
                title={`${item.date}：${item.sessions} 个会话、${item.commands} 条命令`}
                className={cx(
                  'w-full rounded-t-sm transition-colors',
                  item.sessions === 0 ? 'bg-line' : 'bg-accent/75 group-hover:bg-accent'
                )}
                style={{ height: `${height}%` }}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10.5px] tabular-nums text-ink-faint">
        <span>{data[0]?.date.slice(5) ?? ''}</span>
        <span>{data[data.length - 1]?.date.slice(5) ?? ''}</span>
      </div>
    </div>
  )
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default'
}: {
  label: string
  value: string | number
  hint?: string
  tone?: 'default' | 'good' | 'bad'
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="text-[11.5px] text-ink-soft">{label}</div>
      <div
        className={cx(
          'mt-0.5 text-[26px] leading-tight font-semibold tabular-nums',
          tone === 'good' ? 'text-file' : tone === 'bad' ? 'text-error' : 'text-ink'
        )}
      >
        {typeof value === 'number' ? formatNumber(value) : value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] leading-snug text-ink-faint">{hint}</div> : null}
    </div>
  )
}
