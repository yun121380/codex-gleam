import type { CodexEventType, CountedItem, DayBucket, SessionSummary, StatsOverview } from '@shared/types'
import { fileExtension } from '../scanner/paths'

/**
 * 统计全部用确定性规则计算：同样的输入永远得到同样的输出，不涉及任何模型。
 * `now` 可注入，方便测试"最近 7 天"这类相对时间口径。
 */

const DAY_MS = 24 * 60 * 60 * 1000
const TOP_LIST_SIZE = 8
const TREND_DAYS = 14

/**
 * 会话归属到哪一天，以结束时间为准（缺失时依次退回开始时间、文件修改时间、索引时间）。
 * 与左侧列表的"最近使用"排序保持同一口径。
 */
function sessionTime(session: SessionSummary): number | null {
  const candidates = [session.endedAt, session.startedAt, session.fileModifiedAt, session.indexedAt]
  for (const candidate of candidates) {
    if (!candidate) continue
    const parsed = Date.parse(candidate)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toLocalDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function topItems(counter: Map<string, number>, size = TOP_LIST_SIZE): CountedItem[] {
  return [...counter.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => (b.count === a.count ? a.label.localeCompare(b.label, 'zh-CN') : b.count - a.count))
    .slice(0, size)
}

export function computeStats(sessions: readonly SessionSummary[], now: Date = new Date()): StatsOverview {
  const nowMs = now.getTime()
  const sevenDaysAgo = nowMs - 7 * DAY_MS

  const projectCounter = new Map<string, number>()
  const extensionCounter = new Map<string, number>()
  const dayCounter = new Map<string, { sessions: number; commands: number }>()
  const eventTypeCounts: Partial<Record<CodexEventType, number>> = {}
  const uniqueChangedFiles = new Set<string>()

  let sessionsLast7Days = 0
  let totalEvents = 0
  let totalCommands = 0
  let failedCommands = 0
  let changedFileCount = 0
  let testsPassed = 0
  let testsFailed = 0
  let totalDurationMs = 0

  for (const session of sessions) {
    totalEvents += session.eventCount
    totalCommands += session.commandCount
    failedCommands += session.failedCommandCount
    changedFileCount += session.changedFileCount
    testsPassed += session.testsPassed
    testsFailed += session.testsFailed
    totalDurationMs += session.durationMs

    projectCounter.set(session.projectName, (projectCounter.get(session.projectName) ?? 0) + 1)

    for (const file of session.changedFiles) {
      uniqueChangedFiles.add(file)
      const extension = fileExtension(file)
      const label = extension === '' ? '（无扩展名）' : extension
      extensionCounter.set(label, (extensionCounter.get(label) ?? 0) + 1)
    }

    for (const [type, count] of Object.entries(session.eventTypeCounts)) {
      const key = type as CodexEventType
      eventTypeCounts[key] = (eventTypeCounts[key] ?? 0) + (count ?? 0)
    }

    const timestamp = sessionTime(session)
    if (timestamp !== null) {
      if (timestamp >= sevenDaysAgo && timestamp <= nowMs + DAY_MS) sessionsLast7Days += 1
      const key = toLocalDateKey(timestamp)
      const bucket = dayCounter.get(key) ?? { sessions: 0, commands: 0 }
      bucket.sessions += 1
      bucket.commands += session.commandCount
      dayCounter.set(key, bucket)
    }
  }

  const byDay: DayBucket[] = []
  for (let offset = TREND_DAYS - 1; offset >= 0; offset -= 1) {
    const key = toLocalDateKey(nowMs - offset * DAY_MS)
    const bucket = dayCounter.get(key)
    byDay.push({ date: key, sessions: bucket?.sessions ?? 0, commands: bucket?.commands ?? 0 })
  }

  return {
    totalSessions: sessions.length,
    sessionsLast7Days,
    totalEvents,
    totalCommands,
    failedCommands,
    changedFileCount,
    uniqueChangedFileCount: uniqueChangedFiles.size,
    testsPassed,
    testsFailed,
    totalDurationMs,
    averageSessionDurationMs: sessions.length === 0 ? 0 : Math.round(totalDurationMs / sessions.length),
    topProjects: topItems(projectCounter),
    topFileTypes: topItems(extensionCounter),
    byDay,
    eventTypeCounts,
    generatedAt: now.toISOString()
  }
}
