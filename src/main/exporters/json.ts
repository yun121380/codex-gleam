import type { ReportModel } from './reportModel'

/**
 * 标准化 JSON 导出。
 *
 * 输出结构是稳定的（有 schemaVersion），方便别的工具再加工，
 * 也方便你把一次会话完整存档。
 *
 * 版本号只在结构变化时动，且只往上加字段：1.1 比 1.0 多了 `usage`，
 * 照着 1.0 写的工具读 1.1 不会坏。
 */

export const EXPORT_SCHEMA_VERSION = '1.1'

export interface StandardExport {
  schema: string
  schemaVersion: string
  generatedBy: string
  generatedAt: string
  offline: true
  redacted: boolean
  session: ReportModel['session']
  counts: ReportModel['counts']
  /** 会话用量。null = 日志里没记，不是 0。 */
  usage: ReportModel['usage']
  userMessages: ReportModel['userMessages']
  assistantMessages: ReportModel['assistantMessages']
  commands: ReportModel['commands']
  fileChanges: ReportModel['fileChanges']
  tests: ReportModel['tests']
  errors: ReportModel['errors']
  timeline: ReportModel['timeline']
  warnings: ReportModel['warnings']
  raw?: unknown
}

export function buildStandardExport(report: ReportModel): StandardExport {
  const result: StandardExport = {
    schema: 'gleam.session-export',
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedBy: report.appName,
    generatedAt: report.generatedAt,
    offline: true,
    redacted: report.options.redactSensitive,
    session: report.session,
    counts: report.counts,
    usage: report.usage,
    userMessages: report.userMessages,
    assistantMessages: report.assistantMessages,
    commands: report.commands,
    fileChanges: report.fileChanges,
    tests: report.tests,
    errors: report.errors,
    timeline: report.timeline,
    warnings: report.warnings
  }

  if (report.options.includeRawJson && report.raw !== null) {
    result.raw = report.raw
  }

  return result
}

export function exportJson(report: ReportModel): string {
  return `${JSON.stringify(buildStandardExport(report), null, 2)}\n`
}
