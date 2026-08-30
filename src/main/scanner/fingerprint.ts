import {
  FINGERPRINT_NEGATIVE_SIGNALS,
  FINGERPRINT_SATURATION,
  FINGERPRINT_SIGNALS
} from '@shared/constants'
import { confidenceFromScore } from '@shared/validators'
import type { ConfidenceLevel } from '@shared/types'
import { fileExtension } from './paths'

export type DetectedFormat = 'json' | 'jsonl' | 'unknown'

export interface FingerprintResult {
  /** 综合评分，0—1。 */
  score: number
  rawScore: number
  confidence: ConfidenceLevel
  format: DetectedFormat
  /** 命中的正向特征，用于界面上解释"为什么认为它是会话"。 */
  matched: string[]
  /** 命中的反向特征（例如 package.json 的 devDependencies）。 */
  rejected: string[]
  /** 一句话中文说明。 */
  reason: string
}

/**
 * 判断一段文件开头文本是否像 Codex 会话。
 *
 * 使用评分而不是"命中即通过"，因为不同 Codex 版本、不同导出工具写出的字段名
 * 差别很大。评分同时作为界面上展示的"识别可信度"。
 */
export function fingerprintSample(sample: string, fileName = ''): FingerprintResult {
  const format = detectFormat(sample, fileName)
  const lower = sample.toLowerCase()

  const matched: string[] = []
  const rejected: string[] = []
  let positive = 0
  let negative = 0

  for (const signal of FINGERPRINT_SIGNALS) {
    if (lower.includes(signal.token)) {
      matched.push(signal.token)
      positive += signal.weight
    }
  }

  for (const signal of FINGERPRINT_NEGATIVE_SIGNALS) {
    if (lower.includes(signal.token)) {
      rejected.push(signal.token)
      negative += signal.weight
    }
  }

  // 结构性加分：出现"角色 + 对话双方"是聊天记录最可靠的信号。
  if (lower.includes('"role"') && (lower.includes('"user"') || lower.includes('"assistant"'))) {
    matched.push('role+对话角色')
    positive += 2
  }

  // 出现 ISO 时间戳，说明这是带时间线的日志而不是配置文件。
  if (/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/.test(lower)) {
    matched.push('ISO 时间戳')
    positive += 1
  }

  if (format === 'jsonl') {
    matched.push('逐行 JSON 结构')
    positive += 1
  }

  const rawScore = positive - negative
  const score = clamp01(rawScore / FINGERPRINT_SATURATION)

  return {
    score,
    rawScore,
    confidence: confidenceFromScore(score),
    format,
    matched,
    rejected,
    reason: buildReason(score, matched, rejected, format)
  }
}

function buildReason(
  score: number,
  matched: string[],
  rejected: string[],
  format: DetectedFormat
): string {
  if (rejected.length > 0 && score <= 0) {
    return `看起来是配置文件（含 ${rejected.slice(0, 2).join('、')}），不是会话记录。`
  }
  if (matched.length === 0) {
    return '文件里没有出现任何会话相关的特征。'
  }
  const formatText = format === 'jsonl' ? '逐行 JSON' : format === 'json' ? 'JSON' : '未知格式'
  return `${formatText} 文件，命中 ${matched.length} 个会话特征：${matched.slice(0, 4).join('、')}${
    matched.length > 4 ? '…' : ''
  }`
}

/**
 * 判断是 JSON 还是 JSONL。
 * 扩展名只是提示 —— 有些工具会把逐行 JSON 存成 .json，所以还要看内容。
 */
export function detectFormat(sample: string, fileName = ''): DetectedFormat {
  const trimmed = sample.trimStart()
  if (trimmed === '') return 'unknown'

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const objectLines = lines.filter((line) => line.startsWith('{') || line.startsWith('['))
  const selfClosedLines = lines.filter(
    (line) =>
      (line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))
  )

  // 至少两行、且这些行各自是完整 JSON —— 典型的 JSONL。
  if (lines.length >= 2 && selfClosedLines.length >= 2 && objectLines.length >= 2) {
    return 'jsonl'
  }

  const extension = fileExtension(fileName)
  if (extension === '.jsonl') return 'jsonl'
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  return 'unknown'
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}
