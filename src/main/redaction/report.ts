import {
  REDACTION_REPORT_MAX_KEPT,
  REDACTION_REPORT_MAX_KEPT_KEYS,
  REDACTION_REPORT_MAX_SAMPLES,
  REDACTION_RESIDUAL_MAX_KEYS,
  REDACTION_RESIDUAL_MAX_TEXT,
  REDACTION_RESIDUAL_PRUNE_TO,
  REDACTION_RESIDUAL_TOP
} from '@shared/constants'
import type {
  KeptReason,
  RedactionHit,
  RedactionKeptEntry,
  RedactionReport,
  RedactionResidual,
  RedactionRuleGroup,
  ResidualShape
} from '@shared/types'

/**
 * 打码过程的旁路记录。
 *
 * 这个模块**不 import `redact.ts`**。依赖方向是 `redact.ts` → `report.ts`（只拿接口），
 * `library.ts` → 两边都拿。收集器要是自己去调 `redactSession`，两个模块立刻成环，
 * 而且审计的入口也就跑到了错误的层 —— 决定「什么时候审计一次」是 library 的事。
 */

/**
 * 报一条可疑残留时给的东西。
 *
 * 比 `RedactionResidual` 少两个字段：`count` 是收集器数出来的，`eventId` 是
 * `scopedTo` 盖上去的。扫描那一侧既不知道这个片段出现过几次，也不知道自己正在
 * 处理哪条事件 —— 让它填这两个字段，就等于给每个调用点一次填错的机会。
 */
export interface ResidualInput {
  /** 片段原文。超过 `REDACTION_RESIDUAL_MAX_TEXT` 的部分由收集器截掉。 */
  text: string
  /** 原文的真实长度。打分用的是这个数，所以它必须由调用方给。 */
  length: number
  score: number
  shape: ResidualShape | null
  /** 只有 `scopedTo` 填它。 */
  eventId?: string
}

/**
 * 打码时顺路把「打了什么」和「什么没打」记下来的接收端。
 *
 * 所有 `redact*` 函数的 `sink` 参数都是可选的：不传时它们一行逻辑都不多走，
 * 现有调用点与现有测试完全不受影响。
 */
export interface RedactionSink {
  hit(hit: RedactionHit): void
  kept(keyName: string, reason: KeptReason): void
  /** 五个阶段都没碰过、但看起来像密钥的片段。**没有阈值**：报上来就都收。 */
  residual(entry: ResidualInput): void
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

/**
 * 残留的排名规则：分数降序，同分按片段本身的码点升序。
 *
 * 剪枝和最终排序共用它。两处各写一遍排序规则，是这份报告将来不可复现的最短路径。
 */
function byResidualRank(a: RedactionResidual, b: RedactionResidual): number {
  return b.score - a.score || byCodePoint(a.text, b.text)
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

  /**
   * 残留的排名表，键是**截断后**的片段原文。
   *
   * 上限管住内存，下面那段论证管住正确性 —— 两件事都不依赖机器有多快。这就是这一期
   * 没有用挂钟超时的原因：挂钟让输出随机器变快变慢，和「排序稳定且可复现」直接打架。
   */
  const residuals = new Map<string, RedactionResidual>()
  /** 进表的门槛。剪枝之前是 0，也就是「谁都能进」。只会涨，不会跌。 */
  let floor = 0
  /** 有片段因为门槛或剪枝被丢掉，真实的不同片段比表里的多。 */
  let residualsPruned = false

  /**
   * 表满了就砍到 `REDACTION_RESIDUAL_PRUNE_TO`，并把门槛抬到留下的最后一名。
   *
   * **被丢掉的片段永远进不了前 20**，分两种情形：剪枝时砍掉的那些，排在留下的 1000 条
   * 之后；门槛拒掉的那些，分数严格低于表里每一条（表里所有条目的分数都 ≥ `floor`）。
   * 两种情形下都有 ≥ 1000 条排在它前面。
   *
   * 这个「1000 条」不会被后续剪枝稀释：每次剪枝只会用**排得更前**的新条目顶掉旧条目，
   * 所以剪枝后留下的 1000 条，要么本来就在上一轮的留存集里，要么顶掉了留存集里的某一条
   * （于是排得比那一条更前）。归纳下来，任何时刻表里都有 1000 条排在任何一个被丢者之前。
   * 1000 > `REDACTION_RESIDUAL_TOP`，所以面板上那 20 条是**精确的**前 20 条，不是近似。
   */
  function pruneResiduals(): void {
    const ranked = [...residuals.values()].sort(byResidualRank)
    residuals.clear()
    for (const entry of ranked.slice(0, REDACTION_RESIDUAL_PRUNE_TO)) {
      residuals.set(entry.text, entry)
    }
    // 留下的最后一名就是新门槛。它只会涨：被砍掉的都排在它后面。
    floor = ranked[REDACTION_RESIDUAL_PRUNE_TO - 1]?.score ?? floor
    residualsPruned = true
  }

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

    residual(entry: ResidualInput): void {
      // 超长片段按开头去重 —— 对同一张图切出来的碎片，这正是想要的效果。
      const text = entry.text.slice(0, REDACTION_RESIDUAL_MAX_TEXT)
      const existing = residuals.get(text)
      if (existing !== undefined) {
        // **先加计数，再谈门槛**：一个已经排上名的片段，不该因为门槛涨了就停止计数。
        existing.count += 1
        return
      }
      if (entry.score < floor) {
        residualsPruned = true
        return
      }
      residuals.set(text, {
        text,
        length: entry.length,
        score: entry.score,
        shape: entry.shape,
        count: 1,
        // 只记第一次见到它的那条事件：同一个片段出现在三条事件里时，跳到第一条更自然。
        eventId: entry.eventId ?? null
      })
      if (residuals.size > REDACTION_RESIDUAL_MAX_KEYS) pruneResiduals()
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

      const sortedResiduals = [...residuals.values()].sort(byResidualRank)

      let totalHits = 0
      for (const group of sortedGroups) totalHits += group.count

      return {
        sessionId,
        redactEnabled,
        // 是所有 count 之和，不是 groups.length —— 后者是「有几条规则命中过」。
        // 残留**不算**命中：把它加进来，「打掉了 N 处」就变成一句假话。
        totalHits,
        groups: sortedGroups,
        kept: sortedKept.slice(0, REDACTION_REPORT_MAX_KEPT),
        // 两种截断对用户是同一件事：「这里没列全」。
        keptTruncated: keptOverflowed || sortedKept.length > REDACTION_REPORT_MAX_KEPT,
        residuals: sortedResiduals.slice(0, REDACTION_RESIDUAL_TOP),
        // 表内条数，精确；「会话里一共有多少个不同片段」不可知，所以不给。
        residualsTotal: sortedResiduals.length,
        residualsPruned
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
 *
 * `residual` 相反，**要**挂事件 id：残留条目在面板上是可点击定位的，不知道它在第几步，
 * 用户就只能拿着一个字符串在时间线上自己找。紧挨着的两个方法做了相反的事，这里说清
 * 理由，否则一定会有人来「统一」它们。
 */
export function scopedTo(sink: RedactionSink, eventId: string): RedactionSink {
  return {
    hit(hit: RedactionHit): void {
      sink.hit({ ...hit, eventId })
    },
    kept(keyName: string, reason: KeptReason): void {
      sink.kept(keyName, reason)
    },
    residual(entry: ResidualInput): void {
      sink.residual({ ...entry, eventId })
    }
  }
}
