import { DEPTH_LIMIT_PLACEHOLDER, REDACTION_MAX_DEPTH } from '@shared/constants'
import { maskHomePaths } from '@shared/paths'
import type { CodexEvent, CodexSession, Platform, ScanIssue, SessionSummary } from '@shared/types'
import { isRecord } from '@shared/validators'

/**
 * 关闭「显示完整路径」时，把送往界面/报告的**文字**里的用户主目录换成 `~`。
 *
 * ## 为什么不给每个字段各配一个 display 字段
 *
 * 那条路走过了，而且连着漏了三轮：先是事件标题，再是命令，再是命令输出和会话标题。
 * 每加一个要显示的文本字段，就得有人记得同步加一份展示副本 —— 记不住是必然的。
 * 而且正文没法这么办：命令输出动辄上百 KB，为它常驻一份打过码的副本会让内存翻倍。
 *
 * 所以改在**送出去的那一刻**统一处理，和 maybeRedactSession 同一个位置：
 * 产生的是一份临时拷贝，不长期占内存；新增字段只要属于"文字"，天然就被覆盖到。
 *
 * ## 什么不动
 *
 * 路径字段一律保持原样：sourceFile、workingDirectory、relatedFiles、
 * fileChanges[].path，以及它们各自的 display 版本。
 * 「在文件管理器中定位」要靠真实路径干活，把它们也换成 `~` 就再也定位不到了。
 * 这也是这个模块和 redact 的分工：redact 挡密钥，密钥没人需要拿去定位文件，
 * 所以它连路径带内容一起打；这里只管"显示出来会暴露用户名"的那部分文字。
 */

interface MaskOptions {
  homeDir: string | null
  platform: Platform
}

function maskDeep(value: unknown, options: MaskOptions, depth = 0): unknown {
  if (typeof value === 'string') return maskHomePaths(value, options)
  if (value === null || typeof value !== 'object') return value

  if (depth > REDACTION_MAX_DEPTH) return DEPTH_LIMIT_PLACEHOLDER

  if (Array.isArray(value)) return value.map((entry) => maskDeep(entry, options, depth + 1))

  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      result[key] = maskDeep(entry, options, depth + 1)
    }
    return result
  }

  return value
}

function maskIssue(issue: ScanIssue, options: MaskOptions): ScanIssue {
  return {
    ...issue,
    reason: maskHomePaths(issue.reason, options),
    suggestion: maskHomePaths(issue.suggestion, options)
  }
}

export function maskEventPaths(event: CodexEvent, options: MaskOptions): CodexEvent {
  const mask = (text: string): string => maskHomePaths(text, options)

  const masked: CodexEvent = {
    ...event,
    title: mask(event.title),
    content: mask(event.content),
    raw: maskDeep(event.raw, options)
  }

  if (event.command !== undefined) masked.command = mask(event.command)

  if (event.fileChanges) {
    // 只碰差异文本，path / displayPath 不动 —— 那两个是拿来定位文件的。
    masked.fileChanges = event.fileChanges.map((change) => {
      const next = { ...change }
      if (change.diff !== undefined) next.diff = mask(change.diff)
      if (change.before !== undefined) next.before = mask(change.before)
      if (change.after !== undefined) next.after = mask(change.after)
      return next
    })
  }

  if (event.test) {
    masked.test = {
      ...event.test,
      failures: event.test.failures.map((failure) => ({
        name: mask(failure.name),
        ...(failure.message === undefined ? {} : { message: mask(failure.message) })
      }))
    }
  }

  return masked
}

/**
 * 会话标题同样要处理。
 *
 * 标题多半取自用户说的第一句话，而那句话里很常见「帮我改一下
 * C:\Users\alice\proj\src\a.ts」——于是会话列表和详情页顶部的大标题
 * 就把用户名摆在了整个界面最显眼的位置。
 */
export function maskSummaryPaths<T extends SessionSummary>(summary: T, options: MaskOptions): T {
  return {
    ...summary,
    title: maskHomePaths(summary.title, options),
    warnings: summary.warnings.map((warning) => maskIssue(warning, options))
  }
}

export function maskSessionPaths(session: CodexSession, options: MaskOptions): CodexSession {
  return {
    ...maskSummaryPaths(session, options),
    events: session.events.map((event) => maskEventPaths(event, options))
  }
}

/** 按开关决定是否处理，方便设置项与导出选项复用。 */
export function maybeMaskSessionPaths(
  session: CodexSession,
  hide: boolean,
  options: MaskOptions
): CodexSession {
  return hide ? maskSessionPaths(session, options) : session
}

export function maybeMaskSummaryPaths<T extends SessionSummary>(
  summary: T,
  hide: boolean,
  options: MaskOptions
): T {
  return hide ? maskSummaryPaths(summary, options) : summary
}
