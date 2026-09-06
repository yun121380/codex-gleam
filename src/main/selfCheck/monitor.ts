import {
  SELF_CHECK_MAX_BLOCKED,
  SELF_CHECK_MAX_URL_LENGTH,
  SELF_CHECK_PROBE_WINDOW_MS
} from '@shared/constants'
import type { BlockedRequest, InterceptLog, ProbeArmResult } from '@shared/types'

/**
 * 拦截监视器。
 *
 * 护栏（`security.ts`）今天把拦下来的请求写进 `console.warn` —— 没人看得见。
 * 这个模块在同一个位置多记一份进内存，好让自检页把它显示出来。
 *
 * 它是**纯模块**：不 import electron、不碰 I/O、时钟从外面注入。于是
 * 「同一个地址由应用发起和由用户发起分别算到哪一栏」这件事能被单测直接问，
 * 不用先起一个 Electron —— 而归因规则正是这一期最容易写错的地方。
 *
 * 计数只在内存里，应用一关就没了。这是对的：它报的是「这次运行」，不是历史。
 */

export interface SecurityMonitor {
  /** 受理一次「你自己试」的授权。 */
  armProbe(url: string): ProbeArmResult
  /** 记一次被拦下来的请求。 */
  noteBlocked(url: string): void
  /** 记一次 CSP 响应头真的被加上。 */
  noteCspHeader(): void
  /** 记一次 TLS 验证器被问到。 */
  noteTlsCheck(): void
  snapshot(): InterceptLog & { cspApplied: number; tlsCalls: number }
}

export interface SecurityMonitorOptions {
  /**
   * 「这个地址会不会真被拦」的判据，从外面注入。
   *
   * 注入而不是在这里再抄一份协议名单，是为了让**「能不能演示拦截」和「会不会真被拦」
   * 用的是同一行代码**（`security.ts` 里那个 `isRequestAllowed`）。抄一份就等于
   * 造了第二个真相，两边迟早会说两套话。
   */
  isAllowed: (url: string) => boolean
  /** 时钟。测试里注入一个假的，这样清单里的时间戳可断言。 */
  now?: () => string
}

interface ArmedProbe {
  url: string
  /** 授权时刻的毫秒数，用来判窗口有没有过期。 */
  atMs: number
}

export function createSecurityMonitor(options: SecurityMonitorOptions): SecurityMonitor {
  const now = options.now ?? ((): string => new Date().toISOString())

  let appBlocked = 0
  let probeBlocked = 0
  let cspApplied = 0
  let tlsCalls = 0
  let recentTruncated = false
  let armed: ArmedProbe | null = null
  const recent: BlockedRequest[] = []

  /**
   * 一次拦截算到 `probe` 那一栏，当且仅当三件事同时成立：用户刚刚授权过一个地址、
   * 被拦的地址与它**完全相等**、而且授权还在窗口内。命中之后授权立刻作废。
   *
   * 三条都不能省，各自防一件事：
   *
   * 1. **完全相等，不做模糊匹配。** 「地址长得像用户填的」不是证据。真要出问题的
   *    那一天（应用某处偷偷请求了外网），我们需要 `appBlocked` 诚实地涨上去，
   *    而模糊匹配会替它找借口。
   * 2. **一次授权只兑一次。** 否则用户填一次地址、应用此后每次请求同一个地址都被
   *    记成「用户自己试的」——「应为 0」那个指标就永久地脏了。
   * 3. **授权会过期。** 这条是必需的而不是优化：CSP 有可能在渲染进程里就把那次加载
   *    挡掉，请求压根不会走到 `onBeforeRequest`。那时授权就悬在那儿，没有窗口的话
   *    它会一直等着，直到某个真正来自应用的请求撞上同一个地址、被错记成 probe。
   */
  function attribute(url: string): 'app' | 'probe' {
    if (armed === null) return 'app'
    if (armed.url !== url) return 'app'
    if (Date.parse(now()) - armed.atMs > SELF_CHECK_PROBE_WINDOW_MS) {
      // 过期的授权直接扔掉：留着它只会等着被下一个同址请求错认。
      armed = null
      return 'app'
    }
    armed = null
    return 'probe'
  }

  return {
    armProbe(url: string): ProbeArmResult {
      if (typeof url !== 'string' || url.trim() === '') {
        return { ok: false, url: null, reason: '先填一个地址。' }
      }
      const candidate = url.trim()
      if (candidate.length > SELF_CHECK_MAX_URL_LENGTH) {
        return { ok: false, url: null, reason: '这个地址太长了，换一个短的。' }
      }
      try {
        new URL(candidate)
      } catch {
        return {
          ok: false,
          url: null,
          reason: '这不是一个完整的地址 —— 要带协议，比如 http 或 https。'
        }
      }
      if (options.isAllowed(candidate)) {
        return {
          ok: false,
          url: null,
          reason:
            '这个协议本来就不拦（file、data、blob 这些都是本地的），换一个 http 或 https 的地址才能演示拦截。'
        }
      }

      armed = { url: candidate, atMs: Date.parse(now()) }
      return { ok: true, url: candidate, reason: null }
    },

    noteBlocked(url: string): void {
      const origin = attribute(url)
      if (origin === 'probe') probeBlocked += 1
      else appBlocked += 1

      // 计数在上面已经加过了 —— **清单满了不影响计数**。清单是给人看的样本，
      // 上面那两个数才是精确的。
      recent.push({ url, at: now(), origin })
      if (recent.length > SELF_CHECK_MAX_BLOCKED) {
        // 丢最旧的、留最新的：一个正常运行的应用这一栏本来是空的，
        // 真出事时用户想看的是刚刚发生了什么。
        recent.shift()
        recentTruncated = true
      }
    },

    noteCspHeader(): void {
      cspApplied += 1
    },

    noteTlsCheck(): void {
      // 正常情况下这个数一直是 0 —— 本应用不发起 TLS 连接。
      // 0 是预期，不是「没接上线」。
      tlsCalls += 1
    },

    snapshot() {
      return {
        appBlocked,
        probeBlocked,
        // 拷贝，不是内部状态本身：这份东西要过 IPC 序列化，
        // 把内部状态漏出去迟早会被谁改一手。
        //
        // 每条也得拷 —— `[...recent]` 只换了外层数组，元素还是同一批引用，
        // 拿到快照的人 `recent[0].url = …` 就把监视器的记录改了。`BlockedRequest`
        // 是三个字符串的扁平结构，展开一层就够，条数还有 SELF_CHECK_MAX_BLOCKED 兜着。
        //
        // 顺序是插入序（时间升序），界面自己决定要不要倒过来显示。
        recent: recent.map((item) => ({ ...item })),
        recentTruncated,
        cspApplied,
        tlsCalls
      }
    }
  }
}
