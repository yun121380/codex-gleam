# A2 · 用量聚合 实现计划

> 每个步骤用 `- [ ]` 标记，按任务顺序逐条实施、逐条勾掉。

**Goal:** 把现在被整条丢弃的用量记录里的数字捞出来，按"数列形状"判定它是累计值还是增量值，聚合成会话级的 `UsageSummary`，在会话头部与三种导出里显示出来。日志里没记用量时明确显示"日志未记录用量"，**绝不拿 0 冒充**。

**Architecture:** 一个新模块加一个新接缝。`src/main/parsers/usage.ts` 里的 `UsageCollector` 是一个纯数据聚合器——不认识文件系统、不认识 Electron、不抛异常。`NormalizeContext` 上新增 `noteUsage` 回调，与既有的 `noteNoise` 完全同形；`normalizeRecords` 内部持有一个 collector，把回调塞进逐条记录的上下文里，最后在 `NormalizedResult` 上多返回一个 `usage`。`buildSession` 把它挂到 `SessionSummary.usage` 上。渲染层与导出层只读这一个字段，不重算。

**Tech Stack:** 无新依赖。只用到 `src/shared/validators.ts` 里已有的容错转换（`asNumber` / `firstDefined` / `firstString` / `isRecord`）。

**Spec:** [docs/design/2026-09-05-parity-and-shareability-design.md](docs/design/2026-09-05-parity-and-shareability-design.md) —— 第 3.1 节（用量聚合）、第二节表格第一行（用量采集接缝）、第五节表格前两行（错误处理）、第六节"用量"段（测试清单）、第七节 A2 行（验收）。

## Global Constraints

以下值逐字或近逐字来自 spec，本计划每个任务都隐含遵守：

- **判据不看字段名，看数列形状**：整条序列单调不减 ⇒ 累计值，取最后一条；出现下降 ⇒ 增量值，求和。`total_token_usage` 与 `last_token_usage` 在不同 Codex 版本里语义不同，认名字必然认错。
- **记录继续丢弃，丢弃前把数字捞出来。** `NOISE_RECORD_TYPES` 一行不改，时间线上不会因为本期多出任何一个事件。
- **`SessionSummary.usage` 可空。没有就是"日志未记录用量"，绝不显示 0。**
- **不发货价格表。** 单价在设置里由用户自己填（每百万 token 的输入/输出价），默认为空则只显示 token 数不显示金额。
- 用量数字是字符串 / 缺字段 → 走 `validators.ts` 的容错转换，转不了就当缺失。
- **采集器内部必须自己吞掉一切异常。** 用量是附加信息，绝不能因为它让解析失败（与第五节"审计 sink 抛异常 → 吞掉"同一条原则）。
- 断言 `fixtures/sample-agent-harness.jsonl` 得出 **9760** 而不是 19250。
- 不改写任何原始会话文件；不引入网络、`child_process`；`fixtures/` 一个字节都不改。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `src/main/parsers/usage.ts`（新建） | `UsageCollector`：逐条喂记录，最后给出 `UsageSummary \| null` |
| `src/shared/types.ts`（改） | `UsageBasis`、`UsageSummary`、`SessionSummary.usage`、`AppSettings` 三个单价字段 |
| `src/shared/constants.ts`（改） | `DEFAULT_SETTINGS` 补三个单价默认值 |
| `src/shared/validators.ts`（改） | `normalizeSettings` 认识三个单价字段 |
| `src/main/parsers/types.ts`（改） | `NormalizeContext.noteUsage`、`NormalizedResult.usage` |
| `src/main/parsers/normalize.ts`（改） | 噪音判定之前调一次 `noteUsage`；`normalizeRecords` 持有 collector |
| `src/main/parsers/buildSession.ts`（改） | 把 `usage` 写进会话对象 |
| `src/main/storage/store.ts`（改） | `withDefaults` 改成逐字段补齐，旧索引拿到 `usage: null` |
| `src/main/exporters/reportModel.ts`（改） | 报告模型上带 `usage` |
| `src/main/exporters/markdown.ts`（改） | 概览表多一行用量 |
| `src/main/exporters/html.ts`（改） | 概览表多一行用量，`v` 放宽为 `string \| number` |
| `src/renderer/lib/format.ts`（改） | `formatUsageBadge` / `formatCost`：口径只在这里定一次 |
| `src/renderer/pages/SessionsPage.tsx`（改） | 会话头部的用量徽标与"日志未记录用量" |
| `src/renderer/pages/SettingsPage.tsx`（改） | 单价输入框 |
| `tests/parsers/usage.test.ts`（新建） | 采集器单元测试（spec 第六节清单） |
| `tests/parsers/usageSession.test.ts`（新建） | 端到端：三个 fixture 的用量断言，含 9760 |

---

### Task 1: 类型与默认值

**Files:**
- Modify: `src/shared/types.ts`、`src/shared/constants.ts`、`src/shared/validators.ts`、`src/main/storage/store.ts`
- Test: `tests/storage/store.test.ts`（若已存在则补一例，否则在 Task 4 一并验证）

**Interfaces:**
- Consumes: 无。
- Produces: `UsageBasis`、`UsageSummary`、`SessionSummary.usage`、`AppSettings.pricePerMillionInput / pricePerMillionOutput / priceCurrency`。后面每个任务都依赖它们。

- [ ] **Step 1: 加类型**

在 `src/shared/types.ts` 里，`SessionSummary` 之前加入（字段与注释逐字取自 spec 3.1）：

```ts
export type UsageBasis = 'cumulative' | 'delta'

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number | null   // 有的版本没有这个字段
  totalTokens: number
  /** 记下用了哪条规则，便于排错和界面提示 */
  basis: UsageBasis
  /** 按模型拆分；日志里没写模型名时只有一条 'unknown' */
  byModel: Array<{ model: string; totalTokens: number }>
  /** task_started 里的 model_context_window，用来算上下文占用率 */
  contextWindow: number | null
}
```

`SessionSummary` 末尾（`agent` 之后）加：

```ts
  /** 会话用量。null = 日志里没有任何用量记录，界面上要说"未记录"，不能显示 0。 */
  usage: UsageSummary | null
```

`AppSettings` 末尾加：

```ts
  /** 每百万输入 token 的单价。null = 没填，界面只显示 token 数不显示金额。 */
  pricePerMillionInput: number | null
  /** 每百万输出 token 的单价。 */
  pricePerMillionOutput: number | null
  /** 单价的货币符号，纯显示用。空字符串就不写单位。 */
  priceCurrency: string
```

**注意 `inputTokens` / `outputTokens` 是不可空的 `number`**（spec 就是这么写的），所以"日志只记了总数、没记拆分"时它们会是 0。这种 0 不许出现在界面上：显示侧一律用 `inputTokens + outputTokens > 0` 作为"拆分可用"的判据，Task 6、Task 7 会照此实现。

- [ ] **Step 2: 默认值与容错**

`src/shared/constants.ts` 的 `DEFAULT_SETTINGS` 补三行：

```ts
  pricePerMillionInput: null,
  pricePerMillionOutput: null,
  priceCurrency: ''
```

`src/shared/validators.ts` 的 `normalizeSettings` 里补三行。单价允许为 null，负数按没填处理：

```ts
  const price = (value: unknown): number | null => {
    const parsed = asNumber(value)
    return parsed === null || parsed < 0 ? null : parsed
  }
  // ...
  pricePerMillionInput: price(raw.pricePerMillionInput),
  pricePerMillionOutput: price(raw.pricePerMillionOutput),
  priceCurrency: asString(raw.priceCurrency) ?? DEFAULT_SETTINGS.priceCurrency,
```

具体写法照该函数现有风格对齐（它已有的取值助手叫什么就用什么）。

- [ ] **Step 3: 修 `withDefaults`**

`src/main/storage/store.ts:186` 现在是：

```ts
function withDefaults(summary: SessionSummary): SessionSummary {
  if (summary.agent) return summary
  return { ...summary, agent: { … } }
}
```

那个提前 return 是个陷阱：一份已经有 `agent` 的旧索引会原样返回，`usage` 就还是 `undefined`——类型上写着 `UsageSummary | null`，实际拿到 `undefined`，之后每一个 `usage === null` 的判断都会漏。改成逐字段补齐，以后再加字段也不会踩同一个坑：

```ts
/**
 * 旧索引缺字段就地补默认值，不逼用户重扫。
 *
 * 不要写成"某个字段存在就整条原样返回"——那样只要旧索引恰好有那一个字段，
 * 后来新增的字段就全都留在 undefined 上，而类型签名说它们不可能是 undefined。
 */
function withDefaults(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    agent: summary.agent ?? {
      threadId: null,
      parentThreadId: null,
      nickname: null,
      role: null,
      taskPath: null
    },
    usage: summary.usage ?? null
  }
}
```

- [ ] **Step 4: 验证**

```bash
pnpm typecheck
```

此时会报错的地方只应该是"缺少 usage 字段"——`buildSession` 的返回对象和测试里手写的 `SessionSummary`。它们分别在 Task 3 和各自任务里补。若测试 helper 里有手写摘要，就地补 `usage: null`。

---

### Task 2: 采集器

**Files:**
- Create: `src/main/parsers/usage.ts`
- Test: `tests/parsers/usage.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `UsageSummary` / `UsageBasis`。
- Produces: `class UsageCollector { note(record: unknown): void; summary(): UsageSummary | null }`。Task 3 唯一的消费者。

- [ ] **Step 1: 写失败的测试**

创建 `tests/parsers/usage.test.ts`。这份清单逐条对应 spec 第六节"用量"那一段：

```ts
import { describe, expect, it } from 'vitest'

import { UsageCollector } from '../../src/main/parsers/usage'

/** 造一条 Codex 的 token_count 记录（已剥壳，采集器看到的就是这个形状）。 */
function tokenCount(input: number, output: number, total?: number): unknown {
  return {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total ?? input + output
      }
    }
  }
}

function collect(records: unknown[]): ReturnType<UsageCollector['summary']> {
  const collector = new UsageCollector()
  for (const record of records) collector.note(record)
  return collector.summary()
}

describe('UsageCollector', () => {
  it('没有任何用量记录时返回 null，而不是一堆 0', () => {
    expect(collect([{ type: 'message', role: 'user' }])).toBeNull()
  })

  it('单调不减的序列判为累计值，取最后一条', () => {
    const usage = collect([tokenCount(4210, 180, 4390), tokenCount(4890, 210, 5100), tokenCount(9120, 640, 9760)])
    expect(usage?.basis).toBe('cumulative')
    expect(usage?.totalTokens).toBe(9760)
    expect(usage?.inputTokens).toBe(9120)
    expect(usage?.outputTokens).toBe(640)
  })

  it('出现下降的序列判为增量值，求和', () => {
    const usage = collect([tokenCount(100, 10, 110), tokenCount(50, 5, 55), tokenCount(20, 2, 22)])
    expect(usage?.basis).toBe('delta')
    expect(usage?.totalTokens).toBe(110 + 55 + 22)
    expect(usage?.inputTokens).toBe(170)
  })

  it('只有一条记录时按累计处理，两种规则算出来是同一个数', () => {
    const usage = collect([tokenCount(18422, 1180, 19602)])
    expect(usage?.basis).toBe('cumulative')
    expect(usage?.totalTokens).toBe(19602)
  })

  it('中途归零（上下文压缩）判为增量并求和，而不是把前半段丢掉', () => {
    const usage = collect([tokenCount(1000, 100, 1100), tokenCount(2000, 200, 2200), tokenCount(300, 30, 330)])
    expect(usage?.basis).toBe('delta')
    expect(usage?.totalTokens).toBe(1100 + 2200 + 330)
  })

  it('数字是字符串也认', () => {
    const usage = collect([
      { type: 'token_count', info: { total_token_usage: { input_tokens: '100', output_tokens: '20', total_tokens: '120' } } }
    ])
    expect(usage?.totalTokens).toBe(120)
  })

  it('缺 total_tokens 时用输入加输出补出来', () => {
    const usage = collect([
      { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } }
    ])
    expect(usage?.totalTokens).toBe(120)
  })

  it('三个数字全缺就当这条记录不存在', () => {
    expect(collect([{ type: 'token_count', info: { total_token_usage: { model: 'x' } } }])).toBeNull()
  })

  it('缓存字段缺失时是 null，不是 0', () => {
    expect(collect([tokenCount(100, 20, 120)])?.cachedInputTokens).toBeNull()
  })

  it('缓存字段存在时按同一条规则聚合', () => {
    const usage = collect([
      { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60, total_tokens: 120 } } },
      { type: 'token_count', info: { total_token_usage: { input_tokens: 300, output_tokens: 40, cached_input_tokens: 250, total_tokens: 340 } } }
    ])
    expect(usage?.basis).toBe('cumulative')
    expect(usage?.cachedInputTokens).toBe(250)
  })

  it('没有模型名时只有一条 unknown', () => {
    expect(collect([tokenCount(100, 20, 120)])?.byModel).toEqual([{ model: 'unknown', totalTokens: 120 }])
  })

  it('模型名从 turn_context 取，按模型拆分且各项之和等于总数', () => {
    const usage = collect([
      { type: 'turn_context', model: 'gpt-a' },
      tokenCount(4890, 210, 5100),
      { type: 'turn_context', model: 'gpt-b' },
      tokenCount(9120, 640, 9760)
    ])
    expect(usage?.byModel).toEqual([
      { model: 'gpt-a', totalTokens: 5100 },
      { model: 'gpt-b', totalTokens: 4660 }
    ])
    expect(usage?.byModel.reduce((sum, entry) => sum + entry.totalTokens, 0)).toBe(usage?.totalTokens)
  })

  it('增量序列按模型直接分别求和', () => {
    const usage = collect([
      { type: 'turn_context', model: 'gpt-a' },
      tokenCount(100, 10, 110),
      { type: 'turn_context', model: 'gpt-b' },
      tokenCount(50, 5, 55),
      tokenCount(20, 2, 22)
    ])
    expect(usage?.basis).toBe('delta')
    expect(usage?.byModel).toEqual([
      { model: 'gpt-a', totalTokens: 110 },
      { model: 'gpt-b', totalTokens: 77 }
    ])
  })

  it('上下文窗口取最后一个非空值', () => {
    const usage = collect([
      { type: 'task_started', model_context_window: 200000 },
      tokenCount(100, 20, 120),
      { type: 'task_started', model_context_window: 400000 }
    ])
    expect(usage?.contextWindow).toBe(400000)
  })

  it('只有上下文窗口、没有任何用量数字时仍然返回 null', () => {
    expect(collect([{ type: 'task_started', model_context_window: 200000 }])).toBeNull()
  })

  it('喂进去的东西再离谱也不抛异常', () => {
    const collector = new UsageCollector()
    const hostile = {
      get info() {
        throw new Error('boom')
      }
    }
    expect(() => collector.note(hostile)).not.toThrow()
    expect(() => collector.note(null)).not.toThrow()
    expect(() => collector.note('字符串')).not.toThrow()
    expect(() => collector.note([1, 2, 3])).not.toThrow()
    expect(collector.summary()).toBeNull()
  })
})
```

跑一遍确认全红（模块还不存在）：

```bash
pnpm vitest run tests/parsers/usage.test.ts
```

- [ ] **Step 2: 实现采集器**

创建 `src/main/parsers/usage.ts`。三段结构：常量与取值、逐条采集、最后聚合。

```ts
/**
 * 用量采集。
 *
 * 这些数字在日志里全都躺在噪音记录里（token_count / token_usage / usage /
 * rate_limits 都在 NOISE_RECORD_TYPES 名单上），归一化时整条丢掉。本模块的职责
 * 就是在丢掉之前把数字捞走，别的什么都不做 —— 不认文件、不认 Electron、不抛异常。
 */
import type { UsageBasis, UsageSummary } from '@shared/types'
import { asNumber, firstDefined, firstString, isRecord } from '@shared/validators'

/**
 * 一条记录里装用量的那个子对象可能叫什么，按优先级排。
 *
 * 名字的语义在不同 Codex 版本里是反的（有的版本 total_token_usage 是累计、
 * last_token_usage 是本轮；有的版本反过来），所以这里只用来"找到数字在哪"，
 * 绝不用来判断它是累计还是增量 —— 那件事交给数列形状。
 * 也正因为形状规则会自己纠错，这个优先级挑中哪一组都能得到同一个最终答案。
 */
const GROUP_KEYS = ['total_token_usage', 'token_usage', 'last_token_usage', 'usage', 'tokens']

/** 用量子对象可能藏在记录的哪一层下面。Codex 的 token_count 把它放在 info 里。 */
const CONTAINER_KEYS = ['info', 'usage', 'stats', 'metrics']

const INPUT_KEYS = ['input_tokens', 'prompt_tokens', 'input', 'prompt']
const OUTPUT_KEYS = ['output_tokens', 'completion_tokens', 'output', 'completion']
const CACHED_KEYS = ['cached_input_tokens', 'cache_read_input_tokens', 'cached_tokens', 'cache_read']
const TOTAL_KEYS = ['total_tokens', 'total', 'tokens']
const MODEL_KEYS = ['model', 'model_name', 'engine']
const WINDOW_KEYS = ['model_context_window', 'context_window', 'max_context_window']

interface Sample {
  input: number | null
  output: number | null
  cached: number | null
  /** 一定是个非负数：解不出总数的记录不会变成 Sample。 */
  total: number
  /** 这条用量记录生效时的模型名。null = 日志到这里还没写过模型名。 */
  model: string | null
}
```

取一组数字：

```ts
/**
 * 从一个"看起来装着用量"的对象里取出一份样本。
 *
 * 没有 total_tokens 时用输入加输出补；三个数字全缺就返回 null（当这条记录不存在，
 * 而不是当成一份 0 —— 谎报比不报更糟）。负数一律不认：那不可能是 token 数。
 */
function readSample(group: Record<string, unknown>): Omit<Sample, 'model'> | null {
  const input = asNumber(firstDefined(group, INPUT_KEYS))
  const output = asNumber(firstDefined(group, OUTPUT_KEYS))
  const cached = asNumber(firstDefined(group, CACHED_KEYS))
  const explicit = asNumber(firstDefined(group, TOTAL_KEYS))

  const total = explicit ?? (input === null && output === null ? null : (input ?? 0) + (output ?? 0))
  if (total === null || total < 0) return null

  return {
    input: input !== null && input >= 0 ? input : null,
    output: output !== null && output >= 0 ? output : null,
    cached: cached !== null && cached >= 0 ? cached : null,
    total
  }
}

/** 在记录本身与它的一层子容器里找用量子对象，找到第一份能用的就停。 */
function findSample(record: Record<string, unknown>): Omit<Sample, 'model'> | null {
  const containers: Array<Record<string, unknown>> = [record]
  for (const key of CONTAINER_KEYS) {
    const nested = record[key]
    if (isRecord(nested)) containers.push(nested)
  }

  for (const container of containers) {
    for (const key of GROUP_KEYS) {
      const group = container[key]
      if (isRecord(group)) {
        const sample = readSample(group)
        if (sample) return sample
      }
    }
  }

  // 没有子对象，数字直接摊在记录上：{ type: 'usage', input_tokens: 10, … }
  for (const container of containers) {
    const sample = readSample(container)
    if (sample) return sample
  }

  return null
}
```

采集器本体：

```ts
export class UsageCollector {
  private readonly samples: Sample[] = []
  private model: string | null = null
  private window: number | null = null

  /**
   * 喂一条记录。
   *
   * 整个方法体包在 try 里：用量是附加信息，任何一条畸形记录都不许让解析失败。
   * 出错就当这条记录没有用量，继续往下走 —— 已经收到的样本仍然有效。
   */
  note(record: unknown): void {
    try {
      if (!isRecord(record)) return

      const model = firstString(record, MODEL_KEYS)
      if (model !== null && model.trim() !== '') this.model = model.trim()

      const window = asNumber(firstDefined(record, WINDOW_KEYS))
      if (window !== null && window > 0) this.window = window

      const sample = findSample(record)
      if (sample) this.samples.push({ ...sample, model: this.model })
    } catch {
      // 故意什么都不做。
    }
  }

  summary(): UsageSummary | null {
    try {
      return this.build()
    } catch {
      return null
    }
  }

  private build(): UsageSummary | null {
    if (this.samples.length === 0) return null

    const basis = detectBasis(this.samples.map((sample) => sample.total))

    return {
      inputTokens: reduce(this.samples, basis, (sample) => sample.input) ?? 0,
      outputTokens: reduce(this.samples, basis, (sample) => sample.output) ?? 0,
      cachedInputTokens: reduce(this.samples, basis, (sample) => sample.cached),
      totalTokens: reduce(this.samples, basis, (sample) => sample.total) ?? 0,
      basis,
      byModel: splitByModel(this.samples, basis),
      contextWindow: this.window
    }
  }
}
```

三个聚合函数。**规则只判一次、判在总数序列上，然后同一个 basis 应用到每一个字段**——否则输入按累计取、输出按增量求和，各部分之和会跟总数打架：

```ts
/**
 * spec 3.1 的判据，逐字：
 *
 *   整条序列单调不减 ⇒ 累计值，取最后一条。
 *   出现下降 ⇒ 增量值，求和。
 *
 * 不看字段名。这条规则自带纠错：猜错字段语义会算错，看数列形状不会。
 * 序列中途归零（换会话、上下文压缩）会被判为增量并求和，这正是想要的结果。
 * 只有一条样本时序列平凡地单调不减，判为累计 —— 两种规则算出来是同一个数。
 */
function detectBasis(totals: readonly number[]): UsageBasis {
  for (let index = 1; index < totals.length; index += 1) {
    if (totals[index] < totals[index - 1]) return 'delta'
  }
  return 'cumulative'
}

/** 累计取最后一个有值的样本，增量把所有有值的样本加起来。全都没值就是 null。 */
function reduce(
  samples: readonly Sample[],
  basis: UsageBasis,
  pick: (sample: Sample) => number | null
): number | null {
  if (basis === 'cumulative') {
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      const value = pick(samples[index])
      if (value !== null) return value
    }
    return null
  }

  let sum: number | null = null
  for (const sample of samples) {
    const value = pick(sample)
    if (value !== null) sum = (sum ?? 0) + value
  }
  return sum
}

/**
 * 按模型拆分。不变量：各项之和恒等于 totalTokens。
 *
 * 累计口径下不能直接把每条样本的总数记到它的模型名上（那就是把累计值当增量求和，
 * 正是本模块要防的那个错）。改成把"相邻两条样本之差"记到后一条样本的模型上：
 * 第一条样本的全部计入它自己的模型，之后每一条只计入它比上一条多出来的部分。
 * 中途换模型时，新模型只背它自己新增的那一段。
 */
function splitByModel(
  samples: readonly Sample[],
  basis: UsageBasis
): Array<{ model: string; totalTokens: number }> {
  const totals = new Map<string, number>()
  let previous = 0

  for (const sample of samples) {
    const key = sample.model ?? 'unknown'
    const amount = basis === 'cumulative' ? Math.max(0, sample.total - previous) : sample.total
    totals.set(key, (totals.get(key) ?? 0) + amount)
    previous = sample.total
  }

  // 排序写死，保证同一份日志每次得到一模一样的结果（导出产物要可复现）。
  return [...totals.entries()]
    .map(([model, totalTokens]) => ({ model, totalTokens }))
    .sort((left, right) =>
      right.totalTokens - left.totalTokens || left.model.localeCompare(right.model)
    )
}
```

- [ ] **Step 3: 验证**

```bash
pnpm vitest run tests/parsers/usage.test.ts
```

全绿后再跑一遍 `pnpm typecheck`。

---

### Task 3: 接缝

**Files:**
- Modify: `src/main/parsers/types.ts`、`src/main/parsers/normalize.ts`、`src/main/parsers/buildSession.ts`
- Test: `tests/parsers/normalize.test.ts`（补一例）

**Interfaces:**
- Consumes: Task 2 的 `UsageCollector`。
- Produces: `NormalizedResult.usage`、`SessionSummary.usage` 上真的有值。Task 4—7 全都依赖。

- [ ] **Step 1: 接口**

`src/main/parsers/types.ts`，`NormalizeContext` 里紧跟 `noteNoise` 加：

```ts
  /**
   * 每条记录（含即将被当噪音丢弃的）都会经过这里，用来把用量数字与模型名捞走。
   *
   * 拿到的是剥壳之后的对象，与 normalizeRecord 自己看到的那个是同一份。
   */
  noteUsage?: (record: unknown) => void
```

`NormalizedResult` 里加：

```ts
  /** 会话用量。null = 这批记录里没有任何用量数字。 */
  usage: UsageSummary | null
```

并从 `@shared/types` 引入 `UsageSummary`。

- [ ] **Step 2: 调用点**

`src/main/parsers/normalize.ts:717` 之后、噪音判定那个 `if` 之前插入：

```ts
  // 用量数字和模型名必须在噪音判定之前捞走：token_count / task_started 恰好都在
  // 噪音名单里，等这个 if 把它们丢掉就没有第二次机会了。放在这里还有一个好处 ——
  // 一个调用点同时看得见被丢弃的用量记录和活下来的 turn_context（模型名在那里）。
  ctx.noteUsage?.(inner)
```

`normalizeRecords`（同文件 1224 行起）持有 collector，与 `noteNoise` 并列：

```ts
  const usage = new UsageCollector()
  let wasNoise: boolean
  const recordCtx: NormalizeContext = {
    ...ctx,
    noteNoise: () => {
      wasNoise = true
    },
    noteUsage: (record) => usage.note(record)
  }
```

最后一行改成：

```ts
  return { events: collapseSessionStarts(deduped), skipped, dropped, usage: usage.summary() }
}
```

注意 collector 由 `normalizeRecords` 自己持有，而不是让调用方传进来：调用方只想要结果，不该关心怎么攒出来的。测试要单独验证某条记录会不会被采集时，仍然可以自己给 `normalizeRecord` 传一个 `noteUsage`。

- [ ] **Step 3: 落到会话上**

`src/main/parsers/buildSession.ts:158` 的解构加一项：

```ts
  const { events, skipped, usage } = normalizeRecords(draft.records, {
```

返回对象（278 行起那一大坨）里加一行 `usage`。位置放在 `agent` 旁边，与 `SessionSummary` 的字段顺序对齐。

- [ ] **Step 4: 补一例归一化测试**

`tests/parsers/normalize.test.ts` 里加：

```ts
  it('噪音记录被丢弃，但它带的用量数字先被捞走了', () => {
    const records: ParsedRecord[] = [
      { value: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }, line: 1 }
    ]
    const result = normalizeRecords(records, context())
    expect(result.events).toHaveLength(0)
    expect(result.dropped).toBe(1)
    expect(result.usage?.totalTokens).toBe(12)
  })
```

- [ ] **Step 5: 验证**

```bash
pnpm vitest run tests/parsers
```

---

### Task 4: 端到端断言

**Files:**
- Create: `tests/parsers/usageSession.test.ts`

**Interfaces:**
- Consumes: Task 3 之后 `SessionSummary.usage` 上的真实值、`tests/support/fixtures.ts` 的 `loadFixtureSession`。
- Produces: spec 第六节那条关键断言的可执行形式。

- [ ] **Step 1: 写测试**

```ts
import { describe, expect, it } from 'vitest'

import { loadFixtureSession } from '../support/fixtures'

describe('会话用量', () => {
  /**
   * spec 第六节的关键断言。
   *
   * 这个 fixture 的三条 token_count 依次是 4390 → 5100 → 9760，单调递增，
   * 是累计值。直接求和会得到 19250，接近真值的两倍，而且会话越长错得越多。
   */
  it('累计序列的 fixture 得出 9760 而不是 19250', async () => {
    const session = await loadFixtureSession('sample-agent-harness.jsonl')

    expect(session.usage).not.toBeNull()
    expect(session.usage?.totalTokens).toBe(9760)
    expect(session.usage?.totalTokens).not.toBe(19250)
    expect(session.usage?.basis).toBe('cumulative')
    expect(session.usage?.inputTokens).toBe(9120)
    expect(session.usage?.outputTokens).toBe(640)
    expect(session.usage?.cachedInputTokens).toBeNull()
  })

  it('模型名从 turn_context 认出来，上下文窗口从 task_started 认出来', async () => {
    const session = await loadFixtureSession('sample-agent-harness.jsonl')

    expect(session.usage?.byModel).toEqual([{ model: 'demo-model', totalTokens: 9760 }])
    expect(session.usage?.contextWindow).toBe(200000)
  })

  it('只有一条用量记录的 fixture 也认', async () => {
    const session = await loadFixtureSession('sample-codex-session.jsonl')
    expect(session.usage?.totalTokens).toBe(19602)
  })

  it('日志里没有用量记录时是 null，不是一堆 0', async () => {
    const session = await loadFixtureSession('sample-partial-broken.jsonl')
    expect(session.usage).toBeNull()
  })
})
```

最后一例要挑一个真的没有用量记录的 fixture。落地前先确认：

```bash
grep -lE '"(total_)?token(_count|_usage|s)?"|input_tokens' fixtures/*.jsonl fixtures/*.json
```

没有用量记录的那个文件名填进去；如果每个 fixture 都有，就把这一例改成用 `UsageCollector` 直接验证（Task 2 已经覆盖了同一条性质，此时可以删掉这一例）。

- [ ] **Step 2: 验证**

```bash
pnpm vitest run tests/parsers/usageSession.test.ts
```

---

### Task 5: 单价设置

**Files:**
- Modify: `src/renderer/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: Task 1 的三个设置字段。
- Produces: 用户能填单价。Task 6 的金额显示依赖它。

- [ ] **Step 1: 加一张卡片**

放在"隐私与显示"之后、"本地数据"之前。文案要把"为什么不预置价格表"说清楚——这是 spec 的明确决定，不是偷懒：

```tsx
<Card className="mt-3">
  <SectionTitle hint="留空就只显示 token 数">用量单价</SectionTitle>
  <p className="text-[12.5px] leading-relaxed text-ink-soft">
    本应用不预置任何价格表 —— 写死的价格会过期，而过期的价格比没有价格更糟。
    想看金额就把你自己那份单价填进来，只保存在本机。
  </p>
  <div className="mt-3 grid gap-3 sm:grid-cols-3">
    <Field label="输入 / 每百万 token">
      <TextInput
        type="number"
        min={0}
        value={settings.pricePerMillionInput ?? ''}
        placeholder="留空"
        onChange={(value) => void actions.updateSettings({ pricePerMillionInput: parsePrice(value) })}
      />
    </Field>
    <Field label="输出 / 每百万 token">
      <TextInput
        type="number"
        min={0}
        value={settings.pricePerMillionOutput ?? ''}
        placeholder="留空"
        onChange={(value) => void actions.updateSettings({ pricePerMillionOutput: parsePrice(value) })}
      />
    </Field>
    <Field label="货币符号">
      <TextInput
        value={settings.priceCurrency}
        placeholder="例如 $ 或 ¥"
        onChange={(value) => void actions.updateSettings({ priceCurrency: value })}
      />
    </Field>
  </div>
</Card>
```

文件底部加：

```tsx
/** 空串与非数字都当"没填"，而不是当 0 —— 0 是一个有意义的单价（免费）。 */
function parsePrice(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
```

- [ ] **Step 2: 验证**

```bash
pnpm typecheck
```

---

### Task 6: 会话头部的用量徽标

**Files:**
- Modify: `src/renderer/lib/format.ts`、`src/renderer/pages/SessionsPage.tsx`
- Test: `tests/renderer/format.test.ts`（若已有该文件则补，否则新建）

**Interfaces:**
- Consumes: `SessionSummary.usage`、三个单价设置。
- Produces: A2 验收里"缺失时显示未记录"的那一半。

- [ ] **Step 1: 格式化口径**

`src/renderer/lib/format.ts` 末尾加两个函数。口径只定一次，Task 7 的导出也从这里拿（导出在主进程，若不便引用就照抄同样的算法并在注释里指回这里）：

```ts
/** token 数在徽标上要短：一万以上换成 "9.8k"，免得把整行顶开。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 10_000) return formatNumber(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/**
 * 金额。两个单价都没填就返回 null —— 界面据此决定"只显示 token 数"。
 *
 * 只填了一个也算：另一个当 0 处理，并且由调用方在提示里说明这一点。
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
  const digits = cost > 0 && cost < 0.01 ? 4 : 2
  return `${currency}${cost.toFixed(digits)}`
}
```

- [ ] **Step 2: 徽标**

`src/renderer/pages/SessionsPage.tsx` 的 `SessionHeader`，在可信度徽标那一行之后加。两条分支，一条都不能省：

```tsx
{detail.usage ? (
  <Badge className="bg-neutral-soft text-ink-soft" title={usageTooltip(detail.usage, settings)}>
    {formatTokens(detail.usage.totalTokens)} token{cost !== null ? ` · ${cost}` : ''}
  </Badge>
) : (
  <Badge className="bg-neutral-soft text-ink-faint" title="这份日志里没有任何用量记录。显示 0 会是谎报，所以这里什么数字都不给。">
    日志未记录用量
  </Badge>
)}
```

`usageTooltip` 放在同文件里，把详情全塞进 `title`（与可信度徽标同一个套路，不占版面）：

```tsx
function usageTooltip(usage: UsageSummary, settings: AppSettings): string {
  const lines: string[] = [`总计 ${formatNumber(usage.totalTokens)} token`]

  // 只记了总数、没记拆分时 inputTokens / outputTokens 会是 0，那种 0 不许显示。
  if (usage.inputTokens + usage.outputTokens > 0) {
    lines.push(`输入 ${formatNumber(usage.inputTokens)} · 输出 ${formatNumber(usage.outputTokens)}`)
  }
  if (usage.cachedInputTokens !== null) {
    lines.push(`其中命中缓存 ${formatNumber(usage.cachedInputTokens)}`)
  }
  lines.push(
    usage.basis === 'cumulative'
      ? '日志记的是累计值，取了最后一条'
      : '日志记的是每轮增量，已逐条相加'
  )
  if (usage.contextWindow !== null) {
    const ratio = Math.round((usage.totalTokens / usage.contextWindow) * 100)
    // 累计用量超过窗口是常态而不是异常：每一轮都会把上下文重发一遍。
    // 这时候写"占用 480%"纯属胡说，得把原因说出来。
    lines.push(
      ratio <= 100
        ? `模型上下文窗口 ${formatNumber(usage.contextWindow)}，这次用掉约 ${ratio}%`
        : `模型上下文窗口 ${formatNumber(usage.contextWindow)}；累计用量已经超过它 —— 每轮都会重发上下文，这是正常的`
    )
  }
  if (usage.byModel.length > 1 || (usage.byModel[0]?.model ?? 'unknown') !== 'unknown') {
    lines.push(
      ...usage.byModel.map((entry) => `${entry.model}：${formatNumber(entry.totalTokens)}`)
    )
  }
  if (settings.pricePerMillionInput === null && settings.pricePerMillionOutput === null) {
    lines.push('想看金额就在设置里填单价')
  } else if (settings.pricePerMillionInput === null || settings.pricePerMillionOutput === null) {
    lines.push('金额只算了你填过的那一半单价')
  }
  return lines.join('\n')
}
```

`settings` 从 `useApp()` 取（该组件若还没取就照同文件既有写法加上）。`cost` 用 `formatCost(detail.usage, …)` 算，`detail.usage` 为 null 时不算。

- [ ] **Step 3: 验证**

```bash
pnpm typecheck
pnpm lint
```

---

### Task 7: 导出

**Files:**
- Modify: `src/main/exporters/reportModel.ts`、`src/main/exporters/markdown.ts`、`src/main/exporters/html.ts`、`src/main/exporters/json.ts`
- Test: `tests/exporters/` 下补一例

**Interfaces:**
- Consumes: `SessionSummary.usage`。
- Produces: 三种导出里都有用量。JSON 导出**要动**：它不是整份序列化会话，而是逐个字段列出来的，不显式加 `usage` 就会被静悄悄丢掉。

- [ ] **Step 1: 报告模型**

`reportModel.ts` 的 `ReportModel` 上，`counts` 块后面加两个字段——结构化的一份给 JSON，预格式化好的一句给两个格式化器，免得它们各自判断一遍：

```ts
  usage: UsageSummary | null
  /** 用量的一行人话。日志没记时是"未记录用量"，两个格式化器直接照抄，不必各自判断。 */
  usageLine: string
```

```ts
function usageLine(usage: UsageSummary | null): string {
  if (!usage) return '日志未记录用量'
  const parts = [`${usage.totalTokens} token`]
  if (usage.inputTokens + usage.outputTokens > 0) {
    parts.push(`输入 ${usage.inputTokens} / 输出 ${usage.outputTokens}`)
  }
  if (usage.cachedInputTokens !== null) parts.push(`命中缓存 ${usage.cachedInputTokens}`)
  parts.push(usage.basis === 'cumulative' ? '按累计值取末条' : '按每轮增量求和')
  return parts.join('，')
}
```

数字保持原样、不走 `toLocaleString()`——这一节的其他数字都是原样输出，混着来更难读。

导出里**不写金额**：单价是本机设置，跟着产物走出去只会让读的人以为那是官方价。

- [ ] **Step 2: 三个格式化器**

`markdown.ts` 的「二、总体情况」那张表，错误记录一行后面加一行：

```ts
  lines.push(`| 用量 | ${escapeCell(report.usageLine)} |`)
```

`html.ts` 的卡片行**不加卡片**：卡片里的数字是 22px，一句三十来字的话塞进 `flex: 1 1 132px` 会把版面撑破。改成卡片行下面单独一行，顺带也不必把数组元素的 `v` 从 `number` 放宽成 `string | number`：

```css
/* 用量是一句话而不是一个数字，塞进 22px 的卡片里会撑破版面，所以单独一行。 */
.usage { margin: 2px 0 8px; font-size: 13px; color: var(--ink-soft); }
```

```ts
        .join('')}</div>
<p class="usage">用量：${escapeHtml(report.usageLine)}</p>`
```

`json.ts` 的 `StandardExport` 与 `buildStandardExport` 里，`counts` 后面加结构化的那一份，并把 `EXPORT_SCHEMA_VERSION` 从 `'1.0'` 抬到 `'1.1'`——只往上加字段，照着 1.0 写的工具读 1.1 不会坏：

```ts
  /** 会话用量。null = 日志里没记，不是 0。 */
  usage: ReportModel['usage']
```

- [ ] **Step 3: 补测试**

在 `tests/exporters/` 里加：

```ts
  it('导出里带上用量，没有用量时照实写"未记录"', async () => {
    // 有用量的 fixture → 表里出现 9760；没有用量的 → 出现"日志未记录用量"
  })
```

具体写法照该目录下现有测试的风格。顺带把那条断言 `schemaVersion` 的测试从 `'1.0'` 改成 `'1.1'`，并给报告里"不写金额"也留一条断言——这是个容易在后续改动里被顺手破掉的约定。

- [ ] **Step 4: 验证**

```bash
pnpm vitest run tests/exporters
```

---

### Task 8: 收口

- [ ] **Step 1: 全量校验**

```bash
pnpm verify
```

typecheck + lint + test 三样全绿。有测试因为手写 `SessionSummary` 缺 `usage` 而报错，就地补 `usage: null`。

- [ ] **Step 2: 对着验收条件过一遍**

spec 第七节 A2 行：**两种数列形状都算对，缺失时显示"未记录"**。

- [ ] 累计序列（fixture 的 4390 → 5100 → 9760）得出 9760。
- [ ] 增量序列（造的下降序列）得出各项之和。
- [ ] `usage === null` 时界面显示"日志未记录用量"，且界面上任何位置都不出现 0。
- [ ] 各模型之和恒等于 `totalTokens`。
- [ ] 旧索引（已有 `agent`、没有 `usage`）读出来是 `usage: null`，不是 `undefined`。

- [ ] **Step 3: 落地**

一个提交，主题写 `feat(parsers): aggregate token usage per session`，正文中文，说明"数列形状而非字段名"这条判据和 9760 那个陷阱。然后按 A1 那次的路子走 PR + 三平台必需检查 + 快进推送。
