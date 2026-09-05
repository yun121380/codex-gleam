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
 * last_token_usage 是本轮，有的版本反过来），所以这个名单只用来"找到数字在哪"，
 * 绝不用来判断它是累计还是增量 —— 那件事交给数列形状。也正因为形状规则会自己
 * 纠错，这个优先级挑中哪一组，最终答案都一样。
 */
const GROUP_KEYS: readonly string[] = [
  'total_token_usage',
  'token_usage',
  'last_token_usage',
  'usage',
  'tokens'
]

/** 用量子对象可能藏在记录的哪一层下面。Codex 的 token_count 把它放在 info 里。 */
const CONTAINER_KEYS: readonly string[] = ['info', 'usage', 'stats', 'metrics']

const INPUT_KEYS: readonly string[] = ['input_tokens', 'prompt_tokens', 'input', 'prompt']
const OUTPUT_KEYS: readonly string[] = ['output_tokens', 'completion_tokens', 'output', 'completion']
const CACHED_KEYS: readonly string[] = [
  'cached_input_tokens',
  'cache_read_input_tokens',
  'cached_tokens',
  'cache_read'
]
const TOTAL_KEYS: readonly string[] = ['total_tokens', 'total']
const MODEL_KEYS: readonly string[] = ['model', 'model_name', 'engine']
const WINDOW_KEYS: readonly string[] = [
  'model_context_window',
  'context_window',
  'max_context_window'
]

interface Numbers {
  input: number | null
  output: number | null
  cached: number | null
  /** 一定是个非负数：解不出总数的记录不会变成样本。 */
  total: number
}

interface Sample extends Numbers {
  /** 这条用量记录生效时的模型名。null = 日志到这里还没写过模型名。 */
  model: string | null
}

/** 非负有限数才算数字，其余（含负数）当没写。token 数不可能是负的。 */
function count(value: unknown): number | null {
  const parsed = asNumber(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

/**
 * 从一个"看起来装着用量"的对象里取出一组数字。
 *
 * 没有 total_tokens 时用输入加输出补；三个数字全缺就返回 null —— 当这条记录不
 * 存在，而不是当成一份 0。谎报比不报更糟。
 */
function readNumbers(group: Record<string, unknown>): Numbers | null {
  const input = count(firstDefined(group, INPUT_KEYS))
  const output = count(firstDefined(group, OUTPUT_KEYS))
  const cached = count(firstDefined(group, CACHED_KEYS))
  const explicit = count(firstDefined(group, TOTAL_KEYS))

  const total =
    explicit ?? (input === null && output === null ? null : (input ?? 0) + (output ?? 0))
  if (total === null) return null

  return { input, output, cached, total }
}

/** 在记录本身与它的一层子容器里找用量数字，找到第一组能用的就停。 */
function findNumbers(record: Record<string, unknown>): Numbers | null {
  const containers: Array<Record<string, unknown>> = [record]
  for (const key of CONTAINER_KEYS) {
    const nested = record[key]
    if (isRecord(nested)) containers.push(nested)
  }

  for (const container of containers) {
    for (const key of GROUP_KEYS) {
      const group = container[key]
      if (isRecord(group)) {
        const numbers = readNumbers(group)
        if (numbers) return numbers
      }
    }
  }

  // 没有子对象，数字直接摊在记录上：{ type: 'usage', input_tokens: 10, … }
  for (const container of containers) {
    const numbers = readNumbers(container)
    if (numbers) return numbers
  }

  return null
}

/**
 * spec 3.1 的判据，逐字：
 *
 *   整条序列单调不减 ⇒ 累计值，取最后一条。
 *   出现下降 ⇒ 增量值，求和。
 *
 * 不看字段名。这条规则自带纠错：猜错字段语义会算错，看数列形状不会。
 * 序列中途归零（换模型、上下文压缩）会落进增量分支并求和，这正是想要的结果。
 * 只有一条样本时序列平凡地单调不减，判为累计 —— 两种规则算出来是同一个数。
 */
function detectBasis(totals: readonly number[]): UsageBasis {
  let previous: number | null = null
  for (const total of totals) {
    if (previous !== null && total < previous) return 'delta'
    previous = total
  }
  return 'cumulative'
}

/**
 * 把一个字段从整条序列收敛成一个数。累计取最后一个有值的样本，增量把有值的加
 * 起来；全都没值就是 null（缓存字段靠这个跟"记了 0"区分开）。
 *
 * basis 由总数序列判定一次、然后应用到每一个字段：如果各字段各判一次，就会出现
 * 输入按累计取、输出按增量求和，各部分之和跟总数打架。
 */
function reduceField(
  samples: readonly Sample[],
  basis: UsageBasis,
  pick: (sample: Sample) => number | null
): number | null {
  if (basis === 'cumulative') {
    let last: number | null = null
    for (const sample of samples) {
      const value = pick(sample)
      if (value !== null) last = value
    }
    return last
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
 * 累计口径下不能直接把每条样本的总数记到它的模型名上 —— 那就是把累计值当增量
 * 求和，正是本模块要防的那个错。改成把"相邻两条样本之差"记到后一条样本的模型
 * 上：第一条样本全额计入它自己的模型，之后每条只计入它比上一条多出来的部分。
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
    .sort(
      (left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model)
    )
}

/**
 * 逐条喂记录，最后给出一份会话级用量。
 *
 * 由 normalizeRecords 自己持有：调用方只想要结果，不该关心它是怎么攒出来的。
 */
export class UsageCollector {
  private readonly samples: Sample[] = []
  private model: string | null = null
  private window: number | null = null

  /**
   * 喂一条（已剥壳的）记录。
   *
   * 整个方法体包在 try 里：用量是附加信息，任何一条畸形记录都不许让解析失败。
   * 出错就当这条记录没有用量，继续往下走 —— 已经收到的样本仍然有效。
   */
  note(record: unknown): void {
    try {
      if (!isRecord(record)) return

      // 模型名单独跟：它写在 turn_context 里，跟用量数字不在同一条记录上。
      const model = firstString(record, MODEL_KEYS)
      if (model !== null && model.trim() !== '') this.model = model.trim()

      const window = count(firstDefined(record, WINDOW_KEYS))
      if (window !== null && window > 0) this.window = window

      const numbers = findNumbers(record)
      if (numbers) this.samples.push({ ...numbers, model: this.model })
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
      // 输入 / 输出按 spec 是不可空的 number：日志只记了总数时它们是 0，
      // 显示侧要用 inputTokens + outputTokens > 0 判断"拆分可用"，别直接印 0。
      inputTokens: reduceField(this.samples, basis, (sample) => sample.input) ?? 0,
      outputTokens: reduceField(this.samples, basis, (sample) => sample.output) ?? 0,
      cachedInputTokens: reduceField(this.samples, basis, (sample) => sample.cached),
      totalTokens: reduceField(this.samples, basis, (sample) => sample.total) ?? 0,
      basis,
      byModel: splitByModel(this.samples, basis),
      contextWindow: this.window
    }
  }
}
