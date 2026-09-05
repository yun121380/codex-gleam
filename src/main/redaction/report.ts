import {
  REDACTION_REPORT_MAX_KEPT,
  REDACTION_REPORT_MAX_KEPT_KEYS,
  REDACTION_REPORT_MAX_SAMPLES
} from '@shared/constants'
import type {
  KeptReason,
  RedactionHit,
  RedactionKeptEntry,
  RedactionReport,
  RedactionRuleGroup
} from '@shared/types'

/**
 * 打码过程的旁路记录。
 *
 * 这个模块**不 import `redact.ts`**。依赖方向是 `redact.ts` → `report.ts`（只拿接口），
 * `library.ts` → 两边都拿。收集器要是自己去调 `redactSession`，两个模块立刻成环，
 * 而且审计的入口也就跑到了错误的层 —— 决定「什么时候审计一次」是 library 的事。
 */

/**
 * 打码时顺路把「打了什么」和「什么没打」记下来的接收端。
 *
 * 所有 `redact*` 函数的 `sink` 参数都是可选的：不传时它们一行逻辑都不多走，
 * 现有调用点与现有测试完全不受影响。
 */
export interface RedactionSink {
  hit(hit: RedactionHit): void
  kept(keyName: string, reason: KeptReason): void
}

export interface RedactionCollector extends RedactionSink {
  /** 结账。分组、排序、截断都在这里做一次。 */
  summarize(sessionId: string, redactEnabled: boolean): RedactionReport
}

/**
 * `kept` 聚合键的分隔符。
 *
 * 键名里不可能出现 U+0000；用 `:` 会和 `a:b` 这种真实键名撞在一起。
 */
const KEPT_KEY_SEPARATOR = String.fromCharCode(0)

/** 字典序比较。`localeCompare` 的结果随语言环境变，审计报告要的是「每次都一样」。 */
function byCodePoint(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

export function createCollector(): RedactionCollector {
  /**
   * 边分组边收，不先攒后分。
   *
   * 一份塞满 Cookie 的百 MB 日志能命中几十万次，但报告里每条规则只需要 5 条样例。
   * 所以内存占用是 `规则数 × 5`，而 `count` 照样是精确的 —— 这就是「计数精确、
   * 样例截断」那条约束的落地方式。
   */
  const groups = new Map<string, { count: number; samples: RedactionHit[] }>()
  const kept = new Map<string, RedactionKeptEntry>()
  /** 不同的「键名 + 原因」组合超过上限，后来的没能进 Map。 */
  let keptOverflowed = false

  return {
    hit(hit: RedactionHit): void {
      const group = groups.get(hit.rule)
      if (group === undefined) {
        groups.set(hit.rule, { count: 1, samples: [hit] })
        return
      }
      group.count += 1
      if (group.samples.length < REDACTION_REPORT_MAX_SAMPLES) {
        group.samples.push(hit)
      }
    },

    kept(keyName: string, reason: KeptReason): void {
      // 同一个键名因为两种不同原因被排除，是有意义的两条：`token` 可能因为值是
      // 数字被排除，也可能因为值是模板变量被排除，用户看到的是两句不同的话。
      const key = `${keyName}${KEPT_KEY_SEPARATOR}${reason}`
      const entry = kept.get(key)
      if (entry !== undefined) {
        entry.count += 1
        return
      }
      // 到了上限就停止**新增**，已有的照样继续计数。
      if (kept.size >= REDACTION_REPORT_MAX_KEPT_KEYS) {
        keptOverflowed = true
        return
      }
      kept.set(key, { keyName, reason, count: 1 })
    },

    summarize(sessionId: string, redactEnabled: boolean): RedactionReport {
      const sortedGroups: RedactionRuleGroup[] = [...groups.entries()]
        .map(([rule, group]) => ({ rule, count: group.count, samples: group.samples }))
        .sort((a, b) => b.count - a.count || byCodePoint(a.rule, b.rule))

      const sortedKept: RedactionKeptEntry[] = [...kept.values()].sort(
        (a, b) =>
          b.count - a.count ||
          byCodePoint(a.keyName, b.keyName) ||
          byCodePoint(a.reason, b.reason)
      )

      let totalHits = 0
      for (const group of sortedGroups) totalHits += group.count

      return {
        sessionId,
        redactEnabled,
        // 是所有 count 之和，不是 groups.length —— 后者是「有几条规则命中过」。
        totalHits,
        groups: sortedGroups,
        kept: sortedKept.slice(0, REDACTION_REPORT_MAX_KEPT),
        // 两种截断对用户是同一件事：「这里没列全」。
        keptTruncated: keptOverflowed || sortedKept.length > REDACTION_REPORT_MAX_KEPT
      }
    }
  }
}

/**
 * 把一个 sink 绑到某条事件上。
 *
 * `redactText` 不知道自己在处理哪条事件，也不该知道 —— 它的签名是 `(input, sink?)`。
 * 所以 `eventId` 由外面包一层塞进去：`redactSession` 遍历事件时给每条事件包一个，
 * 包出来的 sink 只多做一件事，就是把 `eventId` 填上。
 *
 * `kept` 原样转发，**不**挂事件 id：同一个 `author` 在三十条事件里各出现一次，
 * 报三十条毫无用处，报「`author` × 30」才有用。
 */
export function scopedTo(sink: RedactionSink, eventId: string): RedactionSink {
  return {
    hit(hit: RedactionHit): void {
      sink.hit({ ...hit, eventId })
    },
    kept(keyName: string, reason: KeptReason): void {
      sink.kept(keyName, reason)
    }
  }
}
