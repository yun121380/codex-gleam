import type {
  BuildEvidence,
  DependencyEvidence,
  InterceptLog,
  ProbeArmResult,
  SelfCheckReport
} from '@shared/types'
// 从 `securityPolicy.ts` 取而不从 `security.ts` 取：后者 import electron，
// 而这个模块是纯函数——引一次就要让测试去下载 Electron 二进制，代价荒唐。
import { PRODUCTION_CSP, TLS_UNTRUSTED_VERDICT } from '../securityPolicy'

/**
 * 把监视器快照与构建期证据拼成一份报告。
 *
 * 是个**纯函数**，理由和 `reportModel.ts` 一样：「报告长什么样」于是不需要
 * mock `ipcMain` 就能测。`ipc.ts` 里那个 handler 只负责取材料，不负责判断。
 */

export interface SelfCheckInput {
  /**
   * 监视器的**快照**，不是监视器本体。
   *
   * 纯函数手里不该有能改状态的东西——拿到本体就意味着这里随时可以
   * `noteBlocked` 一下，那这个函数就不再只是「组装」了。
   */
  monitor: InterceptLog & { cspApplied: number; tlsCalls: number }
  build: BuildEvidence | null
  dependencies: DependencyEvidence | null
  evidenceIssues: string[]
  isDev: boolean
  probeArm: ProbeArmResult | null
}

export function buildSelfCheckReport(input: SelfCheckInput): SelfCheckReport {
  return {
    mode: input.isDev ? 'dev' : 'packaged',

    intercept: {
      // 两栏原样传出去，谁也别把它们加起来：`appBlocked` 是那个「应为 0」的指标，
      // 混进用户自己点出来的那几次，这个数就再也没人看了。
      appBlocked: input.monitor.appBlocked,
      probeBlocked: input.monitor.probeBlocked,
      recent: input.monitor.recent,
      recentTruncated: input.monitor.recentTruncated
    },

    csp: {
      /**
       * 开发模式下必须是 null —— 那道响应头被 `security.ts` 里的
       * `if (!options.isDev)` 挡着，根本没装。
       *
       * 这里填常量就等于拿「打算加什么」冒充「当前生效」，页面于是比护栏更乐观。
       * 一个自检页只要在任何一处比它检查的东西乐观，它报的所有数就都不值钱了。
       *
       * （meta 里那一份 CSP 不在这里报：它归渲染进程自己去 DOM 里读那个真实对象。
       * 两份内容不同、生效层次不同、开发模式下的命运也不同，合成一行是撒谎。）
       */
      responseHeader: input.isDev ? null : PRODUCTION_CSP,
      // 常量说「打算加什么」，这个数说「真加过几次」——两个都给才算诚实。
      appliedCount: input.monitor.cspApplied
    },

    tls: {
      // 这个 handler 能跑，说明 `applySessionSecurity` 跑过了，验证器一定装上了。
      installed: true,
      // 抄常量而不是抄那个数字：手抄的副本迟早和实现走散，
      // 而这一页的全部价值就在于它显示的东西来自实现本身。
      verdict: TLS_UNTRUSTED_VERDICT,
      // **正常情况下这个数恒为 0**，因为本应用不发起 TLS 连接。
      // 0 是预期，不是「没接上线」——页面上那句话得照这个意思写。
      calls: input.monitor.tlsCalls
    },

    build: input.build,
    dependencies: input.dependencies,
    probeArm: input.probeArm,
    evidenceIssues: input.evidenceIssues
  }
}
