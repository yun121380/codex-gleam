import { MAX_PARSED_BYTES, MAX_PARSED_LINES } from '@shared/constants'
import type { CodexSession, Platform, ScanIssue } from '@shared/types'
import { safeJsonParse } from '@shared/validators'
import type { FileSystemAccess } from '../scanner/fsAccess'
import type { FingerprintResult } from '../scanner/fingerprint'
import { baseName, toDisplayPath } from '../scanner/paths'
import type { ThreadTitles } from '../scanner/threadTitles'
import { dedupeDraftKeys, pickParser } from './adapters'
import { buildSession } from './buildSession'
import type { BadRecord, ParsedRecord, ParserInput } from './types'

export interface LoadSessionArgs {
  filePath: string
  fileSizeBytes: number
  modifiedMs: number
  fs: FileSystemAccess
  fingerprint: FingerprintResult
  homeDir: string | null
  platform: Platform
  /** Codex 自己维护的会话名（session_index.jsonl）。不传就退回从消息里猜标题。 */
  threadTitles?: ThreadTitles
  /** false 表示只为算摘要（批量扫描），不保留原始 JSON。 */
  keepRaw?: boolean
  /** 批量扫描时开启，要求会话至少含一条对话或动作事件。 */
  requireMeaningfulEvents?: boolean
}

export interface LoadSessionResult {
  sessions: CodexSession[]
  issues: ScanIssue[]
}

/** 损坏行最多记这么多条，避免一个坏文件产生几万条警告。 */
const MAX_REPORTED_BAD_LINES = 50

function previewOf(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed
}

function parseLines(lines: readonly { line: string; index: number }[]): {
  records: ParsedRecord[]
  badRecords: BadRecord[]
} {
  const records: ParsedRecord[] = []
  const badRecords: BadRecord[] = []

  for (const entry of lines) {
    const text = entry.line.trim()
    if (text === '') continue
    // 一些工具会在日志里插注释行，直接忽略而不算错误。
    if (text.startsWith('//') || text.startsWith('#')) continue

    const parsed = safeJsonParse(text)
    if (parsed.ok) {
      records.push({ value: parsed.value, line: entry.index + 1 })
    } else if (badRecords.length < MAX_REPORTED_BAD_LINES) {
      badRecords.push({ line: entry.index + 1, error: parsed.error, preview: previewOf(text) })
    }
  }

  return { records, badRecords }
}

/**
 * 读取并解析一个候选文件。
 *
 * 关键约束：
 *   - JSONL 逐行流式读取，命中行数/字节上限就停下，绝不整文件载入；
 *   - 整份 JSON 有 32 MB 上限，超过就明确告知用户而不是硬撑；
 *   - 单行损坏只记录警告，其余行照常解析；
 *   - 全部失败时返回可执行的建议，而不是一句"解析失败"。
 */
export async function loadSessionsFromFile(args: LoadSessionArgs): Promise<LoadSessionResult> {
  const {
    filePath,
    fileSizeBytes,
    modifiedMs,
    fs,
    fingerprint,
    homeDir,
    platform,
    threadTitles,
    keepRaw = true,
    requireMeaningfulEvents = false
  } = args
  const displayPath = toDisplayPath(filePath, { showFullPaths: false, homeDir, platform })
  const issues: ScanIssue[] = []
  const warnings: ScanIssue[] = []

  const issue = (kind: ScanIssue['kind'], reason: string, suggestion: string): ScanIssue => ({
    path: filePath,
    displayPath,
    kind,
    reason,
    suggestion
  })

  let records: ParsedRecord[] | undefined
  let root: unknown
  let badRecords: BadRecord[] = []
  let truncated = false
  /** 超出记录上限、没有逐条留下的坏行数量。 */
  let badLineOverflow = 0

  if (fingerprint.format === 'jsonl') {
    // 边读边解析：不把整份文件的行先攒成数组，省掉一整份拷贝。
    const streamed: ParsedRecord[] = []
    const streamedBad: BadRecord[] = []
    let lineCount = 0

    try {
      for await (const chunk of fs.streamLines(filePath, {
        maxLines: MAX_PARSED_LINES,
        maxBytes: MAX_PARSED_BYTES
      })) {
        lineCount += 1
        const text = chunk.line.trim()
        if (text === '') continue
        if (text.startsWith('//') || text.startsWith('#')) continue

        const parsed = safeJsonParse(text)
        if (parsed.ok) {
          streamed.push({ value: parsed.value, line: chunk.index + 1 })
        } else if (streamedBad.length < MAX_REPORTED_BAD_LINES) {
          streamedBad.push({ line: chunk.index + 1, error: parsed.error, preview: previewOf(text) })
        } else {
          badLineOverflow += 1
        }
      }
    } catch (error) {
      return {
        sessions: [],
        issues: [
          issue(
            'unreadable',
            `读取文件时出错：${error instanceof Error ? error.message : String(error)}`,
            '确认文件没有被其他程序占用，然后重新扫描。'
          )
        ]
      }
    }

    if (lineCount >= MAX_PARSED_LINES) {
      truncated = true
      warnings.push(
        issue(
          'partial-records',
          `这个文件很长，只读取了前 ${MAX_PARSED_LINES.toLocaleString('zh-CN')} 条记录。`,
          '前面的内容都能正常查看；如需完整内容，可用文本编辑器打开原始文件。'
        )
      )
    }

    records = streamed
    badRecords = streamedBad

    if (records.length === 0) {
      return {
        sessions: [],
        issues: [
          issue(
            'parse-failed',
            badRecords.length > 0
              ? `文件里 ${badRecords.length} 行都不是合法的 JSON（第 ${badRecords[0]?.line} 行：${badRecords[0]?.error}）。`
              : '文件里没有任何内容。',
            '这个文件可能不是 Codex 会话，或者写入时被中断了。可以用文本编辑器打开确认一下。'
          )
        ]
      }
    }
  } else {
    if (fileSizeBytes > MAX_PARSED_BYTES) {
      return {
        sessions: [],
        issues: [
          issue(
            'skipped-large',
            `这是一个 ${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB 的单体 JSON 文件，超过了 ${
              MAX_PARSED_BYTES / 1024 / 1024
            } MB 的解析上限。`,
            '单个 JSON 必须整份读入才能解析，所以太大的文件会被跳过。如果它其实是逐行 JSON，把扩展名改成 .jsonl 后重新扫描即可。'
          )
        ]
      }
    }

    let text: string
    try {
      const result = await fs.readText(filePath, MAX_PARSED_BYTES)
      text = result.text
      truncated = result.truncated
    } catch (error) {
      return {
        sessions: [],
        issues: [
          issue(
            'unreadable',
            `读取文件时出错：${error instanceof Error ? error.message : String(error)}`,
            '确认文件没有被其他程序占用，然后重新扫描。'
          )
        ]
      }
    }

    const parsed = safeJsonParse(text)
    if (parsed.ok) {
      root = parsed.value
    } else {
      // 有些工具会把逐行 JSON 存成 .json，这里再按 JSONL 试一次。
      const lines = text.split(/\r?\n/).map((line, index) => ({ line, index }))
      const asLines = parseLines(lines)
      if (asLines.records.length > 0) {
        records = asLines.records
        badRecords = asLines.badRecords
        warnings.push(
          issue(
            'partial-records',
            '这个 .json 文件其实是"每行一条 JSON"的格式，已按逐行方式解析。',
            '无需处理，只是提醒你文件格式和扩展名不太一致。'
          )
        )
      } else {
        return {
          sessions: [],
          issues: [
            issue(
              'parse-failed',
              `文件内容不是合法的 JSON：${parsed.error}`,
              '文件可能在写入过程中被中断了。可以用文本编辑器打开看看结尾是否缺少 } 或 ]。'
            )
          ]
        }
      }
    }
  }

  const input: ParserInput = {
    filePath,
    fileName: baseName(filePath),
    format: fingerprint.format,
    fileSizeBytes,
    modifiedMs,
    root,
    records,
    badRecords,
    truncated
  }

  const parser = pickParser(input)
  if (!parser) {
    return {
      sessions: [],
      issues: [
        issue(
          'not-a-session',
          '这个文件能解析成 JSON，但里面找不到对话或事件列表。',
          '它可能是配置文件或其他数据文件。如果你确定它是 Codex 会话，可以通过"导入单个文件"再试一次。'
        )
      ]
    }
  }

  if (badRecords.length > 0) {
    const first = badRecords[0]
    const total = badRecords.length + badLineOverflow
    warnings.push(
      issue(
        'partial-records',
        `有 ${total} 行内容损坏，已跳过（第 ${first?.line} 行：${first?.error}）。`,
        '其余记录都已正常读取，会话仍然可以查看。'
      )
    )
  }

  const drafts = dedupeDraftKeys(parser.locate(input))

  if (drafts.length === 0) {
    return {
      sessions: [],
      issues: [
        issue(
          'not-a-session',
          '这个文件能解析成 JSON，但里面找不到对话或事件列表。',
          '它可能是配置文件或其他数据文件。如果你确定它是 Codex 会话，可以通过"导入单个文件"再试一次。'
        )
      ]
    }
  }

  const sessions: CodexSession[] = []

  for (const draft of drafts) {
    try {
      const session = buildSession({
        draft,
        filePath,
        fileSizeBytes,
        modifiedMs,
        parserId: parser.id,
        confidence: fingerprint.confidence,
        confidenceScore: fingerprint.score,
        warnings,
        homeDir,
        platform,
        ...(threadTitles === undefined ? {} : { threadTitles }),
        keepRaw,
        requireMeaningfulEvents
      })
      if (session) sessions.push(session)
    } catch (error) {
      issues.push(
        issue(
          'parse-failed',
          `整理会话内容时出错：${error instanceof Error ? error.message : String(error)}`,
          '这是解析器的问题，不会影响你的原始文件。可以把这个文件通过"导入单个文件"再试一次。'
        )
      )
    }
  }

  if (sessions.length === 0 && issues.length === 0) {
    issues.push(
      requireMeaningfulEvents
        ? issue(
            'not-a-session',
            '文件里有一些 JSON 记录，但既没有一问一答的对话，也没有一次完整的会话过程 —— 它更像配置或状态文件。',
            '如果你确定这是一次 Codex 会话，用「导入单个文件」打开它，那条路不做这项检查。'
          )
        : issue(
            'empty',
            '文件结构看起来像会话，但里面没有任何可展示的记录。',
            '可能是一个刚创建就中断的空会话，可以忽略。'
          )
    )
  }

  return { sessions, issues }
}
