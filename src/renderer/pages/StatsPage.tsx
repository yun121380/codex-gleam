import { useCallback, useEffect, useState } from 'react'
import { ChartColumn, RefreshCw } from 'lucide-react'
import { EVENT_TYPE_META } from '@shared/constants'
import type { CodexEventType, StatsOverview } from '@shared/types'
import { DailyTrend, HorizontalBars, StatCard } from '../components/charts'
import { Button, Card, EmptyState, SectionTitle, Spinner } from '../components/ui'
import { formatDuration } from '../lib/format'
import { useApp } from '../hooks/useAppStore'

/**
 * 统计页面。
 * 所有数字都由主进程用确定性规则算出来（见 src/main/stats/stats.ts），不涉及任何模型。
 */
export function StatsPage(): React.JSX.Element {
  const { actions, sessions } = useApp()
  const [stats, setStats] = useState<StatsOverview | null>(null)
  const [loading, setLoading] = useState(true)

  // 进入页面时算一次：状态只在 Promise 回调里更新，不在 effect 里同步 setState。
  useEffect(() => {
    let cancelled = false
    void actions.loadStats().then((result) => {
      if (cancelled) return
      setStats(result)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [actions])

  const refresh = useCallback(async () => {
    setLoading(true)
    const result = await actions.loadStats()
    setStats(result)
    setLoading(false)
  }, [actions])

  if (loading && !stats) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <Spinner label="正在统计…" />
      </div>
    )
  }

  if (!stats || sessions.length === 0) {
    return (
      <div className="h-full bg-canvas">
        <EmptyState
          icon={ChartColumn}
          title="还没有可以统计的会话"
          description="先扫描或导入一些会话，这里就会出现你和 Codex 的协作数据。"
        />
      </div>
    )
  }

  const failureRate =
    stats.totalCommands === 0 ? 0 : Math.round((stats.failedCommands / stats.totalCommands) * 100)
  const testTotal = stats.testsPassed + stats.testsFailed

  const eventTypeItems = (Object.entries(stats.eventTypeCounts) as Array<[CodexEventType, number]>)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ label: EVENT_TYPE_META[type]?.label ?? type, count }))
    .sort((a, b) => b.count - a.count)

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold text-ink">本地统计</h1>
            <p className="mt-0.5 text-[12.5px] text-ink-soft">
              全部基于本机已索引的 {stats.totalSessions} 个会话计算，不联网、不调用任何模型。
            </p>
          </div>
          <Button icon={RefreshCw} onClick={() => void refresh()} loading={loading}>
            重新计算
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard label="会话总数" value={stats.totalSessions} />
          <StatCard label="最近 7 天会话" value={stats.sessionsLast7Days} />
          <StatCard label="总命令数" value={stats.totalCommands} />
          <StatCard
            label="失败命令数"
            value={stats.failedCommands}
            tone={stats.failedCommands > 0 ? 'bad' : 'default'}
            hint={stats.totalCommands > 0 ? `占全部命令的 ${failureRate}%` : undefined}
          />
          <StatCard
            label="修改文件次数"
            value={stats.changedFileCount}
            hint={`涉及 ${stats.uniqueChangedFileCount} 个不同文件`}
          />
          <StatCard
            label="测试通过"
            value={stats.testsPassed}
            tone={stats.testsPassed > 0 ? 'good' : 'default'}
          />
          <StatCard
            label="测试失败"
            value={stats.testsFailed}
            tone={stats.testsFailed > 0 ? 'bad' : 'default'}
            hint={testTotal > 0 ? `共记录 ${testTotal} 个用例结果` : undefined}
          />
          <StatCard
            label="总会话时长"
            value={formatDuration(stats.totalDurationMs)}
            hint={`平均每次 ${formatDuration(stats.averageSessionDurationMs)}`}
          />
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <Card>
            <SectionTitle hint="最近 14 天">每天的会话数量</SectionTitle>
            <DailyTrend data={stats.byDay} />
          </Card>

          <Card>
            <SectionTitle hint="按会话数排序">最常使用的项目</SectionTitle>
            <HorizontalBars items={stats.topProjects} valueSuffix=" 个会话" />
          </Card>

          <Card>
            <SectionTitle hint="按被修改次数排序">最常修改的文件类型</SectionTitle>
            <HorizontalBars
              items={stats.topFileTypes}
              valueSuffix=" 次"
              tone="file"
              emptyText="还没有记录到文件修改"
            />
          </Card>

          <Card>
            <SectionTitle hint={`共 ${stats.totalEvents} 步`}>各类事件的数量</SectionTitle>
            <HorizontalBars items={eventTypeItems} valueSuffix=" 次" />
          </Card>
        </div>

        <p className="mt-5 text-[11.5px] leading-relaxed text-ink-faint">
          统计口径：命令数包含普通命令与测试命令；失败命令按"退出码非 0 或日志明确标记失败"计算；
          "最近 7 天"以会话的结束时间（缺失时退回开始时间或文件修改时间）为准。
          数据生成时间：{new Date(stats.generatedAt).toLocaleString('zh-CN')}。
        </p>
      </div>
    </div>
  )
}
