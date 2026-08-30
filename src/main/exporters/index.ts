import { APP_NAME } from '@shared/constants'
import type { CodexSession, ExportFormat, ExportOptions, Platform } from '@shared/types'
import { exportHtml } from './html'
import { exportJson } from './json'
import { exportMarkdown } from './markdown'
import { buildReportModel } from './reportModel'

export { buildReportModel, formatDateTime, formatDuration } from './reportModel'
export { exportHtml, escapeHtml } from './html'
export { exportJson, buildStandardExport } from './json'
export { exportMarkdown } from './markdown'

export interface RenderExportArgs {
  session: CodexSession
  format: ExportFormat
  options: ExportOptions
  homeDir: string | null
  platform: Platform
  now?: Date
}

export interface RenderedExport {
  content: string
  extension: string
  /** 建议的默认文件名（不含目录）。 */
  fileName: string
}

/** 会话标题里可能有各种字符，转成安全的文件名。 */
export function toSafeFileName(title: string, fallback = 'codex-session'): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const limited = cleaned.length > 60 ? cleaned.slice(0, 60).trim() : cleaned
  return limited === '' ? fallback : limited
}

export function renderExport(args: RenderExportArgs): RenderedExport {
  const context = {
    homeDir: args.homeDir,
    platform: args.platform,
    appName: APP_NAME,
    ...(args.now === undefined ? {} : { now: args.now })
  }
  const report = buildReportModel(args.session, args.options, context)

  const stamp = (args.now ?? new Date()).toISOString().slice(0, 10)
  const base = `${toSafeFileName(args.session.title)}-${stamp}`

  switch (args.format) {
    case 'markdown':
      return { content: exportMarkdown(report), extension: 'md', fileName: `${base}.md` }
    case 'html':
      return { content: exportHtml(report), extension: 'html', fileName: `${base}.html` }
    case 'json':
      return { content: exportJson(report), extension: 'json', fileName: `${base}.json` }
    default:
      throw new Error(`不支持的导出格式：${String(args.format)}`)
  }
}
