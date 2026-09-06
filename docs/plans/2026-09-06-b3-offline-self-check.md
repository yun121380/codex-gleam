# B3 · 离线自检页 实现计划

> 每个步骤用 `- [ ]` 标记，按任务顺序逐条实施、逐条勾掉。

**Goal:** README 里那些安全措施今天只是文字。这一期把它们变成**运行时可核对的证据**：一页六项，每一项都是从真实对象、真实计数、真实文件里读出来的，而不是从文档里抄的一份清单。再加一个「你自己试」——用户填任意地址，点一下，看应用怎么把它拦下来。分享之前，用户凭这一页自己判断「这个应用凭什么说它不联网」，而不是凭我们的一句承诺。

**Architecture:** 一个监视器 + 一个证据读取器 + 第 22 个 IPC 通道 + 一张页面。

护栏本身一行都不动。`applySessionSecurity` 现在把拦下来的请求写进 `console.warn`（`src/main/security.ts:65`）——没人看得见。这一期在同一个位置多写一份进内存里的监视器，然后把它接到界面上。**拦截逻辑本身不改**：`isRequestAllowed` 的判据、`onBeforeRequest` 的回调、TLS 验证器的返回值，都还是今天那些。这一期只是让它们的工作结果可见。

监视器（`src/main/selfCheck/monitor.ts`）是纯模块：不 import electron、不碰 I/O、时钟从外面注入。计数、两类归因、探针授权窗口、清单上限全在里面，于是「同一个地址由应用发起和由用户发起分别算到哪一栏」这件事能被单测直接问，不用先起一个 Electron。

证据读取器（`src/main/selfCheck/evidence.ts`）走 `FileSystemAccess`（`src/main/scanner/fsAccess.ts`），于是 `createFakeFs` 能喂给它任意内容，包括坏 JSON。目录解析留在 `main.ts`（要 `app.isPackaged` 与 `process.resourcesPath`），照 `resolveSampleDir`（`src/main/main.ts:25`）那个现成的写法。

报告组装（`src/main/selfCheck/report.ts`）也是纯函数，`ipc.ts` 里那个 handler 只是把它调一下。这样「报告长什么样」不需要 mock `ipcMain` 就能测——和 `reportModel.ts` 是同一个路子。

**Tech Stack:** 无新依赖。

**Spec:** [docs/design/2026-09-05-parity-and-shareability-design.md](docs/design/2026-09-05-parity-and-shareability-design.md) —— 第 4.3 节整节（六项证据的表格、「你自己试」那两段、以及绕开被禁 API 的办法）、第五节风险表「自检页拿不到构建期证据」一行、第六节「自检」与「安全测试自身扩展」两条、第七节 B3 行（验收：自身拦截计数为 0；「你自己试」能演示拦截且不污染该计数）。第二节的接缝预算写着「IPC 从 19 个方法加到 22 个：搜索、脱敏自审、离线自检各一个」——搜索与自审已经落地，通道数现在是 21，**这一期加的就是第 22 个，不是第 23 个**。

## Global Constraints

- **两栏计数必须分开，而且「应为 0」那一栏只由应用自己弄脏。** 设计文档把理由说到底了：「否则演示一次拦截就把『应为 0』这个指标弄脏了，指标一脏就再也没人看它。」落到实现上是一句可执行的话：**「你自己试」那条请求必须能被认出来**，而认出它的办法只能是「用户刚刚授权过这个地址」，不能是「这个地址长得像用户填的」。
- **计数只数请求，不数别的。** `hardenWebContents` 也会挡跳转、挡新窗口、挡 webview（`security.ts:95`—`115`），那些**不算**进这一栏。第一项说的是「请求数」，把导航拦截混进来就是把一个数说成另一个数。
- **渲染进程不许出现 `fetch(`、`XMLHttpRequest`、`new WebSocket`。** `tests/security/offline.test.ts` 扫整个 `src/`。「你自己试」用 DOM 造一个 `Image`、设 `src`、听 `onerror`——一个被禁的标识符都不碰，而 `img-src 'self' data:` 正好会拦住它，演示的就是这个拦截。
- **源码里不出现任何外部地址。** 地址由用户现场填。连提示文案里都不写带斜杠的示例（`https://…` 这种），改成「要带协议，比如 http 或 https」。好处是安全测试无需为这一期开任何例外，而且「目标由你选」比「我们预设了一个」更有说服力。
- **拿不到就说拿不到。** 沿用项目那条老规矩：没有数据就说没有，不要拿 0 冒充。第 5、6 项在开发模式下通常没有，这时明确显示「开发模式，构建期证据不可用」，不假装有；读到了坏 JSON 也逐条给原因，不静默当空。
- **第 3 项枚举真实对象。** 运行时 `Object.keys(window.gleam)`，不是页面里写死的一份清单。这一条有测试兜着：**页面源码里不许出现任何 `GleamApi` 方法名的字符串字面量**，写死了测试就红。
- **页面不许比护栏更乐观。** 每一格的文案只能说这次运行真的观测到的事。响应头在开发模式下根本没装（`security.ts:70` 那个 `if (!options.isDev)`），那一格就得是空的，不能把常量拿出来当「当前生效」。
- **两份 CSP 并列，不合并。** 见 Task 5 的说明——这个仓库里有两条策略，差三个指令。合成一行是撒谎。
- **`security.ts` 里那几个字符串不许消失。** `offline.test.ts` 逐字钉着 `onBeforeRequest` / `setWindowOpenHandler` / `will-navigate` / `will-attach-webview` / `setPermissionRequestHandler` / `Content-Security-Policy`。这一期要改的正是 `onBeforeRequest` 那个回调，改完这些字面量得还在。
- **`tests/redaction/redact.test.ts`（38 条）、`tests/redaction/maskPaths.test.ts`（8 条）、`tests/redaction/reportSecrets.test.ts`（5 条）继续一个字符都不许改。** 这一期压根不碰打码，它们只是继续当看门人。
- **不新增落盘文件，不引入网络，不改写任何原始会话文件。** 监视器的计数只在内存里，应用一关就没了——这是对的：它报的是「这次运行」，不是历史。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `src/shared/types.ts` | 改：`BlockedRequest` / `InterceptLog` / `ProbeArmResult` / `BuildEvidence` / `DependencyEvidence` / `SelfCheckRequest` / `SelfCheckReport` |
| `src/shared/constants.ts` | 改：`SELF_CHECK_*` 五个常量，每个都得说清为什么是这个数 |
| `src/shared/ipc.ts` | 改：第 22 个通道 `self-check:read` + `GleamApi.readSelfCheck` |
| `src/preload/api.ts` | 改：第 22 个方法，一行 invoke |
| `src/main/selfCheck/monitor.ts` | 新建：拦截计数、两类归因、探针授权窗口、有界清单——纯模块，不 import electron |
| `src/main/selfCheck/evidence.ts` | 新建：读两份构建期 JSON、把依赖树拍平——走 `FileSystemAccess`，不 import electron |
| `src/main/selfCheck/report.ts` | 新建：把监视器快照与证据拼成一份报告——纯函数，不需要 mock `ipcMain` 就能测 |
| `src/main/security.ts` | 改：导出 `PRODUCTION_CSP`、`TLS_UNTRUSTED_VERDICT`、`isRequestAllowed`；`applySessionSecurity` 返回监视器；顺手修掉 54 行那句错注释 |
| `src/main/main.ts` | 改：接住监视器、解析 `generated/` 目录、把两样都传进 `IpcContext` |
| `src/main/ipc.ts` | 改：第 22 个 handler |
| `src/renderer/hooks/useAppStore.tsx` | 改：`AppView` 加 `'self-check'` |
| `src/renderer/App.tsx` | 改：路由多一支；导航栏那个 `WifiOff` 徽标从死的 `<span>` 变成按钮 |
| `src/renderer/pages/SelfCheckPage.tsx` | 新建：六张卡 + 「你自己试」 |
| `src/renderer/pages/PrivacyPage.tsx` | 改：加一个「自己去核对」的入口 |
| `tests/security/interceptMonitor.test.ts` | 新建：两栏计数分开累加、授权窗口、清单上限、arm 校验 |
| `tests/security/selfCheckEvidence.test.ts` | 新建：读得到 / 读不到 / 坏 JSON / 依赖树拍平 |
| `tests/security/selfCheckReport.test.ts` | 新建：报告组装、开发模式下第 5、6 项为 null 且给出原因 |
| `tests/security/selfCheckSurface.test.ts` | 新建：preload 清单与 `GleamApi` 一致、页面不写死清单、页面用 `new Image(` 且不碰被禁 API |
| `docs/design/2026-09-05-parity-and-shareability-design.md` | 改：第 4.3 节第 2 项改成「两份策略并列」；第五节风险表那一行补上「开发机上跑过 `pnpm evidence` 时照实显示」 |

---

### Task 1: 契约、常量、第 22 个通道

先把形状定下来，后面六个任务都照着它写。这一任务不写任何逻辑。

这里唯一需要争论的是**为什么一个通道就够**。「你自己试」看着像两件事（先授权、再读结果），照直做就是两个通道，而第二节的预算只给了一个。解法是现成的：`sessions:search` 就是一个通道干两层活——不带 `sessionId` 是第一层，带了是第二层。这一期照抄：不带 `armProbe` 就是「读一份报告」，带了就是「先授权这个地址，再读一份报告」。受理结果放在报告里带回去（`probeArm`），于是渲染进程一次调用就拿到了它需要的全部东西。

- [ ] **Step 1: 在 `src/shared/types.ts` 末尾开一段离线自检的类型。** `BlockedRequest`：`url`（被拦下来的地址）、`at`（ISO 时间戳）、`origin`（`'app' | 'probe'`）。注释里写清 `origin` 为什么必须存在原始记录里而不是事后猜：归因只在拦截那一刻做得准，那时监视器手里还有「用户刚授权过什么」这个证据。
- [ ] **Step 2: 加 `InterceptLog`。** 四个字段：`appBlocked`（应用自身发起而被拦截的请求数，**这就是那个「应为 0」的指标**）、`probeBlocked`（用户按「你自己试」触发而被拦截的数）、`recent`（最近的清单，两类混排、各自带 `origin`，最多 `SELF_CHECK_MAX_BLOCKED` 条）、`recentTruncated`（清单撞过上限）。注释里点明**计数不受清单上限影响**：清单是给人看的样本，计数是精确的——和 `RedactionRuleGroup` 那里 `samples.length` 不等于 `count` 是同一个道理。
- [ ] **Step 3: 加 `ProbeArmResult`。** `ok: boolean` + `url: string | null` + `reason: string | null`。不受理时 `reason` 是给用户看的中文一句话，所以它是契约的一部分而不是日志。
- [ ] **Step 4: 加 `BuildEvidence` 与 `DependencyEvidence`。** `BuildEvidence` 的字段照 `scripts/buildEvidence.mjs` 真正写出来的那份：`schemaVersion` / `gitSha` / `testCount` / `platform` / `builtAt`，每个都可空——那个脚本的每条失败路径都返回 null，契约得照实反映这件事。`DependencyEvidence`：`generatedAt` / `packageCount` / `packages`（`Array<{ name: string; version: string }>`，已去重、已排序）/ `packagesTruncated`。**原始树不进报告**：`pnpm list --depth Infinity` 那份嵌套结构界面渲染不了，拍平成「有哪些包、各是什么版本」才是人能核对的东西。原始文件照旧原样随包发出，想看全的自己去 `resources/generated/` 读。
- [ ] **Step 5: 加 `SelfCheckRequest` 与 `SelfCheckReport`。** 请求只有一个可选字段 `armProbe?: string`。报告八个字段：`mode`（`'dev' | 'packaged'`）、`intercept`、`csp`（`{ responseHeader: string | null; appliedCount: number }`）、`tls`（`{ installed: boolean; verdict: number; calls: number }`）、`build`、`dependencies`、`probeArm`（这次没带 `armProbe` 就是 null）、`evidenceIssues`（读证据时出的岔子，逐条中文原因，空数组表示没岔子）。`csp.responseHeader` 的注释要写死一句话：**它是「这次运行真的加过的那条头」，开发模式下就是 null**，不是「常量的值」。
- [ ] **Step 6: 在 `src/shared/constants.ts` 末尾开一个 `SELF_CHECK_*` 块，五个常量，每个都带上「为什么是这个数」。** `SELF_CHECK_MAX_BLOCKED = 50`（清单条数；一个正常运行的应用这一栏应该是空的，50 条已经足够让「不正常」显形了，再多也只是同一件事重复）；`SELF_CHECK_PROBE_WINDOW_MS = 10000`（授权窗口；一次 `Image` 请求从设 `src` 到被拦下来是毫秒级的，10 秒是给慢机器留的余量，而不是给「稍后再来一发也算」留的口子）；`SELF_CHECK_MAX_EVIDENCE_BYTES = 8 * 1024 * 1024`（读证据文件的上限；依赖树带上全部传递依赖能有几 MB，8 MB 是留了余量的上界，同时不至于让一个被写坏的文件把内存吃光）；`SELF_CHECK_MAX_PACKAGES = 2000`（拍平后进报告的包数上限；这个仓库连开发依赖一共千把个，2000 留了一倍余量，超了就标 `packagesTruncated`）；`SELF_CHECK_MAX_URL_LENGTH = 2048`（用户填的地址长度上限；纯粹是别让一个几十万字符的输入进到清单里）。
- [ ] **Step 7: `src/shared/ipc.ts` 加第 22 个通道。** `selfCheck: 'self-check:read'`，加在 `os:reveal-in-folder` 之后；`GleamApi` 加 `readSelfCheck(request?: SelfCheckRequest): Promise<SelfCheckReport>`。方法名用 `read` 而不是 `get`：它带副作用（可能授权一个探针），`get` 会读成纯查询。
- [ ] **Step 8: `src/preload/api.ts` 加对应的一行 invoke。** 这个文件的规矩是一行一个方法、什么都不做，照办。
- [ ] **Step 9: `pnpm typecheck`。** 这一步应该**干净地过**，而这件事本身值得记一笔：`ipc.ts` 里那些 handler 是一句句 `ipcMain.handle(IPC.x, …)`，**没有任何类型把它们和 `GleamApi` 绑在一起**——所以 `GleamApi` 多一个方法、主进程那边一个 handler 都不加，编译器一声不响。少掉的那次往返在运行时才会以「`No handler registered`」的形式炸出来。这正是 Task 6 Step 7 第一条断言存在的理由：`GleamApi` 与 `api.ts` 的一致性只能靠测试钉，编译器不管。

---

### Task 2: 监视器（纯模块）

`src/main/selfCheck/monitor.ts`，新文件。四件事：数拦截、把拦截归到两栏里的一栏、受理探针授权、给出快照。不 import electron、不碰 I/O、时钟从外面注入。

**归因规则是这一期的核心，得先把它说准。** 一次拦截算到 `probe` 那一栏，当且仅当三件事同时成立：用户刚刚授权过一个地址、被拦的地址与它**完全相等**、而且授权还在窗口内。命中之后**授权立刻作废**——一次点击只能解释一次拦截。除此之外的任何拦截都算到 `app` 那一栏。

三条都不能省，各自防一件事：

1. **完全相等，不做模糊匹配。** 「地址长得像用户填的」不是证据。真要出问题的那一天（应用某处偷偷请求了外网），我们需要那一栏诚实地涨上去，而模糊匹配会替它找借口。
2. **一次授权只兑一次。** 否则用户填一次地址、应用此后每次请求同一个地址都被记成「用户自己试的」——「应为 0」那个指标就永久地脏了。
3. **授权会过期。** 这条不是可选的优化，是必需的：CSP 有可能在渲染进程里就把那次加载挡掉，请求**压根不会**走到 `onBeforeRequest`（见 Task 6 的三种结局）。那时授权就悬在那儿，没有窗口的话它会一直等着，直到某个真正来自应用的请求撞上同一个地址、被错记成 probe。窗口把这个漏洞封在 10 秒里。

**授权受理时的校验用的必须是拦截时的那一条判据。** 用户填了 `file:///etc/passwd` 或者 `data:image/png;...`，那些协议本来就在放行名单里（`security.ts:16`），演示不了任何拦截——得当场告诉他换一个。判断的办法不是在监视器里再抄一份协议名单，而是把 `isRequestAllowed` 作为谓词注入进来。于是**「能不能演示拦截」和「会不会真被拦」用的是同一行代码**，永远不会说两套话。

- [ ] **Step 1: `createSecurityMonitor(options)` 返回一个 `SecurityMonitor`。** 入参两个：`isAllowed: (url: string) => boolean`（注入的谓词，理由见上）与 `now?: () => string`（默认 `() => new Date().toISOString()`，测试里注入一个假的，这样清单里的时间戳是可断言的）。返回的对象五个方法：`armProbe(url)` / `noteBlocked(url)` / `noteCspHeader()` / `noteTlsCheck()` / `snapshot()`。
- [ ] **Step 2: `armProbe(url): ProbeArmResult`。** 依次判：空串 → 「先填一个地址」；长度超 `SELF_CHECK_MAX_URL_LENGTH` → 「地址太长了」；`new URL(url)` 抛 → 「这不是一个完整的地址（要带协议，比如 http 或 https）」；`isAllowed(url)` 为真 → 「这个协议本来就不拦（file、data、blob 这些都是本地的），换一个 http 或 https 的地址才能演示」。全过了才记下 `{ url, at: now() }` 并返回 `ok: true`。**文案里不许出现带斜杠的完整示例地址**（Global Constraints 第四条）。
- [ ] **Step 3: `noteBlocked(url)`。** 照上面那三条判 `origin`，对应那一栏 `+= 1`，然后往 `recent` 里推一条 `{ url, at: now(), origin }`。清单满了就丢**最旧**的那条并把 `recentTruncated` 置真——留新的：一个正常运行的应用这一栏本来是空的，真出事时用户想看的是刚刚发生了什么。**计数不因为清单满了而停**，这一点在注释里写死。
- [ ] **Step 4: `noteCspHeader()` 与 `noteTlsCheck()`。** 各自只是一个自增。前者让第 2 项能说「这条头真的加过 N 次」而不只是「常量长这样」；后者让第 4 项能说「验证器被问过 N 次」——**正常情况下这个数一直是 0**，因为本应用不发起 TLS 连接，注释里得写明白 0 是预期而不是没接上线。
- [ ] **Step 5: `snapshot()` 返回一份 `InterceptLog` 加上两个计数。** 返回的 `recent` 必须是**拷贝**（`[...]`），不是内部数组本身——报告要过 IPC 序列化，把内部状态漏出去迟早会被谁改一手。顺序按时间升序（也就是插入序），界面自己决定要不要倒过来显示。
- [ ] **Step 6: 写 `tests/security/interceptMonitor.test.ts`。** 六组：**一，两栏分开**——授权一个地址、拦它一次 → `probeBlocked` 1 / `appBlocked` 0；再拦同一个地址一次 → `probeBlocked` 还是 1、`appBlocked` 变 1（授权已兑掉，这是第 2 条规则在测试里的样子）。**二，别的地址不蹭授权**——授权 A、拦 B → B 记在 `app` 栏，A 的授权还在。**三，窗口过期**——注入的时钟往后拨过 `SELF_CHECK_PROBE_WINDOW_MS`，同一个地址被拦 → 记在 `app` 栏。**四，arm 校验**——空串 / 非法地址 / `file:` / `data:` 各自不受理且 `reason` 非空；一个 `http` 地址受理。**五，清单上限**——推 `SELF_CHECK_MAX_BLOCKED + 5` 条，清单正好上限条、`recentTruncated` 为真、**计数是 `+5` 之后的真实值**、且第一条已经是被挤掉之后的那条。**六，快照是拷贝**——改返回的 `recent` 不影响下一次快照。
- [ ] **Step 7: `pnpm vitest run tests/security/interceptMonitor.test.ts`。** 这个模块此刻还没有任何调用方，能独立跑绿本身就是它值得单独存在的证明——归因规则是这一期最容易写错的地方，它必须能脱离 Electron 被拷问。

---

### Task 3: 接到护栏上

改 `src/main/security.ts`。这一步的分寸很重要：**只加观测，不动判据**。

`offline.test.ts` 逐字钉着这个文件里的六个字符串（`onBeforeRequest`、`setWindowOpenHandler`、`will-navigate`、`will-attach-webview`、`setPermissionRequestHandler`、`Content-Security-Policy`），改完得都还在。它们不是碰巧被钉的：那是「护栏还在」的最后一道机械证明。

顺手要修一个**文档与代码不符**：54 行的注释写着「与 index.html 里注入的一致」，而它不一致——`electron.vite.config.ts:18` 那份有 13 个指令，这份只有 10 个，差的正是 `media-src` / `worker-src` / `manifest-src` 三条。这句错注释活了这么久，恰恰说明为什么需要第 4.3 节这一整页：**写在注释里的承诺没人核对，显示在界面上的数字才有人核对。**

- [ ] **Step 1: 把 `PRODUCTION_CSP` 从模块私有改成导出**（`security.ts:55`），并把 54 行那句注释换成实话：这一份是**响应头**用的 10 条，`index.html` 里注入的那一份多 3 条 `media-src` / `worker-src` / `manifest-src`，两份都真实生效、不合并、自检页并列展示。
- [ ] **Step 2: 把 `-3` 提成导出的常量 `TLS_UNTRUSTED_VERDICT = -3`**（原来写死在 `security.ts:89`），注释说明它是 `CERT_AUTHORITY_INVALID`、含义是「直接判为不可信」。页面上那个「-3」必须来自**验证器真正返回的那个常量**，不能是界面里手抄的一个数字——这就是第 3 项那句「枚举真实对象而不是文档里抄的清单」的同一条精神，用在第 4 项上。
- [ ] **Step 3: 导出 `isRequestAllowed`。** 监视器要用它做授权校验（Task 2 的理由）。函数体一个字符都不动。
- [ ] **Step 4: `applySessionSecurity` 的返回值从 `void` 改成 `SecurityMonitor`。** 函数开头 `const monitor = createSecurityMonitor({ isAllowed: (url) => isRequestAllowed(url, options) })`，结尾 `return monitor`。三处埋点：`onBeforeRequest` 的拦截分支里，在 `console.warn` 旁边加 `monitor.noteBlocked(details.url)`（`console.warn` 留着——终端里那一行对开发者仍然有用，而且它是这个文件最原始的证据）；`onHeadersReceived` 回调里加 `monitor.noteCspHeader()`；`setCertificateVerifyProc` 回调里加 `monitor.noteTlsCheck()` 并把 `callback(-3)` 换成 `callback(TLS_UNTRUSTED_VERDICT)`。
- [ ] **Step 5: `src/main/main.ts` 接住它。** 108 行那句 `applySessionSecurity(...)` 改成 `const securityMonitor = applySessionSecurity(...)`。**顺序不用改**：它已经在 `registerIpcHandlers` 之前了。
- [ ] **Step 6: 在 `main.ts` 加 `resolveEvidenceDir()`，照 `resolveSampleDir`（25 行）那个写法。** 打包时 `[join(process.resourcesPath, 'generated')]`；开发时 `[join(app.getAppPath(), 'build', 'generated'), join(process.cwd(), 'build', 'generated')]`。开发路径**不是**多余的：开发机上跑过 `pnpm evidence` 之后那两份 JSON 就在 `build/generated/` 里，那时照实显示比硬说「开发模式没有」更诚实（见 Task 4 Step 5）。返回第一个存在的目录，都不存在就返回 null。
- [ ] **Step 7: `IpcContext` 加三个字段并在 `bootstrap()` 里传进去：** `securityMonitor`、`evidenceDir: string | null`、`isDev: boolean`。`fs` 也要一个——证据读取器走 `FileSystemAccess`，`main.ts` 里已经有 `nodeFileSystem` 在给 library 用了，同一个实例传下去即可。
- [ ] **Step 8: `pnpm typecheck` + `pnpm vitest run tests/security/offline.test.ts`。** 后者是这一步唯一真正要看的：那六个字符串还在不在、新加的代码有没有引入被禁 API。它绿，这一步就是安全的。

---

### Task 4: 构建期证据（第 5、6 项）

`src/main/selfCheck/evidence.ts`，新文件。这两项的生产端 **A1 就已经做完了**，这一期只是把它们读出来：

- `scripts/buildEvidence.mjs` 写 `build/generated/build-evidence.json`，它的头注释指名了消费者：「B3 的离线自检页读它；读不到就显示『开发模式，构建期证据不可用』。」
- `scripts/dependencyTree.mjs` 写 `build/generated/dependency-tree.json`，头注释指着 spec 3.4：「把完整依赖树打进构建日志并作为构建产物保存，供离线自检页展示。」
- `pnpm evidence` 依次跑这两个脚本，而 `package:win` / `package:mac` / `package:linux` / `package:dir` **每一个都先跑 `evidence`**。
- `electron-builder.yml` 的 `extraResources` 已经把 `build/generated/**/*.json` 拷到包里的 `generated/` 下，注释里同样写着「B3 的离线自检页从 `process.resourcesPath` 下的 `generated/` 读它」。

也就是说这一任务是**接线**，不是建设。三个人在三个地方留了同一句话等着这一期来兑现。

- [ ] **Step 1: `readJsonEvidence(fs, path)`（模块私有）。** 走 `fs.readText(path, SELF_CHECK_MAX_EVIDENCE_BYTES)`，返回 `{ value } | { issue }`。三条失败路径各给一句中文原因：读不到（文件不存在 / 没权限）、被截断（`truncated` 为真——那说明文件比上限还大，解析出来的一定是坏 JSON，得当场说清是「太大」而不是「格式坏」）、`JSON.parse` 抛。**一条都不许静默成空**：静默的空和真实的空在界面上长得一模一样，而它们的含义相反。
- [ ] **Step 2: `readBuildEvidence(fs, dir)`。** `dir` 为 null 时直接返回 `{ evidence: null, issues: [] }`——「没有这个目录」不是岔子，是开发模式的常态，页面自己会说。字段逐个用 `validators.ts` 那套容错取法：不是字符串的 `gitSha` 当 null，不是数字的 `testCount` 当 null。**不要因为一个字段坏就把整份丢掉**：`gitSha` 拿到了而 `testCount` 坏了，那也是一半证据，比没有强。
- [ ] **Step 3: `flattenDependencyTree(tree)`——纯函数，这一任务里唯一有算法的地方。** `pnpm list --json --depth Infinity` 出来的是嵌套结构（顶层是数组，每个节点下有 `dependencies` / `devDependencies` / `optionalDependencies` 三个可能的对象，值里又嵌 `dependencies`）。递归收集 `{ name, version }`、用 `name@version` 去重、按 `name` 再按 `version` 的码点排序。三件事写进注释：**递归要防环**（pnpm 的输出理论上是树，但 `peerDependencies` 的解析结果里出现过自引用，见过一次就得防）；**同名不同版本要各留一条**（一个依赖树里同时有两个版本的 `semver` 是常态，合并成一条就把真相抹了）；**超过 `SELF_CHECK_MAX_PACKAGES` 就截断并置 `packagesTruncated`**，但 `packageCount` 报的是**截断前**的真实条数。
- [ ] **Step 4: `readDependencyEvidence(fs, dir)`。** 拼上 `flattenDependencyTree`，`generatedAt` 照读。
- [ ] **Step 5: 写 `tests/security/selfCheckEvidence.test.ts`，用 `createFakeFs`。** 六组：`dir` 为 null → 两个都是 null、`issues` 为空（**这是「开发模式」那条路，不是错误路**）；正常 JSON → 字段逐个对上；坏 JSON → `evidence` 为 null 且 `issues` 里那句话点明是「格式坏」；文件不存在 → 原因点明「读不到」；`truncated` 为真 → 原因点明「太大」而不是「格式坏」；`flattenDependencyTree` 单独一组——嵌套三层能全收上来、同名不同版本各留一条、带环的输入不死循环、超上限时 `packageCount` 仍是真实值。
- [ ] **Step 6: `pnpm vitest run tests/security/selfCheckEvidence.test.ts`。**

---

### Task 5: 报告组装与第 22 个 handler

`src/main/selfCheck/report.ts`，新文件，一个纯函数把监视器快照与构建期证据拼成一份 `SelfCheckReport`。`ipc.ts` 里那个 handler 只是把它调一下——「报告长什么样」于是不需要 mock `ipcMain` 就能测，和 `reportModel.ts` 是同一个路子。

**这一任务要把「两份 CSP 并列」这个决定落到数据形状上。** 这个仓库里有两条策略：`electron.vite.config.ts:18` 那份 13 个指令，构建时注入进 `index.html` 的 `<meta>`；`security.ts:55` 那份 10 个指令，生产环境下由 `onHeadersReceived` 加成响应头。差的三条是 `media-src` / `worker-src` / `manifest-src`，都只在 meta 那一份里。

合成一行是撒谎，理由有三层：**它们生效的层次不同**（一个是文档解析时就位的，一个是每个响应上带的）、**它们的内容不同**（差三条）、**它们在开发模式下的命运不同**（meta 那份是构建期插件写的，开发服务器下压根没插；响应头那份被 `if (!options.isDev)` 挡着，开发模式下也没装）。所以报告里 `csp` 只报**响应头**这一份，而且只报「这次运行真的加过的那条」——开发模式下它是 null。meta 那一份归渲染进程自己去 DOM 里读（Task 6 Step 3），因为那才是**真实对象**，和第 3 项枚举 `window.gleam` 是同一条精神。

- [ ] **Step 1: `buildSelfCheckReport(input)`——纯函数。** 入参一个对象：`monitor`（快照，不是监视器本体——纯函数不该有能改状态的东西）、`build` / `dependencies` / `evidenceIssues`（Task 4 读出来的）、`isDev`、`probeArm`。出参就是 `SelfCheckReport`。`mode` 由 `isDev` 决定。`csp.responseHeader` 的取法是这个函数里唯一需要想一下的地方：**开发模式下必须是 null**，因为那道头根本没装；生产模式下才填 `PRODUCTION_CSP`，而且要配着 `appliedCount`（监视器数出来的实际次数）一起看——常量说「打算加什么」，计数说「真加过几次」，两个都给才算诚实。
- [ ] **Step 2: `tls` 那一格照抄常量而不是抄数字。** `verdict: TLS_UNTRUSTED_VERDICT`、`installed: true`（这个 handler 能跑，说明 `applySessionSecurity` 跑过了，验证器一定装上了）、`calls` 从快照来。注释里写明 `calls` **正常情况下恒为 0**，因为本应用不发起 TLS 连接——0 是预期而不是「没接上线」，页面上那句话得照这个意思写。
- [ ] **Step 3: `src/main/ipc.ts` 加第 22 个 handler，位置照通道顺序排在最后。** 逻辑三行：有 `armProbe` 就先 `context.securityMonitor.armProbe(url)` 拿到 `ProbeArmResult`；然后 `readBuildEvidence` / `readDependencyEvidence`（两个 `await`，用 `Promise.all`）；最后 `buildSelfCheckReport(...)`。**顺序不能倒**：先授权再读证据，这样从「用户点下按钮」到「授权生效」之间的那段时间最短——读两个 JSON 文件是毫秒级的事，但把它排在授权前面就等于白花掉窗口预算的一部分。
- [ ] **Step 4: handler 里不要 try/catch 吞异常。** 这个仓库的 IPC 层惯例是让异常自己冒到 `ipcMain.handle` 的 rejection 里，渲染进程那边 `.catch(() => setState(null))` 接住并显示「读不到」。证据读取器自己已经把「文件层面的岔子」变成了 `issues`（不抛），所以真能冒到这里的只有编程错误——那种东西该响，不该被静默成一份空报告。
- [ ] **Step 5: 写 `tests/security/selfCheckReport.test.ts`。** 五组：**一，开发模式**——`isDev` 为真时 `mode` 是 `'dev'`、`csp.responseHeader` 为 **null**（这一条是 Global Constraints 那句「页面不许比护栏更乐观」的可执行形式）。**二，生产模式**——`mode` 是 `'packaged'`、`csp.responseHeader` 等于 `PRODUCTION_CSP` 那个导出的常量（断言用 import 进来的常量，不是抄一遍字符串：抄一遍就又造了一处会过期的副本）。**三，两栏计数原样传过去**——喂一份 `appBlocked: 0 / probeBlocked: 2` 的快照，断言报告里还是这两个数，没有被谁「顺手加起来」。**四，构建期证据缺失**——`build` 与 `dependencies` 都是 null 时报告仍然成立、`evidenceIssues` 原样带出。**五，`probeArm`**——不传时是 null，传了时原样在报告里。
- [ ] **Step 6: `pnpm typecheck` + `pnpm vitest run tests/security/selfCheckReport.test.ts`。** typecheck 这时应该干净了：Task 1 Step 9 那条「少一个 handler」的报错在 Step 3 之后消失。

---

### Task 6: 页面

`src/renderer/pages/SelfCheckPage.tsx`，新文件。六张卡，加下面那一段「你自己试」。照 `PrivacyPage.tsx`（96 行）那个模板写：`useApp()` 拿状态、`void window.gleam.readSelfCheck().then(setReport).catch(() => setReport(null))`、`Card` / `Button` 从 `../components/ui` 来、lucide 图标、`max-w-3xl px-8 py-10` 那套排版词汇。

**「你自己试」有三种结局，三种都得照实说。** 用户填一个地址、点一下，页面 `new Image()`、设 `src`、听 `onerror` / `onload`，然后再读一次报告比对计数。三种结局：

1. **`onerror` 触发，而且 `probeBlocked` 涨了 1** → 主进程的 `onBeforeRequest` 把它拦下了。这是最完整的一次演示：请求确实成型了、确实被那一行代码挡住了、而且**记在了 probe 那一栏而不是「应为 0」那一栏**。
2. **`onerror` 触发，但计数没动** → CSP 在渲染进程就把这次加载挡掉了，请求**压根没离开这个窗口**，所以主进程没机会看见它。这不是失败，这是**第二道防线先动手了**——页面要说清是哪一道，而不是含糊地说「被拦了」。
3. **`onload` 触发** → 它真的加载成功了。这不该发生；发生了就得原样报出来，红字写「这次没有被拦住」，而不是把一次失败的演示说成成功。

哪一层先动手这件事**不跑一次 Electron 是判不出来的**，所以页面分支而不是猜。而这个分支本身是个更好的演示：两道独立的防线，用户一次点击就把两道都看见了。

- [ ] **Step 1: `useAppStore.tsx:33` 的 `AppView` 加 `'self-check'`；`App.tsx` 的视图三元里多一支。** 顺手把导航栏那个死的 `WifiOff` 徽标（`App.tsx:82`—`87`）从 `<span>` 换成 `<button>`，点它进这一页。那个徽标今天挂着 `title="本应用完全离线运行，所有网络请求都被拦截"`——一句纯承诺；这一期让它变成通往证据的入口，是这个改动最合适的落点。`NAV` 那四项不动：自检是「想核对的时候去看一眼」，不是日常操作，塞进 62 px 的主导航会挤掉真正常用的东西。
- [ ] **Step 2: 六张卡按第 4.3 节表格的顺序排。** ① 两个大数字并排（`appBlocked` 配一句「应为 0」，`probeBlocked` 配一句「你自己试触发的」）加下面的清单（倒序显示，`recentTruncated` 为真时补一句「只留了最近 N 条」）；② CSP 两份并列，各自标明来源与指令数，并写清那三条只在 meta 那一份里；③ `Object.keys(window.gleam)` 的运行时枚举；④ TLS 验证器（`verdict` 与 `calls`，配那句「0 是预期」）；⑤ 构建期证据四个字段；⑥ 依赖树（`packageCount` 与列表）。⑤⑥ 拿不到时显示「开发模式，构建期证据不可用」，`evidenceIssues` 非空时逐条列出原因。
- [ ] **Step 3: 第 2 项那份 meta 策略从 DOM 里读。** `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')`——**真实对象**，不是从 `electron.vite.config.ts` 里抄一份常量过来。开发服务器下这个 meta 压根没被插件插进去（那个插件是 `apply: 'build'`），读到 null 就说「开发模式下未注入」，同样不假装。
- [ ] **Step 4: 第 3 项枚举 `Object.keys(window.gleam)`，排序后渲染。** 页面里**不许出现任何 `GleamApi` 方法名的字符串字面量**（Global Constraints 第七条），这一条由 Task 6 Step 7 的测试钉着。
- [ ] **Step 5: 「你自己试」那一段。** 一个输入框 + 一个按钮。点下去的流程：先 `readSelfCheck({ armProbe: url })` 拿到 `probeArm`——不受理就把 `reason` 显示出来、到此为止（连 `Image` 都不造，省得让用户看一次注定演示不了拦截的加载）；受理了就 `new Image()`、`img.onerror` / `img.onload` 各挂一个回调、`img.src = url`，然后在回调里再 `readSelfCheck()` 读一次报告，按上面那三种结局分支出文案。**输入框的提示文案里不许出现带斜杠的示例地址**，写「要带协议，比如 http 或 https」。
- [ ] **Step 6: `PrivacyPage.tsx` 加一个入口。** 那一页现在讲的是「我们做了什么」，自检页讲的是「你自己核对」，两页天然连着。加一张卡或者一个按钮，文案一句话：不用信这一页写的，去自检页看运行时的数。
- [ ] **Step 7: 写 `tests/security/selfCheckSurface.test.ts`——源码层的四条断言。** `vitest.config.ts` 是 `environment: 'node'`，渲染进程的运行时行为在这个仓库里只能从源码上验，所以这一组测试读的是文件内容：**一，preload 清单与 `GleamApi` 一致**——`ipc.ts` 里 `GleamApi` 的方法名集合与 `api.ts` 里实际导出的键集合完全相等（这是第六节点名要的那条「清单错了测试就红」）。**二，页面不写死清单**——`SelfCheckPage.tsx` 里不出现任何 `GleamApi` 方法名的字符串字面量（`readSelfCheck` 自己作为属性访问出现是可以的，测的是带引号的字面量）。**三，页面确实带着探针**——源码里有 `new Image(`。这一条是正向断言，缺了它「把功能删掉」也能让前两条绿。**四，不碰被禁 API**——`fetch(` / `XMLHttpRequest` / `new WebSocket` 一个都不出现。第四条与 `offline.test.ts` 有重叠，留着是因为它把「这一页为什么这么写」钉在了离它最近的地方。
- [ ] **Step 8: `pnpm typecheck` + `pnpm lint` + `pnpm vitest run tests/security`。** 渲染层归 `tsconfig.web.json` 管；这个新页面只 import `@shared/types` 与本地组件，不会撞 TS6307。

---

### Task 7: 验收与收尾

设计文档第七节给 B3 的验收条件是「自身拦截计数为 0；『你自己试』能演示拦截且不污染该计数」。前六个任务只保证了「逻辑是对的、能单测」，**这两句话本身只能靠跑起来看**。

- [ ] **Step 1: `pnpm verify` 全绿。** 把实际数字记下来——写提交正文时要用真数，不要凭印象。基线是 46 个文件 / 776 条。三个「一个字符都不许改」的文件（`redact.test.ts` 38 条、`maskPaths.test.ts` 8 条、`reportSecrets.test.ts` 5 条）从头到尾没动过。
- [ ] **Step 2: `pnpm dev`，进自检页，先看第一项。** `appBlocked` 必须是 **0**——这是验收行的前半句，也是这一期唯一一个「必须是某个具体值」的断言。不是 0 就说明应用真的在往外发请求，那是个 bug，得先查清楚是谁发的（清单里有地址）再往下走。顺手确认第 2 项响应头那一格是**空的**（开发模式下那道头没装）、第 3 项列出的键与 `api.ts` 对得上、第 4 项 `calls` 是 0、第 5、6 项显示「开发模式，构建期证据不可用」。
- [ ] **Step 3: 在同一个开发模式下点「你自己试」，填一个 `http` 地址。** 看到三种结局里的哪一种就记下哪一种，连同 `appBlocked` 改没改一起记——**`appBlocked` 必须还是 0**，这是验收行的后半句。再试一个 `file:` 开头的地址，确认它被 `armProbe` 当场挡住并给出中文原因，而且**没有**产生任何计数。
- [ ] **Step 4: `pnpm evidence` 之后再进一次自检页。** 这一步验的是 Task 3 Step 6 那两条开发期路径：跑过脚本之后 `build/generated/` 里有东西了，第 5、6 项应该照实显示而不是继续说「不可用」。测试数、git sha、依赖包数都对得上才算通过。
- [ ] **Step 5: `pnpm package:dir` 打一个免安装目录版，跑起来再看一遍。** 这一步是唯一能验第 2 项响应头与 `process.resourcesPath` 那条读取路径的办法：打包后 `csp.responseHeader` 必须非空且等于那 10 条，`appliedCount` 应该大于 0，第 5、6 项从 `resources/generated/` 读出来。**只在 Windows 上打**——mac/Linux 的包本机验不了，那两个平台归 CI。
- [ ] **Step 6: 更新设计文档两处。** 第 4.3 节第 2 项那一行（「当前生效的 CSP | `PRODUCTION_CSP` 常量 + 实际响应头」）改成「两份策略并列」的说法，把 13 与 10 的差别和那三条 meta-only 指令写进去——这是实现过程中量出来的事实，文档得跟上。第五节风险表「自检页拿不到构建期证据」那一行补上一句：开发机上跑过 `pnpm evidence` 时照实显示，「开发模式」不等于「一定没有」。
- [ ] **Step 7: 按仓库惯例提交。** 提交主题走 `feat(security): …`，正文中文，说清三件事：这一期把 README 里的文字变成了运行时可核对的数；两栏计数分开的理由（「指标一脏就再也没人看它」）；「你自己试」用 `Image` 而不是 `fetch` 的理由，以及它演示出来的是两道防线而不是一道。顺带记下第 2 步量到的真实数字。

