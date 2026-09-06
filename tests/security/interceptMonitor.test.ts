import { describe, expect, it } from 'vitest'
import { createSecurityMonitor } from '../../src/main/selfCheck/monitor'
import { SELF_CHECK_MAX_BLOCKED, SELF_CHECK_PROBE_WINDOW_MS } from '../../src/shared/constants'

/**
 * 归因规则是 B3 最容易写错的地方，所以监视器被做成了不 import electron 的纯模块 ——
 * 它必须能脱离 Electron 被拷问。这一组测试就是那场拷问。
 */

const PROBE_URL = 'http://example.invalid/probe.png'
const OTHER_URL = 'http://other.invalid/thing.png'

/** 真实判据的最小复刻：本地协议放行，其余一概拦。与 `security.ts:16` 那份名单同义。 */
function isAllowed(url: string): boolean {
  try {
    return ['file:', 'data:', 'blob:', 'about:', 'devtools:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/** 可拨动的假时钟。注入它，清单里的时间戳才是可断言的。 */
function fakeClock(startMs = Date.parse('2026-09-06T00:00:00.000Z')) {
  let ms = startMs
  return {
    now: (): string => new Date(ms).toISOString(),
    advance: (delta: number): void => {
      ms += delta
    }
  }
}

function makeMonitor(clock = fakeClock()) {
  return { monitor: createSecurityMonitor({ isAllowed, now: clock.now }), clock }
}

describe('拦截监视器 · 两栏计数分开', () => {
  it('授权过的地址记在 probe 栏，「应为 0」那一栏不动', () => {
    const { monitor } = makeMonitor()
    expect(monitor.armProbe(PROBE_URL).ok).toBe(true)
    monitor.noteBlocked(PROBE_URL)

    const snapshot = monitor.snapshot()
    expect(snapshot.probeBlocked).toBe(1)
    expect(snapshot.appBlocked).toBe(0)
    expect(snapshot.recent).toEqual([
      { url: PROBE_URL, at: '2026-09-06T00:00:00.000Z', origin: 'probe' }
    ])
  })

  it('一次授权只兑一次 —— 同一个地址第二次被拦就算应用自己发的', () => {
    const { monitor } = makeMonitor()
    monitor.armProbe(PROBE_URL)
    monitor.noteBlocked(PROBE_URL)
    monitor.noteBlocked(PROBE_URL)

    const snapshot = monitor.snapshot()
    // 没有这一条，用户填一次地址就等于给同一个地址办了张永久通行证，
    // 「应为 0」那个指标从此永久地脏。
    expect(snapshot.probeBlocked).toBe(1)
    expect(snapshot.appBlocked).toBe(1)
  })

  it('别的地址蹭不到授权，而且蹭不掉它', () => {
    const { monitor } = makeMonitor()
    monitor.armProbe(PROBE_URL)
    monitor.noteBlocked(OTHER_URL)

    expect(monitor.snapshot()).toMatchObject({ appBlocked: 1, probeBlocked: 0 })

    // 授权还在：被别的地址撞一下不该把它作废。
    monitor.noteBlocked(PROBE_URL)
    expect(monitor.snapshot()).toMatchObject({ appBlocked: 1, probeBlocked: 1 })
  })

  it('授权过期之后，同一个地址算应用自己发的', () => {
    const { monitor, clock } = makeMonitor()
    monitor.armProbe(PROBE_URL)
    clock.advance(SELF_CHECK_PROBE_WINDOW_MS + 1)
    monitor.noteBlocked(PROBE_URL)

    // 窗口不是优化：CSP 可能在渲染进程就挡掉那次加载，请求压根走不到
    // `onBeforeRequest`，授权于是悬着 —— 没有窗口它就会等着被下一个同址请求错认。
    expect(monitor.snapshot()).toMatchObject({ appBlocked: 1, probeBlocked: 0 })
  })

  it('窗口边界之内仍然算 probe', () => {
    const { monitor, clock } = makeMonitor()
    monitor.armProbe(PROBE_URL)
    clock.advance(SELF_CHECK_PROBE_WINDOW_MS)
    monitor.noteBlocked(PROBE_URL)

    expect(monitor.snapshot()).toMatchObject({ appBlocked: 0, probeBlocked: 1 })
  })
})

describe('拦截监视器 · 授权校验', () => {
  it('空地址不受理', () => {
    const { monitor } = makeMonitor()
    for (const bad of ['', '   ']) {
      const result = monitor.armProbe(bad)
      expect(result.ok).toBe(false)
      expect(result.url).toBeNull()
      expect(result.reason).toBeTruthy()
    }
  })

  it('不是完整地址的不受理', () => {
    const { monitor } = makeMonitor()
    const result = monitor.armProbe('example.invalid/no-protocol')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('协议')
  })

  it('太长的地址不受理', () => {
    const { monitor } = makeMonitor()
    const result = monitor.armProbe(`http://example.invalid/${'a'.repeat(4000)}`)
    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('本来就不拦的协议不受理，因为它演示不了任何拦截', () => {
    const { monitor } = makeMonitor()
    // 校验用的必须是拦截时的那一条判据（注入的 `isAllowed`），
    // 于是「能不能演示拦截」和「会不会真被拦」永远不会说两套话。
    for (const local of ['file:///etc/passwd', 'data:image/png;base64,AAAA']) {
      const result = monitor.armProbe(local)
      expect(result.ok).toBe(false)
      expect(result.reason).toBeTruthy()
    }
  })

  it('受理成功时原样带回地址，且不受理时一律不产生计数', () => {
    const { monitor } = makeMonitor()
    monitor.armProbe('file:///etc/passwd')
    monitor.armProbe('')
    expect(monitor.snapshot()).toMatchObject({ appBlocked: 0, probeBlocked: 0, recent: [] })

    expect(monitor.armProbe(`  ${PROBE_URL}  `)).toEqual({
      ok: true,
      url: PROBE_URL,
      reason: null
    })
  })

  it('拒绝的原因里不出现带斜杠的示例地址', () => {
    const { monitor } = makeMonitor()
    // 源码里不出现任何外部地址是这一期的硬约束（安全测试扫整个 src/），
    // 提示文案也算源码 —— 写成「要带协议，比如 http 或 https」而不是贴一个 `https://…`。
    const reasons = [monitor.armProbe('nope').reason, monitor.armProbe('file:///tmp/x').reason]
    for (const reason of reasons) {
      expect(reason).not.toMatch(/\/\//)
    }
  })
})

describe('拦截监视器 · 清单与快照', () => {
  it('清单撞上限时丢最旧的，计数照旧是真实值', () => {
    const { monitor } = makeMonitor()
    const overflow = 5
    for (let i = 0; i < SELF_CHECK_MAX_BLOCKED + overflow; i += 1) {
      monitor.noteBlocked(`http://example.invalid/${i}`)
    }

    const snapshot = monitor.snapshot()
    expect(snapshot.recent).toHaveLength(SELF_CHECK_MAX_BLOCKED)
    expect(snapshot.recentTruncated).toBe(true)
    // 计数不受清单上限影响 —— 清单是样本，计数是精确的。
    expect(snapshot.appBlocked).toBe(SELF_CHECK_MAX_BLOCKED + overflow)
    // 留新丢旧：第一条已经是被挤掉之后的那条。
    expect(snapshot.recent[0]?.url).toBe(`http://example.invalid/${overflow}`)
    expect(snapshot.recent.at(-1)?.url).toBe(
      `http://example.invalid/${SELF_CHECK_MAX_BLOCKED + overflow - 1}`
    )
  })

  it('没撞上限时不谎报截断', () => {
    const { monitor } = makeMonitor()
    monitor.noteBlocked(OTHER_URL)
    expect(monitor.snapshot().recentTruncated).toBe(false)
  })

  it('快照是拷贝，改它不影响下一次快照', () => {
    const { monitor } = makeMonitor()
    monitor.noteBlocked(OTHER_URL)

    const first = monitor.snapshot()
    first.recent.push({ url: 'http://injected.invalid/', at: 'x', origin: 'probe' })
    first.recent[0]!.url = '篡改了'

    // 这份东西要过 IPC 序列化，把内部数组本身漏出去迟早会被谁改一手。
    expect(monitor.snapshot().recent).toEqual([
      { url: OTHER_URL, at: '2026-09-06T00:00:00.000Z', origin: 'app' }
    ])
  })

  it('CSP 与 TLS 各自只是计数，初值都是 0', () => {
    const { monitor } = makeMonitor()
    expect(monitor.snapshot()).toMatchObject({ cspApplied: 0, tlsCalls: 0 })

    monitor.noteCspHeader()
    monitor.noteCspHeader()
    monitor.noteTlsCheck()

    expect(monitor.snapshot()).toMatchObject({ cspApplied: 2, tlsCalls: 1 })
  })
})
