/** 界面上所有"人话"格式化都收在这里，保证各处口径一致。 */

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value.toLocaleString('zh-CN')
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '未记录时间'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '未记录时间'
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

export function formatTimeOnly(iso: string | null | undefined): string {
  if (!iso) return '--:--'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '时间未知'
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return '时间未知'

  const diff = now - timestamp
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

/**
 * 会话列表里那一行的时间。
 *
 * 一天之内用"3 小时前"这种说法，最直观；再往前就换成具体的日期和时刻。
 *
 * 换的理由很实在：并行子代理会在同一分钟里跑出十几个会话，而它们收到的是
 * 同一段任务描述，于是标题也一模一样 —— 全都只写"13 天前"的话，
 * 列表上就是十几行长得完全一样的条目，根本分不清点哪个。
 */
export function formatListTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '时间未知'
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return '时间未知'

  const diff = now - timestamp
  if (diff < 24 * 60 * 60_000) return formatRelativeTime(iso, now)

  const date = new Date(timestamp)
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`
  // 跨年的会话才带上年份，免得每一行都顶着一个重复的"2026"。
  return date.getFullYear() === new Date(now).getFullYear() ? stamp : `${date.getFullYear()}-${stamp}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知'
  if (ms < 1000) return '不到 1 秒'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function truncateMiddle(text: string, max = 60): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export function fileExtensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const index = name.lastIndexOf('.')
  return index <= 0 ? '' : name.slice(index).toLowerCase()
}

export function baseNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** token 数在徽标上要短：一万以上换成 9.8k，免得把整行顶开。详情走 title 提示。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 10_000) return formatNumber(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/**
 * 金额。两个单价都没填就返回 null —— 界面据此决定"只显示 token 数"。
 *
 * 只填了一个也算：另一个按 0 计。这不是想当然，而是"填了输入价、没填输出价"时
 * 唯一诚实的做法 —— 提示里会说明金额只算了填过的那一半。
 */
export function formatCost(
  usage: { inputTokens: number; outputTokens: number },
  pricePerMillionInput: number | null,
  pricePerMillionOutput: number | null,
  currency: string
): string | null {
  if (pricePerMillionInput === null && pricePerMillionOutput === null) return null

  const cost =
    (usage.inputTokens * (pricePerMillionInput ?? 0) +
      usage.outputTokens * (pricePerMillionOutput ?? 0)) /
    1_000_000
  if (!Number.isFinite(cost) || cost < 0) return null

  // 便宜到 0.01 以下就多给两位小数，否则一屏的会话全显示 0.00。
  const digits = cost > 0 && cost < 0.01 ? 4 : 2
  return `${currency}${cost.toFixed(digits)}`
}
