import type { TestFailureDetail, TestSummary } from '@shared/types'

/**
 * 从命令输出里识别测试结果。
 *
 * 会话日志不会贴心地告诉你"这是测试结果"，所以只能按各测试框架的输出格式去认。
 * 认不出来就返回 null —— 那这条记录就还是普通的命令输出，不会被伪造成测试结果。
 */

const TEST_COMMAND_PATTERN =
  /\b(vitest|jest|pytest|mocha|jasmine|ava|karma|phpunit|rspec|minitest|tox|nose2?|unittest|cargo\s+test|go\s+test|dotnet\s+test|gradle(w)?\s+test|mvn\s+test|ctest|bun\s+test|deno\s+test)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\btest:(unit|watch|run|ci)\b/i

export function isTestCommand(command: string | null | undefined): boolean {
  if (!command) return false
  return TEST_COMMAND_PATTERN.test(command)
}

export function detectFramework(text: string): string | undefined {
  const table: Array<[RegExp, string]> = [
    [/\bvitest\b/i, 'Vitest'],
    // Vitest 独有的汇总行，没提到框架名时也能认出来。
    [/^\s*Test Files\s+\d/m, 'Vitest'],
    [/\bjest\b/i, 'Jest'],
    [/\bpytest\b/i, 'pytest'],
    // pytest 的等号包裹汇总行，例如 "==== 2 passed, 1 failed in 0.31s ===="
    [/=+[^=\n]*\b\d+\s+(?:passed|failed)\b[^=\n]*\bin\s+[\d.]+\s*s[^=\n]*=+/i, 'pytest'],
    [/\bmocha\b/i, 'Mocha'],
    [/cargo\s+test|test result:/i, 'Cargo'],
    [/go\s+test|^ok\s+\S+\s+\d/im, 'Go test'],
    [/\bphpunit\b/i, 'PHPUnit'],
    [/\brspec\b/i, 'RSpec'],
    [/dotnet\s+test/i, 'dotnet test']
  ]
  for (const [pattern, name] of table) {
    if (pattern.test(text)) return name
  }
  return undefined
}

function toInt(value: string | undefined): number {
  if (!value) return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function durationFrom(text: string): number | undefined {
  // 先找带标签的总耗时（Duration / in / took / Time:），它比行内的 "24ms" 更可信。
  const seconds = /(?:\bin|took|Time:|Duration)\s+([\d.]+)\s*s(?:ec(?:onds)?)?\b/i.exec(text)
  if (seconds?.[1]) return Math.round(Number.parseFloat(seconds[1]) * 1000)
  const labelledMillis = /(?:\bin|took|Time:|Duration)\s+([\d.]+)\s*ms\b/i.exec(text)
  if (labelledMillis?.[1]) return Math.round(Number.parseFloat(labelledMillis[1]))
  const millis = /([\d.]+)\s*ms\b/i.exec(text)
  if (millis?.[1]) return Math.round(Number.parseFloat(millis[1]))
  return undefined
}

/** 抽取失败用例名称。尽量抓到有用的名字，抓不到就留空。 */
export function extractFailureNames(text: string): TestFailureDetail[] {
  const failures: TestFailureDetail[] = []
  const seen = new Set<string>()

  const patterns: RegExp[] = [
    /^\s*(?:[✕✗×])\s+(.+?)(?:\s+\d+ms)?$/gm,
    /^\s*●\s+(.+?)$/gm,
    /^\s*---\s+FAIL:\s+(.+?)(?:\s+\([\d.]+s\))?$/gm,
    /^\s*FAILED\s+(.+?)(?:\s+-\s+(.*))?$/gm,
    /^\s*FAIL\s+(\S+\.(?:test|spec)\.[a-z]+)(?:\s+>\s+(.*))?$/gim,
    /^\s*\d+\)\s+(.+?)$/gm
  ]

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const name = (match[1] ?? '').trim()
      if (name === '' || name.length > 200) continue
      if (seen.has(name)) continue
      seen.add(name)
      const detail: TestFailureDetail = { name }
      const message = (match[2] ?? '').trim()
      if (message !== '') detail.message = message
      failures.push(detail)
      if (failures.length >= 50) return failures
    }
  }

  return failures
}

interface Counts {
  passed: number
  failed: number
  skipped: number
  total?: number
}

function matchCounts(text: string): Counts | null {
  // Vitest: "Tests  1 failed | 11 passed (12)"  /  "Tests  11 passed (11)"
  const vitest = /^\s*Tests\s+(.+?)\s*(?:\((\d+)\))?\s*$/m.exec(text)
  if (vitest?.[1] && /passed|failed|skipped/i.test(vitest[1])) {
    const segment = vitest[1]
    const counts: Counts = {
      passed: toInt(/(\d+)\s+passed/i.exec(segment)?.[1]),
      failed: toInt(/(\d+)\s+failed/i.exec(segment)?.[1]),
      skipped:
        toInt(/(\d+)\s+skipped/i.exec(segment)?.[1]) + toInt(/(\d+)\s+todo/i.exec(segment)?.[1])
    }
    const total = toInt(vitest[2])
    if (total > 0) counts.total = total
    return counts
  }

  // Jest: "Tests:       1 failed, 2 passed, 3 total"
  const jest = /^\s*Tests:\s+(.+)$/m.exec(text)
  if (jest?.[1]) {
    const segment = jest[1]
    const counts: Counts = {
      passed: toInt(/(\d+)\s+passed/i.exec(segment)?.[1]),
      failed: toInt(/(\d+)\s+failed/i.exec(segment)?.[1]),
      skipped:
        toInt(/(\d+)\s+skipped/i.exec(segment)?.[1]) + toInt(/(\d+)\s+todo/i.exec(segment)?.[1])
    }
    const total = toInt(/(\d+)\s+total/i.exec(segment)?.[1])
    if (total > 0) counts.total = total
    return counts
  }

  // Cargo: "test result: FAILED. 2 passed; 1 failed; 3 ignored"
  const cargo = /test result:\s*(?:ok|FAILED)\.?\s*(.+)/i.exec(text)
  if (cargo?.[1]) {
    const segment = cargo[1]
    return {
      passed: toInt(/(\d+)\s+passed/i.exec(segment)?.[1]),
      failed: toInt(/(\d+)\s+failed/i.exec(segment)?.[1]),
      skipped: toInt(/(\d+)\s+ignored/i.exec(segment)?.[1])
    }
  }

  // pytest: "==== 2 passed, 1 failed, 1 skipped in 0.31s ===="
  const pytest = /=+\s*(?:[^=]*?\b\d+\s+(?:passed|failed|error|skipped)[^=]*?)\s*=+/i.exec(text)
  if (pytest?.[0]) {
    const segment = pytest[0]
    return {
      passed: toInt(/(\d+)\s+passed/i.exec(segment)?.[1]),
      failed:
        toInt(/(\d+)\s+failed/i.exec(segment)?.[1]) + toInt(/(\d+)\s+errors?\b/i.exec(segment)?.[1]),
      skipped:
        toInt(/(\d+)\s+skipped/i.exec(segment)?.[1]) + toInt(/(\d+)\s+deselected/i.exec(segment)?.[1])
    }
  }

  // Mocha: "2 passing" / "1 failing" / "1 pending"
  if (/\d+\s+(passing|failing|pending)\b/i.test(text)) {
    return {
      passed: toInt(/(\d+)\s+passing/i.exec(text)?.[1]),
      failed: toInt(/(\d+)\s+failing/i.exec(text)?.[1]),
      skipped: toInt(/(\d+)\s+pending/i.exec(text)?.[1])
    }
  }

  // Go test：数 --- PASS / --- FAIL / --- SKIP。
  const goPass = text.match(/^\s*---\s+PASS:/gm)?.length ?? 0
  const goFail = text.match(/^\s*---\s+FAIL:/gm)?.length ?? 0
  const goSkip = text.match(/^\s*---\s+SKIP:/gm)?.length ?? 0
  if (goPass + goFail + goSkip > 0) {
    return { passed: goPass, failed: goFail, skipped: goSkip }
  }

  return null
}

/**
 * 解析测试输出。无法识别为测试结果时返回 null。
 */
export function parseTestOutput(text: string): TestSummary | null {
  if (typeof text !== 'string' || text.trim() === '') return null

  const counts = matchCounts(text)
  if (!counts) {
    // 最后的兜底：只有裸的 "FAIL" / "ok ... " 之类整体结论。
    if (/^\s*FAIL\s*$/m.test(text)) {
      return { passed: 0, failed: 1, skipped: 0, failures: extractFailureNames(text) }
    }
    return null
  }

  if (counts.passed === 0 && counts.failed === 0 && counts.skipped === 0) return null

  const summary: TestSummary = {
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    failures: counts.failed > 0 ? extractFailureNames(text) : []
  }

  const framework = detectFramework(text)
  if (framework) summary.framework = framework

  const total = counts.total ?? counts.passed + counts.failed + counts.skipped
  if (total > 0) summary.total = total

  const duration = durationFrom(text)
  if (duration !== undefined) summary.durationMs = duration

  return summary
}
