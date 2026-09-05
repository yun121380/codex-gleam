import {
  ALLOWED_EXTENSIONS,
  DEFAULT_SETTINGS,
  IGNORED_DIR_NAMES,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM
} from './constants'
import type { AppSettings, ConfidenceLevel } from './types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return null
}

/** 从多个候选键里取第一个非空字符串，用于适配字段名不统一的日志。 */
export function firstString(source: unknown, keys: readonly string[]): string | null {
  if (!isRecord(source)) return null
  for (const key of keys) {
    const value = asString(source[key])
    if (value !== null && value.trim() !== '') return value
  }
  return null
}

export function firstDefined(source: unknown, keys: readonly string[]): unknown {
  if (!isRecord(source)) return undefined
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key]
  }
  return undefined
}

/**
 * 把各种时间表示统一成 ISO 字符串。
 * 支持：ISO 字符串、毫秒时间戳、秒时间戳、数字字符串。无法识别时返回 null。
 */
export function coerceTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return fromEpoch(value)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed)
      if (Number.isFinite(numeric)) return fromEpoch(numeric)
    }

    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }

  return null
}

function fromEpoch(value: number): string | null {
  // 秒 / 毫秒 / 微秒 三种常见量级。
  let ms = value
  if (Math.abs(value) < 1e11) ms = value * 1000
  else if (Math.abs(value) > 1e14) ms = value / 1000

  const date = new Date(ms)
  const year = date.getUTCFullYear()
  if (Number.isNaN(date.getTime()) || year < 1990 || year > 2200) return null
  return date.toISOString()
}

export function safeJsonParse<T = unknown>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function isIgnoredDirName(name: string): boolean {
  const lower = name.toLowerCase()
  return IGNORED_DIR_NAMES.some((ignored) => ignored.toLowerCase() === lower)
}

export function hasAllowedExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function confidenceFromScore(score: number): ConfidenceLevel {
  if (score >= CONFIDENCE_HIGH) return 'high'
  if (score >= CONFIDENCE_MEDIUM) return 'medium'
  return 'low'
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = asNumber(value)
  if (numeric === null) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    const text = asString(entry)
    if (text && text.trim() !== '') seen.add(text)
  }
  return [...seen]
}

/** 把任意（可能损坏或来自旧版本）的设置对象修正为合法设置。 */
export function normalizeSettings(input: unknown): AppSettings {
  if (!isRecord(input)) return { ...DEFAULT_SETTINGS }

  const theme = input.theme === 'light' ? 'light' : 'dark'

  return {
    extraScanDirs: asStringArray(input.extraScanDirs),
    useBuiltinDirs: asBoolean(input.useBuiltinDirs) ?? DEFAULT_SETTINGS.useBuiltinDirs,
    maxDepth: Math.round(clampNumber(input.maxDepth, 1, 20, DEFAULT_SETTINGS.maxDepth)),
    maxFileSizeMb: Math.round(clampNumber(input.maxFileSizeMb, 1, 2048, DEFAULT_SETTINGS.maxFileSizeMb)),
    confidenceThreshold: clampNumber(
      input.confidenceThreshold,
      0,
      1,
      DEFAULT_SETTINGS.confidenceThreshold
    ),
    redactSensitive: asBoolean(input.redactSensitive) ?? DEFAULT_SETTINGS.redactSensitive,
    showFullPaths: asBoolean(input.showFullPaths) ?? DEFAULT_SETTINGS.showFullPaths,
    theme,
    playbackIntervalMs: Math.round(
      clampNumber(input.playbackIntervalMs, 200, 10_000, DEFAULT_SETTINGS.playbackIntervalMs)
    ),
    hiddenSources: asStringArray(input.hiddenSources),
    hiddenSessionIds: asStringArray(input.hiddenSessionIds),
    pricePerMillionInput: asPrice(input.pricePerMillionInput),
    pricePerMillionOutput: asPrice(input.pricePerMillionOutput),
    priceCurrency: asString(input.priceCurrency) ?? DEFAULT_SETTINGS.priceCurrency
  }
}

/**
 * 单价。空、非数字、负数都当"没填"。
 *
 * 0 不当没填 —— 免费额度内是一个真实的、有意义的单价。
 */
function asPrice(value: unknown): number | null {
  const parsed = asNumber(value)
  return parsed === null || parsed < 0 ? null : parsed
}

/** 事件内容有可能是字符串、数组或对象，这里统一压平成纯文本。 */
export function flattenTextContent(value: unknown, depth = 0): string {
  if (depth > 8) return ''
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (Array.isArray(value)) {
    return value
      .map((entry) => flattenTextContent(entry, depth + 1))
      .filter((entry) => entry.trim() !== '')
      .join('\n')
  }

  if (isRecord(value)) {
    // 按优先级探测常见的文本载体字段；每个字段本身也可能是数组或嵌套对象。
    for (const key of TEXT_CARRIER_KEYS) {
      const candidate = value[key]
      if (candidate === undefined || candidate === null) continue
      const flattened = flattenTextContent(candidate, depth + 1)
      if (flattened.trim() !== '') return flattened
    }
    return ''
  }

  return ''
}

const TEXT_CARRIER_KEYS: readonly string[] = [
  'text',
  'content',
  'message',
  'output',
  'stdout',
  'delta',
  'value',
  'body',
  'summary',
  'reasoning',
  'description',
  'error'
]
