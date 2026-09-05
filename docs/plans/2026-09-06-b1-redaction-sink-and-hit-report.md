# B1 · 遥测 sink + 命中报告 实现计划

> 每个步骤用 `- [ ]` 标记，按任务顺序逐条实施、逐条勾掉。

**Goal:** 让打码这件事变得可看、可反驳。分享之前点一下导出按钮旁边那个盾牌，看清两件事：这个会话里**打掉了什么**（按规则分组的计数、打码后的上下文、点一下就跳到那一步），以及**什么被判为不是密钥**（`author` 里的 auth、`input_tokens`、源码里的 `password: str = Field(...)`）。第二件事今天完全藏在 `patterns.ts` 的两条正则里，没人能反驳它——这一期就是把它摆到台面上。

**Architecture:** 一个可选参数，加一条只读的审计路径。

`redactText` / `redactDeep` 是纯函数，几十处调用点；改返回值等于改所有调用点。所以加一个**可选的 sink 参数**：不传就是今天的行为，一个字节都不差，现有 46 条打码测试一行不用改。传了才顺手把「打掉了什么」和「为什么没打」报出去——和 `normalizeRecords` 里 `noteNoise` / `noteUsage` 一个路子。

审计**不搭在 `getSession` 的打码出口上，而是另走一条只读路径**。两个理由都是硬的：一是审计必须跑在**原始**会话上，在已经打过码的副本上审计什么都找不到；二是打码开关关着的时候审计最有价值（那正是要把原文分享出去的时刻），而出口那条路在开关关着时根本不会调 `redactSession`。所以 `library.auditSession()` 自己取原始会话、跑一遍带 sink 的 `redactSession`、**把打码结果扔掉只留报告**。代价是多跑一次打码（一个会话、几毫秒、只在点开面板时发生），换来的是 `listSessions` / `getSession` / 导出路径**一行都不用改**。

**Tech Stack:** 无新依赖。

**Spec:** [docs/design/2026-09-05-parity-and-shareability-design.md](docs/design/2026-09-05-parity-and-shareability-design.md) —— 第 4.1 节（遥测接缝）、第 4.2 节部分一「打了什么」与部分三「什么被判为不是密钥」、第七节 B1 行（验收：现有测试零改动；报告不含原值）。

## Global Constraints

- **报告绝不携带原值。** 设计文档里那条不可违背的约束：一个为打码而生的审计面板如果把它找到的密钥回显出来，它自己就是泄露口。落到实现上是一句可执行的话——`maskedContext` **只能从最终那份打过码的文本里切**，不许从任何中间态里切。第 1 到第 5 个阶段是顺序跑的，第 3 个阶段手上那份文本里，第 4、第 5 个阶段该打的码还没打。
- **审计结果不进任何导出产物。** B1 只做面板，`src/main/exporters/` 一行不改。汇总计数进报告是 B4 的事，到那时进去的也只有计数。
- **现有测试零改动。** 这是验收行的前半句，也是这一期形状的由来：`tests/redaction/redact.test.ts`（38 条）与 `tests/redaction/maskPaths.test.ts`（8 条）一个字符都不许改。改了就说明 sink 不是「可选」的。
- **`isSensitiveKey` 与 `shouldMaskValue` 的行为不许变。** 新增的两个「为什么没打」的函数是它们旁边的兄弟，不是它们的重写。一条测试专门钉住「说得出排除原因」⇒「确实没打码」这个蕴含关系，否则面板会开始解释一件没发生的事。
- **只有真的什么都没打，才算「被判为不是密钥」。** `{"author": "sk-live-…"}` 的键名确实没被当成敏感键名，但值照样被已知格式那条规则打掉了。这种情况报成「排除」是在撒谎。
- **不新增落盘文件。** 报告是点开面板时算出来的，算完就扔。它是审计，不是缓存——缓存下来就等于把「哪个会话里有几个密钥」这件事写进磁盘。
- **计数必须精确，样例可以截断。** 计数是一个整数加加，再多也不占内存；样例是字符串，按规则各留几条就够。截断了要在界面上说清，不许静默。
- 不改写任何原始会话文件；不引入网络；`tests/fixtures/` 里现有文件一个字节都不改（新增 fixture 可以）。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `src/shared/types.ts` | 改：新增 `KeptReason` / `RedactionHit` / `RedactionRuleGroup` / `RedactionKeptEntry` / `RedactionReport` |
| `src/shared/constants.ts` | 改：`REDACTION_*` 四个上限常量 |
| `src/shared/ipc.ts` | 改：`redaction:report` 一个方法（20 → 21） |
| `src/main/redaction/patterns.ts` | 改：新增 `SENSITIVE_HINT_PATTERN` 与 `keyKeptReason` / `valueKeptReason`；原有两个判定函数一行不改 |
| `src/main/redaction/redact.ts` | 改：五个阶段与 `redactDeep` 全部接可选 sink；`maskedContext` 从最终文本切 |
| `src/main/redaction/report.ts` | 新建：`RedactionSink` 接口、`createCollector()`、`scopedTo()`、`summarize()` |
| `src/main/library.ts` | 改：新增 `auditSession()` —— 取原始会话、带 sink 跑一遍、只留报告 |
| `src/main/ipc.ts` | 改：`redaction:report` 的 handler |
| `src/preload/api.ts` | 改：`auditRedaction` 一行 |
| `src/renderer/lib/redactionLabels.ts` | 新建：规则 id 与排除原因 → 中文说法（纯函数，可单测） |
| `src/renderer/components/RedactionReportDialog.tsx` | 新建：两段式面板 |
| `src/renderer/hooks/useAppStore.tsx` | 改：`redactionReport` 状态与 `auditRedaction` action |
| `src/renderer/pages/SessionsPage.tsx` | 改：导出按钮左边一个盾牌按钮；挂面板；点样例跳事件 |
| `tests/redaction/sink.test.ts` | 新建：不传 sink 时逐字节相同；六种 rule 各命中一次；kept 的五种原因 |
| `tests/redaction/reportSecrets.test.ts` | 新建：**验收**——整份报告序列化之后不含任何原值 |
| `tests/redaction/keptReason.test.ts` | 新建：排除原因与两个判定函数的蕴含关系 |
| `tests/library/auditSession.test.ts` | 新建：审计跑在原始会话上；开关关着也能审计；不落盘 |
| `tests/renderer/redactionLabels.test.ts` | 新建：六种 rule 与五种原因都有中文说法，没有兜底文案 |
| `tests/fixtures/redaction-audit.jsonl` | 新建：一个会话里塞齐六种命中与五种排除 |

---

### Task 1: 契约先行——报告长什么样，以及「为什么没打」这个问题谁来回答

报告要跨 IPC，所以数据形状进 `src/shared/types.ts`；`RedactionSink` 带方法、只在主进程里活，留在 `src/main/redaction/report.ts`。

这一任务真正的分量在后半段。今天 `isSensitiveKey` 只回答「是/否」，而面板要问的是「为什么否」——这是两个不同的问题，所以要两个新函数来答，且**原来那两个判定函数一个字符都不动**。

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/constants.ts`, `src/main/redaction/patterns.ts`
- Test: `tests/redaction/keptReason.test.ts`

**Interfaces:**

```ts
/** 键名或值为什么没被打码。每一条都对得上 patterns.ts 里的某一行。 */
export type KeptReason =
  | 'metric-name' // 键名是计数或配置：input_tokens、keyboard、monkey
  | 'name-not-matched' // 长得像敏感词，但词形不符：author 里的 auth
  | 'value-too-short' // 值不足 4 字符：源码里的 password: str
  | 'value-is-template' // 值是占位符或模板：<your-key>、{{TOKEN}}
  | 'value-not-secret' // 值是 true / false / 数字 / n-a 之类

export interface RedactionHit {
  /** `known-secret:openai` | `cookie-line` | `auth-scheme` | `cli-flag` | `key-value` | `sensitive-key` */
  rule: string
  keyName: string | null
  eventId: string | null
  /** 打码后的上下文片段。从最终文本里切，所以处处都是打过码的。 */
  maskedContext: string
}

export interface RedactionRuleGroup {
  rule: string
  /** 精确计数，不受样例上限影响。 */
  count: number
  /** 最多 `REDACTION_REPORT_MAX_SAMPLES` 条。`samples.length < count` 就是被截断了。 */
  samples: RedactionHit[]
}

export interface RedactionKeptEntry {
  keyName: string
  reason: KeptReason
  count: number
}

export interface RedactionReport {
  sessionId: string
  /** 打码开关当前是开还是关。关着时这份报告是「如果打开会打掉什么」的预演。 */
  redactEnabled: boolean
  totalHits: number
  /** 按 count 降序。 */
  groups: RedactionRuleGroup[]
  /** 按 count 降序，最多 `REDACTION_REPORT_MAX_KEPT` 条。 */
  kept: RedactionKeptEntry[]
  /** 不同键名太多，超过 `REDACTION_REPORT_MAX_KEPT_KEYS` 之后没再统计。 */
  keptTruncated: boolean
}
```

```ts
// patterns.ts 新增。宽松版：只要沾上敏感词就算「值得解释」，不管词形。
const SENSITIVE_HINT_PATTERN = /auth|token|key|secret|pass|pwd|cookie|credential|dsn/i

/** 键名为什么没被判为敏感。`null` = 它确实敏感，或者它跟敏感词毫无关系。 */
export function keyKeptReason(key: string): KeptReason | null

/** 值为什么没被打码。只在键名已经判为敏感时问这个。 */
export function valueKeptReason(value: string): KeptReason | null
```

**Steps:**

- [ ] **Step 1: 五个 `KeptReason`，每一个都指得出出处。** 写进 `src/shared/types.ts`，注释里写清它对应 `patterns.ts` 的哪一行判断：`metric-name` → `TOKEN_METRIC_PATTERN`；`name-not-matched` → `SENSITIVE_KEY_PATTERN` 那两个 `(?:^|[^a-z0-9])` 边界；`value-too-short` → `trimmed.length < 4`；`value-is-template` → `/^[[<({]/`；`value-not-secret` → `NON_SECRET_VALUE_PATTERN`。这五条加起来就是设计文档要的「可反驳」：用户看到 `author` 被排除，能自己去代码里对出是哪一条规则干的。

- [ ] **Step 2: 报告的五个类型。** 按上面的接口写进 `src/shared/types.ts`。`count` 与 `samples` 分开是有意的——计数精确、样例截断，这条在 Global Constraints 里，类型注释里再写一遍，免得后来的人以为 `samples.length` 就是命中数。

- [ ] **Step 3: 四个上限常量。** 写进 `src/shared/constants.ts`，每个都带上「为什么是这个数」：
  - `REDACTION_CONTEXT_LENGTH = 120`——比搜索片段的 160 短，因为这里是一个列表，一屏要放下好几条；
  - `REDACTION_REPORT_MAX_SAMPLES = 5`——同一条规则命中三百次时，看五条就够判断它是不是误伤，第六条起没有新信息；
  - `REDACTION_REPORT_MAX_KEPT = 30`——面板上一屏能读完的量；
  - `REDACTION_REPORT_MAX_KEPT_KEYS = 500`——统计的是不同键名的数量，超过就停下并置 `keptTruncated`。一个 JSON 里出现五百个不同的沾敏感词的键名，这份报告本身已经没法读了。

- [ ] **Step 4: `keyKeptReason`。** 顺序是有讲究的，四步：宽松命中不了就返回 `null`（这一条挡掉了库里几乎全部键名——`id`、`timestamp`、`content` 不是「被排除的敏感键名」，它们跟这件事无关，报出来会把面板灌满）；`TOKEN_METRIC_PATTERN` 命中 → `'metric-name'`；`isSensitiveKey` 为真 → `null`（它没被排除）；剩下的 → `'name-not-matched'`。

- [ ] **Step 5: `valueKeptReason`，注意它和 `shouldMaskValue` 的判断顺序不同。** `shouldMaskValue` 先看长度再看占位符，两个顺序结果一样、先看长度更省；这里必须**先看占位符**：一段被前面阶段截半的 `[已打码` 有 4 个字符、还以 `[` 开头，顺序反了就会被报成 `'value-is-template'`——那是在说「这个值是个模板变量」，而它其实是「这个值刚刚已经被打过码了」。已经打过码不是排除，返回 `null`。

- [ ] **Step 6: `tests/redaction/keptReason.test.ts`——蕴含关系。** 这个文件的重点不是逐条对答案，而是钉住两个函数之间的关系：备一张表（`author` / `keyboard` / `input_tokens` / `api_key` / `content` / `str` / `<your-key>` / `true` / `0` / `[已打码]` / 一个真密钥），对每一项断言 `keyKeptReason(k) !== null ⇒ !isSensitiveKey(k)`、`valueKeptReason(v) !== null ⇒ !shouldMaskValue(v)`。两个函数将来各自漂一点是必然的，漂出来的症状是面板解释一件没发生的事——这条断言让它在 CI 上先红。

- [ ] **Step 7: 设计文档里那四个例子逐个点名。** 同一个文件里再来四条：`author` → `'name-not-matched'`、`keyboard` → `'metric-name'`、`input_tokens` → `'metric-name'`、`str` → `'value-too-short'`。它们是设计文档 4.2 部分三亲自举的例子，测试里得能按名字找到。

---

### Task 2: 收集器——`RedactionSink` 与它的三个零件

先写收集器再改 `redact.ts`：接口的形状由「面板要什么」决定，而不是由「打码函数手上有什么」决定。

**Files:**
- Create: `src/main/redaction/report.ts`
- Test: 由 Task 3 的 `tests/redaction/sink.test.ts` 一起覆盖

**Interfaces:**

```ts
export interface RedactionSink {
  hit(hit: RedactionHit): void
  kept(keyName: string, reason: KeptReason): void
}

export interface RedactionCollector extends RedactionSink {
  /** 结账。分组、排序、截断都在这里做一次。 */
  summarize(sessionId: string, redactEnabled: boolean): RedactionReport
}

export function createCollector(): RedactionCollector

/**
 * 把一个 sink 绑到某条事件上。
 *
 * `redactText` 不知道自己在处理哪条事件，也不该知道——它的签名是设计文档钉死的
 * `(input, sink?)`。所以 `eventId` 由外面包一层塞进去：`redactSession` 遍历事件时
 * 给每条事件包一个，包出来的 sink 只多做一件事，就是把 `eventId` 填上。
 */
export function scopedTo(sink: RedactionSink, eventId: string): RedactionSink
```

**Steps:**

- [ ] **Step 1: 边分组边收，不先攒后分。** `createCollector` 内部是 `Map<string, {count, samples}>`：`hit()` 进来先给对应规则的 `count` 加一，只有 `samples.length < REDACTION_REPORT_MAX_SAMPLES` 时才 push。这样一个塞满 cookie 的百 MB 日志占的内存是 `规则数 × 5` 条片段，而不是几十万条命中。计数照样精确——这就是「计数精确、样例截断」那条约束的落地方式。

- [ ] **Step 2: `kept()` 按「键名 + 原因」聚合。** key 用 `${keyName}\u0000${reason}`（`\u0000` 不会出现在键名里，用 `:` 会和 `a:b` 这种键名撞）。同一个键名因为两种不同原因被排除是有意义的两条——`token` 可能因为值是数字被排除，也可能因为值是模板变量被排除。Map 到了 `REDACTION_REPORT_MAX_KEPT_KEYS` 就停止**新增**（已有的照样计数），并记一个内部 flag 供 `summarize` 读。

- [ ] **Step 3: `summarize` 只做三件事。** 分组按 `count` 降序（同 count 时按 `rule` 字典序，让输出可复现——一份每次打开顺序都不同的审计报告没法用来对比）；`kept` 同样降序后截到 `REDACTION_REPORT_MAX_KEPT`；`totalHits` 是所有 `count` 之和，不是 `groups.length`。`keptTruncated` 取 Step 2 那个 flag **或** `kept` 被 30 条截断——两种截断对用户是同一件事：「这里没列全」。

- [ ] **Step 4: `scopedTo` 不复制 `kept`。** 返回的对象里 `hit` 包一层填 `eventId`，`kept` 直接转发（排除原因不挂在事件上：同一个 `author` 在三十条事件里各出现一次，报三十条毫无用处，报「`author` × 30」才有用）。

- [ ] **Step 5: 一条注释交代清楚 `report.ts` 不 import `redact.ts`。** 依赖方向是 `redact.ts` → `report.ts`（拿接口），`library.ts` → 两边都拿。收集器要是自己去调 `redactSession`，这两个模块就成环了，而且审计路径的入口也就跑到了错误的层。

---

### Task 3: 让五个阶段说话——`redact.ts` 接可选 sink

这是整期风险最集中的一块：`redactText` 有 38 条测试压着，一个字节的行为变化都会亮红灯。所以顺序是**先加参数不改逻辑、跑一遍测试确认全绿，再往里填 sink 调用**。

**Files:**
- Modify: `src/main/redaction/redact.ts`
- Test: `tests/redaction/sink.test.ts`

**Interfaces:**

```ts
export function redactText(input: string, sink?: RedactionSink): string
export function redactDeep(value: unknown, keyHint?: string, depth?: number, sink?: RedactionSink): unknown
export function redactEvent(event: CodexEvent, sink?: RedactionSink): CodexEvent
export function redactSummary<T extends SessionSummary>(summary: T, sink?: RedactionSink): T
export function redactSession(session: CodexSession, sink?: RedactionSink): CodexSession
```

**Steps:**

- [ ] **Step 1: 先只加参数，一处都不用它。** 五个函数各加一个可选 `sink`，`redactSession` 往下传时给每条事件包 `scopedTo(sink, event.id)`（`sink` 为 `undefined` 时不包，传下去还是 `undefined`）。`redactDeep` 的第四个参数位置由设计文档钉死，所以内部递归调用要写全 `redactDeep(entry, key, depth + 1, sink)`，`redactEvent` 里那处变成 `redactDeep(event.raw, '', 0, sink)`。**做完这一步先跑 `pnpm test tests/redaction`，46 条必须全绿**——此时 sink 还没被调用过一次，绿是理所当然的，不绿说明参数加错了位置。

- [ ] **Step 2: `maskedContext` 的取法定下来：先攒后切。** 五个阶段的 replacer 里不直接调 `sink.hit`，而是往一个本地数组 push `{rule, keyName, maskedMatch}`——`maskedMatch` 是这个 replacer **返回的那个字符串**，所以它按定义就是打过码的。五个阶段全跑完、`text` 已是终稿之后，再拿每条 `maskedMatch` 去终稿里 `indexOf` 定位、切一段窗口出来 `sink.hit`。

  为什么不能在 replacer 里就地切：第 3 个阶段手上那份文本，第 4、5 阶段该打的码还没打。就地切一段 120 字符的窗口，很可能把隔壁一个还没轮到的密钥原样切进报告里——那正好是这一期最不能犯的错。

- [ ] **Step 3: `indexOf` 定位是「够用」而不是「精确」，把这件事写进注释。** 一个游标从左往右推，保证多条命中不会都指向同一处；从游标往后找不到就从头再找一次（后面的阶段可能把这段又改了一次，比如 Cookie 整行规则会把第 1 阶段刚打好的占位符一起吞掉）；再找不到就退化成只报 `maskedMatch` 自己。定位偶尔偏一处的后果是「上下文是另一处命中的邻居」，**而不是泄露**——因为终稿处处都是打过码的。这个安全性不依赖定位准不准，值得在注释里说明白。

- [ ] **Step 4: 六种 `rule` 的名字。** 第 1 阶段用 `known-secret:${name}`（`name` 就是 `TextPattern.name`，于是 `known-secret:openai`、`known-secret:jwt`——设计文档里举的 `known-secret:sk-` 是示意，实际取的是模式自己的名字）；第 2 到第 5 阶段是 `cookie-line` / `auth-scheme` / `cli-flag` / `key-value`；`redactDeep` 与 `redactStringValue` 里「键名敏感所以整个值换掉」的那三处是 `sensitive-key`。`keyName` 只有第 2、4、5 阶段和 `sensitive-key` 填得出来，第 1、3 阶段填 `null`（它们不看键名，这正是它们存在的理由）。

- [ ] **Step 5: `sensitive-key` 的 `maskedContext` 是合成的。** 那三处（`redactStringValue` 的打码路、`redactDeep` 里字符串值被换掉、以及对象值被整个换成占位符）没有「周围的文本」可切——值是被整个替换掉的。所以 `maskedContext` 合成成 `键名: [已打码]`。合成串里只有键名和占位符两样东西，原值进不去。

- [ ] **Step 6: 三个 `return match` 的 bail-out 变成 `kept`。** 第 3、4、5 阶段各有一处「值看着不像密钥所以不动」，第 5 阶段还多一处「键名不敏感所以不动」。分别调 `valueKeptReason` / `keyKeptReason`，拿到非 `null` 才报——`null` 的意思是「这不值得解释」，不是「没有原因」。

- [ ] **Step 7: `redactStringValue` 这一处要先看结果再决定报不报。** 它的 bail-out 会往下走 `redactText(value, sink)`，值可能在那里被别的规则打掉（`{"author": "sk-live-…"}` 就是这样）。所以顺序是：先跑 `redactText`，**只有结果和原值逐字节相同**、并且 `keyKeptReason(keyHint)` 说得出原因，才报 `kept`。否则面板会说「author 被判为不是密钥」，而那个值其实打掉了——这条在 Global Constraints 里。

- [ ] **Step 8: `redactDeep` 里数字与布尔那一处也报。** 键名判为敏感、值是 `0` 或 `true` 时今天原样返回（注释写着「它们是计数或开关，不是密钥」）。这正是设计文档要暴露的那类判断，报成 `'value-not-secret'`。

- [ ] **Step 9: 深度上限那一处不报。** `depth > REDACTION_MAX_DEPTH` 时对象换成 `DEPTH_LIMIT_PLACEHOLDER`，那既不是命中也不是排除，是「没往下看」。硬要报的话得再加一个 `KeptReason`，而它会在面板上和真正的排除混在一起，读起来像是「这里判过了」——它没判过。这一步是**明确地什么都不做**，理由写进注释。

- [ ] **Step 10: `tests/redaction/sink.test.ts` 第一条——不传 sink 就逐字节相同。** 拿一段塞齐六种命中的文本，断言 `redactText(text)` 与 `redactText(text, createCollector())` 的返回值 `toBe` 相等；`redactSession` 同样对一整个 fixture 会话做 `toEqual`。这条是验收行前半句「现有测试零改动」的正面表述：46 条老测试全绿只说明「没改坏」，这条说明「加了 sink 也不改结果」。

- [ ] **Step 11: 六种 rule 各自命中一次。** 一段文本里放 `sk-` 密钥、`Cookie:` 行、`Authorization: Bearer …`、`--token …`、`password: …`，加一个 `{"api_key": "…"}` 的 JSON。断言六个 rule 都在 `groups` 里出现、`totalHits` 对得上，并且**每条 `maskedContext` 都含占位符**。

- [ ] **Step 12: 五种 `KeptReason` 各自出现一次。** 同一份文本里放 `author: "some plain text"`、`input_tokens: 128`、`password: str = Field(min_length=6)`、`api_key: <your-key>`、`token: true`，断言 `kept` 里五种原因齐全，键名对得上。

- [ ] **Step 13: Cookie 吞掉占位符那一条边界。** `Cookie: session=sk-live-0OpQrStUvWxYz123456` 会被第 1 阶段打成 `Cookie: session=[已打码]`，再被第 2 阶段整行打成 `Cookie: [已打码]`——两条命中，终稿里只剩一个占位符。断言两条命中都在（一条 `known-secret:openai`、一条 `cookie-line`），且两条的 `maskedContext` 都不含密钥本体。这就是 Step 3 那个「从头再找一次」的退路要挡住的情况。

- [ ] **Step 14: `eventId` 确实落到了每条事件上。** 用一个多事件 fixture 跑 `redactSession(session, collector)`，断言样例里的 `eventId` 都能在 `session.events` 里按 id 找到；会话标题那条命中的 `eventId` 是 `null`（它不属于任何一步）。

---

### Task 4: 审计这条只读路径——`auditSession()`、第 21 条 IPC、preload 一行

**Files:**
- Modify: `src/main/library.ts`, `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/api.ts`
- Create: `tests/fixtures/redaction-audit.jsonl`
- Test: `tests/library/auditSession.test.ts`

**Interfaces:**

```ts
// library.ts —— 和 getSession 并排，但走的是另一条路
async auditSession(sessionId: string): Promise<RedactionReport | null>

// shared/ipc.ts —— 第 21 条
redactionReport: 'redaction:report'
// GleamApi 上多一个方法
auditRedaction(sessionId: string): Promise<RedactionReport | null>
```

**Steps:**

- [ ] **Step 1: 先造 fixture，因为它定义了「审计完整」是什么意思。** `tests/fixtures/redaction-audit.jsonl` 一个会话里塞齐六种命中与五种排除：标题里放一个 `sk-` 密钥（用来验 `eventId` 为 `null` 那条）、一条 shell 事件的 `command` 里放 `--token`、一条事件正文里放 `Cookie:` 整行与 `Authorization: Bearer`、`raw` 里放 `{"api_key": "…", "author": "…", "input_tokens": 128, "token": true, "api_key_hint": "<your-key>"}`、再放一段 `password: str = Field(min_length=6)` 的源码片段。密钥本体全部是假的，但**词形要真**——形状不对就绕过了 `KNOWN_SECRET_PATTERNS`，那时测试绿得毫无意义。现有 fixture 一个字节都不动，这是新增的。

- [ ] **Step 2: `auditSession` 取的是原始会话，和 `getSession` 用同一句表达式。** `const session = this.touch(sessionId) ?? (await this.loadRaw(sessionId))`——`touch` 返回的是缓存里那份**原始**会话，`getSession` 也是这么开头的，两者的区别全在后面：`getSession` 往下走打码与路径缩写并把结果交出去，`auditSession` 往下走带 sink 的打码、**把打码结果丢掉、只交报告**。`null` 照样返回 `null`（会话被忘记了或者文件没了）。

- [ ] **Step 3: 报告里的路径要跟界面上看到的一样。** 「显示完整路径」关着时，`getSession` 会对整个会话跑 `maskSessionPaths`；报告如果不做同一件事，面板上就会出现 `C:\Users\你的名字\…` 而列表和详情里全是 `~\…`。所以 `summarize` 出来之后，对每条 `maskedContext` 跑一遍 `maskHomePaths`——`maskPaths.ts` 里那个文本级的原语正是为这种场合留的。`keyName` 不用管（键名里不会有家目录）。

- [ ] **Step 4: `redactEnabled` 只是报告里的一个字段，不是审计的开关。** 从 `forDisplay()` 拿 `redact` 填进 `RedactionReport.redactEnabled`，**但审计照跑**。开关关着的时候这份报告的意思变成「你现在要分享的是原文，如果打开开关会打掉这些」——那正是最该看它的时刻。把它写进 `auditSession` 的注释里，否则后来的人极可能「顺手」给它加一个提前 return。

- [ ] **Step 5: IPC 第 21 条。** `src/shared/ipc.ts` 里加 `redactionReport: 'redaction:report'` 与 `GleamApi.auditRedaction`；`src/main/ipc.ts` 里一个 handler 转 `library.auditSession(sessionId)`；`src/preload/api.ts` 里一行 `invoke`。按现有 19 条 handler 的写法照抄，不要在这里发明新的错误处理。

- [ ] **Step 6: `tests/library/auditSession.test.ts` 第一条——审计跑在原始会话上。** 这是整条路径存在的理由，所以它得是第一条断言：把 `redactSensitive` 设成 `true`，先 `getSession` 一次（让缓存热起来、也让「已经打过码的副本」这个陷阱有机会出现），再 `auditSession`，断言 `totalHits > 0`。如果哪天有人把审计改成搭在 `getSession` 的出口上，这条会掉到 0——在一份已经打过码的会话上审计，什么都找不到。

- [ ] **Step 7: 第二条——开关关着也能审计，而且报告里说清了。** `redactSensitive: false`，断言 `getSession` 拿回来的正文里**密钥原文还在**（这正是开关关着的语义），而同一个会话的 `auditSession` 照样 `totalHits > 0` 且 `redactEnabled === false`。这条把 Step 4 那句注释钉成了测试。

- [ ] **Step 8: 第三条——不落盘。** 审计前后各列一次存储目录，断言文件名集合与每个文件的 `mtimeMs` 都没变。报告是算出来就扔的，「哪个会话里有几个密钥」这句话不该出现在磁盘上任何地方。

- [ ] **Step 9: 第四条——`null` 路径。** 一个不存在的 sessionId 返回 `null` 而不是抛异常，也不是一份 `totalHits: 0` 的空报告——空报告的意思是「这个会话很干净」，那是另一件事，面板上会显示成一句完全不同的话。

---

### Task 5: 面板——盾牌按钮、两段式对话框、点样例跳事件

界面上只有一个新入口：导出按钮左边一个盾牌。位置是设计文档指定的，它本身就是说明书——分享之前先看一眼。

**Files:**
- Create: `src/renderer/lib/redactionLabels.ts`, `src/renderer/components/RedactionReportDialog.tsx`
- Modify: `src/renderer/hooks/useAppStore.tsx`, `src/renderer/pages/SessionsPage.tsx`
- Test: `tests/renderer/redactionLabels.test.ts`

**Interfaces:**

```ts
// redactionLabels.ts —— 纯函数，所以能单测；界面上一个字都不许硬编码在 JSX 里
export function ruleLabel(rule: string): string
export function ruleHint(rule: string): string
export function keptReasonLabel(reason: KeptReason): string
```

**Steps:**

- [ ] **Step 1: 中文说法集中在一个纯函数文件里。** 六种 rule 各一个名字加一句解释（`known-secret:openai` → 「已知格式的密钥」+「OpenAI 的 `sk-` 开头的那种，按它自己的格式认出来的」）；`known-secret:` 前缀后面的部分是模式名，做成「已知格式的密钥 · openai」这样拼出来，将来 `KNOWN_SECRET_PATTERNS` 加一条不用改这里。五种 `KeptReason` 各一句人话，说的是**为什么**而不是规则名：`'name-not-matched'` → 「键名里有敏感词，但不是独立的词（比如 author 里的 auth）」。

- [ ] **Step 2: `tests/renderer/redactionLabels.test.ts`——不许有兜底文案。** 遍历六种 rule 与五种 `KeptReason`，断言每一个都拿到非空且互不相同的说法。**关键是最后一条**：断言一个不认识的 rule 拿到的不是「未知规则」这种兜底——`ruleLabel` 应该把 `known-secret:` 之后的部分原样拼出来，而其余六个是穷举的。一个会静默兜底的标签函数会让「加了新规则但忘了配文案」这件事在界面上看不出来。

- [ ] **Step 3: 面板分两段，中间那段留白给 B2。** 上半段「打掉了什么」：按 `groups` 一组一块，标题是 `ruleLabel` + 计数，下面是最多 5 条 `maskedContext`；`samples.length < count` 时在这一组末尾补一句「另有 N 处未列出」——截断了必须说出来，这在 Global Constraints 里。下半段「什么被判为不是密钥」：`kept` 一行一条，键名 + `keptReasonLabel` + 计数；`keptTruncated` 为真时同样补一句。两段之间不放任何占位块——B2 的残留排序进来时它自己会占一段，现在留个空框只是在承诺一件还没做的事。

- [ ] **Step 4: 顶上一句话说清这份报告的性质。** `redactEnabled` 为真：「分享出去的内容里，这些地方已经被替换成 `[已打码]`。」为假：「打码开关现在是关着的——下面这些内容会原样出现在分享出去的文件里。」第二句是这个面板最该说的话，所以它不能藏在角落里，得在最上面。

- [ ] **Step 5: `totalHits === 0` 是一句独立的话，不是一个空列表。** 「这个会话里没有认出任何密钥。」紧接一句诚实的限定：「这不等于它一定干净——认得出的只有已知格式和敏感键名这两类。」下半段照常显示（`kept` 往往非空，而且那正是「为什么一个都没打」的答案）。

- [ ] **Step 6: 样例可以点，点了跳到那一步。** `eventId` 非 `null` 时整条做成按钮，`onClick` 拿 `eventId` 去 `detail.events` 里 `findIndex`，然后调 `SessionHeader` 已有的 `onSelectIndex`，并关掉面板（跳过去了还挡着看不见）。`eventId` 为 `null`（会话标题、摘要里的告警）时不做成按钮——一个点了没反应的按钮比不做成按钮更差。找不到那条事件时也不做成按钮：会话可能已经被重新解析过了。

- [ ] **Step 7: 对话框骨架照 `ExportDialog.tsx` 抄。** 同一层遮罩、同一个 `role="dialog" aria-modal="true"`、同一个 Escape 关闭的 effect、同样的 `if (!open) return null`、同样的 `max-h-[60vh] overflow-y-auto` 正文。两个对话框长得不一样会让人以为它们的行为规则也不一样。

- [ ] **Step 8: store 里两个状态一个 action。** `redactionReport: RedactionReport | null` 与 `auditing: boolean`，action `auditRedaction(sessionId)` 调 `window.gleam.auditRedaction` 填进去。切换会话时清掉——上一个会话的报告留在那儿，是这一期最容易犯的展示型泄露（内容都是打过码的，但「几处命中」这个数字张冠李戴了）。

- [ ] **Step 9: 盾牌按钮。** `SessionHeader` 右侧那一簇里，`导出报告` 的**左边**加一个 `<Button icon={Shield}>` （`variant` 用默认的次要样式，不跟导出抢主按钮的位置），文案「打码报告」，`onClick` 里先 `auditRedaction` 再开面板。`auditing` 时按钮 `busy`。`detail` 为空时和导出按钮一样不显示。

---

### Task 6: 验收——报告不含原值

这一条是验收行的后半句，也是整期唯一一条「安全性」测试。它单独一个文件，理由和 A4 的 `tests/search/secrets.test.ts` 一样：一份专门检查泄露的测试不该和功能测试混在一起，混进去之后没人知道删掉某个 `it` 意味着什么。

**Files:**
- Test: `tests/redaction/reportSecrets.test.ts`

**Steps:**

- [ ] **Step 1: 一份 fixture，六个假密钥，逐个在整份报告里搜。** 用 Task 4 那个 fixture，跑 `auditSession`，把整份报告 `JSON.stringify` 之后对每个密钥本体断言 `not.toContain`。搜的是**序列化之后的整个字符串**而不是逐个字段——将来给报告加字段是必然的，加了之后这条测试自动覆盖到，不用有人记得回来改它。

- [ ] **Step 2: 密钥本体要足够长且形状够真。** 每个假密钥都得真的能被对应规则认出来（否则这条测试在验一件没发生的事），同时**本体不能短到会在别处偶然出现**——比如别拿 `abc123` 当密钥本体，`not.toContain('abc123')` 会因为一个无关的路径片段而挂掉，然后有人为了让它绿而放宽断言。

- [ ] **Step 3: 反面对照——报告里确实有内容。** 只断言「不含密钥」的测试，在 `auditSession` 返回一份空报告时也是绿的。所以同一个文件里必须有一条：`totalHits > 0`、`groups` 非空、每条 `maskedContext` 都含 `[已打码]`。这条和上一条合起来才叫「报告不含原值」；少了它就只是「报告是空的」。

- [ ] **Step 4: `kept` 那一半也搜一遍。** 「被判为不是密钥」这一段是新增的输出面，而且它的输入正是**没被打码的**那些值——最容易在这里把原值带出去。断言 `kept` 里每一条只有 `keyName` / `reason` / `count` 三个字段（`Object.keys` 逐条比对），键名之外没有任何来自值的文本。

- [ ] **Step 5: 顺带钉住「审计结果不进导出产物」。** 这一期 `src/main/exporters/` 一行不改，所以最省事也最可靠的断言是：导出一次，`not.toContain('redactionReport')`、`not.toContain('打掉了什么')`。B4 要往导出里加汇总计数时，会先撞到这条测试，那时它该被改成「只允许计数进去」——这正是我们希望那次改动被人看见的方式。

- [ ] **Step 6: `pnpm verify` 全绿，并确认 46 条老测试一个字符没改。** `git diff --stat tests/redaction/redact.test.ts tests/redaction/maskPaths.test.ts` 必须是空的。这是验收行前半句的字面检查，也是整期形状是否成立的最后一道证明。



