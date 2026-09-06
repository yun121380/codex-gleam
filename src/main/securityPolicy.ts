/**
 * 护栏的两个策略常量。
 *
 * 它们本来长在 `security.ts` 里，挪出来只为一件事：**让引用它们的人不必被迫
 * 拖进 electron**。`security.ts` 顶上 `import … from 'electron'`，于是任何想引用
 * 这两个值的纯模块（自检报告的组装）一旦 import 它，连带把 electron 拉进测试链 ——
 * 一个以「完全离线」为主张的仓库，测试跑一半去下载 Electron 二进制，这件事本身
 * 就不该发生。
 *
 * 放在 `src/main/` 而不是 `src/shared/` 是有意的：渲染进程**不该**能 import 它们。
 * 自检页要显示的是「这次运行真的加过的那条」，那份数据从 IPC 报告来；
 * 界面上要是能直接 import 常量，迟早有人图省事直接显示常量，
 * 于是页面又比护栏乐观了 —— 而这一整期就是在修这类事。
 */

/**
 * 生产环境**响应头**用的 CSP，10 条指令。
 *
 * 它和 `index.html` 里注入的那一份**不一致**，别当成同一条：
 * `electron.vite.config.ts:18` 那份有 13 条，多出 `media-src` / `worker-src` /
 * `manifest-src` 三条。两份都真实生效、生效的层次还不同（一个是文档解析时就位的
 * meta，一个是每个响应上带的头），自检页因此并列展示两份而不合并 —— 合成一行是撒谎。
 *
 * （这句注释从前写的是「与 index.html 里注入的一致」，而它一直不一致。
 * 一句没人核对的注释能活这么久，恰恰是自检页存在的理由：写在注释里的承诺没人核对，
 * 显示在界面上的数字才有人核对。）
 */
export const PRODUCTION_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

/**
 * TLS 验证器恒定返回的判决值：`CERT_AUTHORITY_INVALID`，含义是「直接判为不可信」。
 *
 * 提成常量是为了让自检页上那个「-3」来自**验证器真正返回的那个值**，
 * 而不是界面里手抄的一个数字 —— 手抄的副本迟早会和实现走散。
 */
export const TLS_UNTRUSTED_VERDICT = -3
