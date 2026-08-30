import { describe, expect, it } from 'vitest'
import { isTestCommand, parseTestOutput } from '../../src/main/parsers/testOutput'

describe('测试命令识别', () => {
  it('认得常见的测试命令', () => {
    const commands = [
      'npm test',
      'npm run test',
      'pnpm test',
      'yarn test',
      'npx vitest run',
      'vitest run tests/cart',
      'jest --coverage',
      'pytest -q',
      'cargo test',
      'go test ./...',
      'dotnet test',
      'mvn test',
      'bun test'
    ]

    for (const command of commands) {
      expect(isTestCommand(command), command).toBe(true)
    }
  })

  it('不会把普通命令当成测试', () => {
    const commands = ['npm run build', 'git status', 'ls -la', 'npm run lint', 'cat package.json']

    for (const command of commands) {
      expect(isTestCommand(command), command).toBe(false)
    }
  })

  it('空值安全', () => {
    expect(isTestCommand(null)).toBe(false)
    expect(isTestCommand(undefined)).toBe(false)
    expect(isTestCommand('')).toBe(false)
  })
})

describe('测试输出解析', () => {
  it('Vitest：有失败', () => {
    const output = [
      ' ❯ tests/cart/checkout.test.ts (3 tests | 1 failed) 24ms',
      '   ✕ 结账时应保留两位小数',
      '     → expected 179.99999999999997 to be 180',
      '',
      ' Test Files  1 failed | 1 passed (2)',
      '      Tests  1 failed | 7 passed (8)',
      '   Duration  1.24s'
    ].join('\n')

    const summary = parseTestOutput(output)

    expect(summary).toMatchObject({ passed: 7, failed: 1, skipped: 0, total: 8, framework: 'Vitest' })
    expect(summary?.failures.map((failure) => failure.name)).toContain('结账时应保留两位小数')
    expect(summary?.durationMs).toBe(1240)
  })

  it('Vitest：全部通过', () => {
    const summary = parseTestOutput(' Test Files  2 passed (2)\n      Tests  8 passed (8)\n')

    expect(summary).toMatchObject({ passed: 8, failed: 0, skipped: 0, total: 8 })
    expect(summary?.failures).toEqual([])
  })

  it('Vitest：含跳过的用例', () => {
    const summary = parseTestOutput('      Tests  12 passed | 1 skipped (13)\n')
    expect(summary).toMatchObject({ passed: 12, failed: 0, skipped: 1, total: 13 })
  })

  it('Jest 格式', () => {
    const summary = parseTestOutput(
      'Tests:       1 failed, 2 skipped, 9 passed, 12 total\nTime:        3.2 s\n'
    )

    expect(summary).toMatchObject({ passed: 9, failed: 1, skipped: 2, total: 12 })
  })

  it('pytest 格式', () => {
    const summary = parseTestOutput('==================== 2 passed, 1 failed, 3 skipped in 0.31s ====')

    expect(summary).toMatchObject({ passed: 2, failed: 1, skipped: 3, framework: 'pytest' })
  })

  it('Cargo 格式', () => {
    const summary = parseTestOutput('test result: FAILED. 2 passed; 1 failed; 3 ignored; 0 measured')

    expect(summary).toMatchObject({ passed: 2, failed: 1, skipped: 3 })
  })

  it('Mocha 格式', () => {
    const summary = parseTestOutput('  7 passing (120ms)\n  1 failing\n  2 pending\n')

    expect(summary).toMatchObject({ passed: 7, failed: 1, skipped: 2 })
  })

  it('Go test 格式：按 PASS/FAIL 行计数并抓出失败用例名', () => {
    const output = [
      '--- PASS: TestAdd (0.00s)',
      '--- FAIL: TestSubtract (0.01s)',
      '--- SKIP: TestSlow (0.00s)',
      'FAIL'
    ].join('\n')

    const summary = parseTestOutput(output)

    expect(summary).toMatchObject({ passed: 1, failed: 1, skipped: 1 })
    expect(summary?.failures.map((failure) => failure.name)).toContain('TestSubtract')
  })

  it('不是测试输出时返回 null，不伪造结果', () => {
    expect(parseTestOutput('')).toBeNull()
    expect(parseTestOutput('Hello world')).toBeNull()
    expect(parseTestOutput('> demo@1.0.0 build\n> vite build\n✓ built in 12.31s')).toBeNull()
    expect(parseTestOutput('✖ 1 problem (1 error, 0 warnings)')).toBeNull()
  })

  it('只有裸 FAIL 结论时按一次失败处理', () => {
    expect(parseTestOutput('running suite\nFAIL\n')).toMatchObject({ passed: 0, failed: 1 })
  })

  it('输出里带 ANSI 颜色码也能解析', () => {
    const colored = ' [31m✕ 某个用例[39m\n Tests  1 failed | 3 passed (4)\n'
    expect(parseTestOutput(colored)).toMatchObject({ passed: 3, failed: 1, total: 4 })
  })
})
