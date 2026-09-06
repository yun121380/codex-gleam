import { describe, expect, it } from 'vitest'
import { PRODUCTION_CSP, TLS_UNTRUSTED_VERDICT } from '../../src/main/securityPolicy'
import { buildSelfCheckReport, type SelfCheckInput } from '../../src/main/selfCheck/report'

/**
 * 报告组装是纯函数，所以「报告长什么样」不需要 mock ipcMain 就能问 ——
 * 和 `reportModel.ts` 同一个路子。
 *
 * 这里 import 的是 `securityPolicy.ts` 而不是 `security.ts`：后者 import electron，
 * 引它会让这个文件在跑测试时去下载 Electron 二进制（实测 import 阶段多花 5.6 秒）。
 * 一个以「完全离线」为主张的仓库，测试跑一半去联网下东西，本身就该修。
 */

function makeInput(overrides: Partial<SelfCheckInput> = {}): SelfCheckInput {
  return {
    monitor: {
      appBlocked: 0,
      probeBlocked: 0,
      recent: [],
      recentTruncated: false,
      cspApplied: 0,
      tlsCalls: 0
    },
    build: null,
    dependencies: null,
    evidenceIssues: [],
    isDev: false,
    probeArm: null,
    ...overrides
  }
}

describe('自检报告组装', () => {
  it('开发模式下 CSP 响应头是 null —— 页面不许比护栏更乐观', () => {
    const report = buildSelfCheckReport(makeInput({ isDev: true }))

    expect(report.mode).toBe('dev')
    // 那道头被 `if (!options.isDev)` 挡着，开发模式下根本没装。
    // 这里填常量就是拿「打算加什么」冒充「当前生效」——一个自检页只要在
    // 任何一处比它检查的东西乐观，它报的所有数就都不值钱了。
    expect(report.csp.responseHeader).toBeNull()
  })

  it('生产模式下报的是那个导出的常量本身', () => {
    const report = buildSelfCheckReport(makeInput({ isDev: false }))

    expect(report.mode).toBe('packaged')
    // 断言用 import 进来的常量而不是抄一遍字符串：抄一遍就又造了一处会过期的副本，
    // 而这一期修掉的那句错注释正是这么烂掉的。
    expect(report.csp.responseHeader).toBe(PRODUCTION_CSP)
  })

  it('CSP 的「打算加什么」和「真加过几次」分别报', () => {
    const report = buildSelfCheckReport(
      makeInput({ monitor: { ...makeInput().monitor, cspApplied: 7 } })
    )

    expect(report.csp.responseHeader).toBe(PRODUCTION_CSP)
    expect(report.csp.appliedCount).toBe(7)
  })

  it('两栏计数原样传出去，没有谁顺手把它们加起来', () => {
    const report = buildSelfCheckReport(
      makeInput({
        monitor: {
          appBlocked: 0,
          probeBlocked: 2,
          recent: [{ url: 'http://example.invalid/x', at: 'now', origin: 'probe' }],
          recentTruncated: true,
          cspApplied: 0,
          tlsCalls: 0
        }
      })
    )

    // 加起来就等于把「应为 0」那个指标弄脏 —— 指标一脏就再也没人看它。
    expect(report.intercept.appBlocked).toBe(0)
    expect(report.intercept.probeBlocked).toBe(2)
    expect(report.intercept.recentTruncated).toBe(true)
    expect(report.intercept.recent).toHaveLength(1)
  })

  it('TLS 那一格抄常量，calls 为 0 是预期而不是没接上线', () => {
    const report = buildSelfCheckReport(makeInput())

    expect(report.tls).toEqual({ installed: true, verdict: TLS_UNTRUSTED_VERDICT, calls: 0 })
  })

  it('构建期证据缺失时报告仍然成立，issues 原样带出', () => {
    const issues = ['构建期校验证据读不到（ENOENT）。', '依赖树证据格式坏了，解析不了：x']
    const report = buildSelfCheckReport(makeInput({ evidenceIssues: issues }))

    expect(report.build).toBeNull()
    expect(report.dependencies).toBeNull()
    expect(report.evidenceIssues).toEqual(issues)
    // 证据没读到不影响拦截、CSP、TLS 那三项 —— 它们来自这次运行的真实对象。
    expect(report.tls.installed).toBe(true)
  })

  it('probeArm 不传时是 null，传了就原样在报告里', () => {
    expect(buildSelfCheckReport(makeInput()).probeArm).toBeNull()

    const arm = { ok: true, url: 'http://example.invalid/probe.png', reason: null }
    expect(buildSelfCheckReport(makeInput({ probeArm: arm })).probeArm).toEqual(arm)
  })

  it('构建期证据拿到时原样进报告', () => {
    const build = {
      schemaVersion: 1,
      gitSha: 'a'.repeat(40),
      testCount: 795,
      platform: 'win32',
      builtAt: '2026-09-06T00:00:00.000Z'
    }
    const dependencies = {
      generatedAt: '2026-09-06T00:00:01.000Z',
      packageCount: 3,
      packages: [{ name: 'react', version: '19.0.0' }],
      packagesTruncated: true
    }

    const report = buildSelfCheckReport(makeInput({ build, dependencies }))
    expect(report.build).toEqual(build)
    expect(report.dependencies).toEqual(dependencies)
  })
})
