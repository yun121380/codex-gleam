# A4 · 跨会话搜索 实现计划

> 每个步骤用 `- [ ]` 标记，按任务顺序逐条实施、逐条勾掉。

**Goal:** 在 674 个会话里搜一句话，200 ms 内给出候选会话；点进去能跳到命中的那一步。搜索范围从"已加载的摘要"扩到"全部会话的全部文本"，而**索引只建在打码之后的文本上**——密钥搜不到是这个设计想要的结果，不是它的缺陷。

**Architecture:** 两层，中间隔着一个落盘的倒排表。

第一层在扫描过程里建。扫描时事件已经在内存里、算完摘要就被丢掉，顺手攒一份词条是零额外 I/O；攒好的倒排表存成 `LocalStore` 的第四个文件，生命周期完全挂在 `session-index.json` 上——`runScan` 已经算出了"哪些条目过期、哪些是本次新产出的"，搜索索引照抄这个结论，不自己判断文件的新旧。查询时先在倒排表里求交集，拿到候选会话 id，不解析任何文件。

第二层只在用户点开某个候选之后才跑：走现有的按需加载路径把那**一个**会话解析出来，在里面定位到具体事件、切出片段。`SESSION_CACHE_LIMIT = 3` 这个约束不变——第二层一次只碰一个会话。

四个新模块，边界按"知识只存一份"划：`tokenize.ts` 只认字符不认会话；`sessionText.ts` 是"哪些字段算可搜索文本"的**唯一定义处**，第一层和第二层都从它取，于是两层不可能对不上（第一层报命中、第二层找不到，在用户看来就是 bug）；`invertedIndex.ts` 管倒排表的建/并/裁/查；`locate.ts` 管第二层。

**Tech Stack:** 无新依赖。不引入分词库（中文 bigram 和 ASCII 整词是几十行的事），不引入 ripgrep（见下），不引入 SQLite/FTS（多一个原生模块，三平台打包成本远超收益）。

**Spec:** [docs/design/2026-09-05-parity-and-shareability-design.md](docs/design/2026-09-05-parity-and-shareability-design.md) —— 第 3.2 节（跨会话搜索）、第二节"存储与契约"（第四个文件、IPC 19→22）、第五节"没有数据就说没有"、第六节安全测试、第七节 A4 行（验收：674 会话下查询 < 200 ms；fixture 里的密钥搜不到）。

## Global Constraints

- **不许调 ripgrep，也不许调任何外部程序。** hindcast 那条路对我们结构性不可用：`tests/security/offline.test.ts` 扫整个 `src/`，禁 `child_process` / `spawn(` / `execFile(`。本期新增的四个模块自动落进那个测试的覆盖范围，一行都不许碰。
- **索引无条件建在打码后的文本上，不看 `redactSensitive` 开关。** 这是本期唯一一处主动接受的功能损失。理由是落盘：`session-index.json` 今天只有标题和路径，倒排表要装下全部文本，建在原文上就凭空造出一个今天不存在的泄露面。开关管的是"给界面看什么"，管不到"往磁盘写什么"。
- **生命周期完全挂在 `session-index.json` 上，不自己判断文件新旧。** `runScan` 已经把"哪些条目过期"这件事算得很细（`provablyGone` 那一套：目录读不动、深度调低、体积超限都不算已删除）。搜索索引再算一遍必然算出不一样的结论，然后是两份记忆各自过期。
- **取消扫描时绝不删索引。** 与 `staleIds` 那段的判据同一个：中途取消时信息不完整，宁可留着旧的。
- **索引没了就说没了，降级为只搜标题。** 不阻塞界面、不弹错误对话框、不假装搜过全文——降级时必须在搜索框下面写清楚"这次只搜了标题"，否则用户拿"搜不到"当"不存在"。
- **超预算时丢词要丢得可解释。** 预算 ~30 MB。丢的是 df 最高的那些词（出现在几百个会话里的词筛不掉任何东西，却占最多篇幅），不是随机丢、不是按字母序丢；丢了多少条要记进文件，界面据此说明"结果可能不全"。
- **第二层一次只碰一个会话。** 不能为了"顺手把前 8 个候选都定位好"而连解析 8 个文件——那既毁掉 200 ms，也毁掉内存里最多 3 个完整会话这条约束。
- 不改写任何原始会话文件；不引入网络；`tests/fixtures/` 里现有文件一个字节都不改（新增 fixture 可以）。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `src/shared/types.ts` | 改：`AppSettings.buildSearchIndex`；新增 `SearchIndexFile` / `SearchRequest` / `SearchResponse` / `SearchHit` / `SearchTermExpansion` |
| `src/shared/constants.ts` | 改：`DEFAULT_SETTINGS` 补开关；`PRIVACY_POINTS` 多一条讲索引建在打码后的文本上；`SEARCH_*` 预算与上限常量 |
| `src/shared/validators.ts` | 改：`normalizeSettings` 认 `buildSearchIndex`；新增 `normalizeSearchRequest` |
| `src/shared/ipc.ts` | 改：`sessions:search` 一个方法（19 → 20） |
| `src/main/search/tokenize.ts` | 新建：字符级分词。ASCII 整词 + 中文 bigram，只认字符不认会话 |
| `src/main/search/sessionText.ts` | 新建：**"哪些字段算可搜索文本"的唯一定义处**，两层都从这里取 |
| `src/main/search/invertedIndex.ts` | 新建：倒排表的建 / 增量并 / 超预算裁 / 词条扩展 / 求交集 |
| `src/main/search/locate.ts` | 新建：第二层。在一个已解析的会话里定位事件、切片段、标高亮区间 |
| `src/main/storage/store.ts` | 改：第四个文件 `search-index.json`，走同一套 `enqueue` + `writeJsonAtomic` + 缺字段补默认值 |
| `src/main/library.ts` | 改：扫描时攒词条、按 `staleIds` / `produced` 增量并、`clearIndex` 清、开关关掉立刻清；新增 `searchSessions()` |
| `src/main/ipc.ts` | 改：`sessions:search` 的 handler |
| `src/preload/api.ts` | 改：`searchSessions` 一行 |
| `src/renderer/hooks/useAppStore.tsx` | 改：`searchQuery` / `searchResult` 状态 + `search` action（防抖在这里） |
| `src/renderer/components/SessionList.tsx` | 改：现有搜索框升级成跨会话搜索，下面一行说清搜到了什么、有没有降级 |
| `src/renderer/pages/SessionsPage.tsx` | 改：进入会话后取该会话的命中，`命中 N 处 ‹ ›` 步进器跳 `cursor` |
| `src/renderer/pages/SettingsPage.tsx` | 改：建索引开关 + 索引体积/丢词的说明 |
| `tests/search/tokenize.test.ts` | 新建：中英混排、`ENOENT` / `TS2345` / `node_modules` 整词、bigram、长词丢弃 |
| `tests/search/invertedIndex.test.ts` | 新建：建表、求交集、词条扩展三档、超预算裁词、往返序列化、版本迁移、坏文件降级 |
| `tests/search/secrets.test.ts` | 新建：**`sk-` 形态伪造密钥搜不到**，且序列化后的文件里没有任何词条含它 |
| `tests/search/locate.test.ts` | 新建：片段切法、高亮区间、命中顺序、短语精确匹配 |
| `tests/search/scale.test.ts` | 新建：674 个合成会话，第一层查询 < 200 ms |
| `tests/library/searchLifecycle.test.ts` | 新建：增量复用、文件改动、文件删除、**取消扫描不删索引**、`clearIndex` 清空、开关关掉不落盘 |
| `tests/storage/store.test.ts` | 改：第四个文件的读写与缺字段补默认值 |
| `tests/shared/validators.test.ts` | 改：`buildSearchIndex` 的默认值与 `normalizeSearchRequest` |
| `tests/fixtures/search-secret.jsonl` | 新建：带伪造密钥的会话（新增 fixture，不动现有的） |

---

### Task 1: 契约先行——落盘格式、请求响应、那个开关

先把类型钉死。倒排表要落盘，落盘的东西改一次就得管一次旧文件，所以格式要在写第一行逻辑之前定下来。

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/constants.ts`, `src/shared/validators.ts`
- Test: `tests/shared/validators.test.ts`

**Interfaces:**
- Consumes: 现有 `AppSettings` / `SessionSummary` / `normalizeSettings`
- Produces: `SearchIndexFile`（Task 3、4 用）、`SearchRequest` / `SearchResponse` / `SearchHit`（Task 6、7、8 用）、`settings.buildSearchIndex`（Task 5 用）

- [ ] **Step 1: 定倒排表的落盘格式。** 写进 `src/shared/types.ts`——它和 `SessionSummary` 一样是"持久化契约"，放在一起才找得到：

```ts
/**
 * 落盘的倒排表。
 *
 * postings 存的是 `sessionIds` 里的下标，不是会话 id 本身：674 个会话、
 * 每个 id 36 字符，一个高频词的 postings 就要 24 KB；换成下标是 1—3 个字符。
 * 代价是增量更新时要做一次下标重映射（Task 3 的 mergeIndex）。
 *
 * 这里没有正向索引（会话 → 词）。删一个会话时不需要它：直接扫一遍倒排表、
 * 把指向它的下标抹掉即可。多存一份就多一份会过期的记忆。
 */
export interface SearchIndexFile {
  /** 格式版本。对不上就整份丢掉重建，不做逐版本迁移——它随时能从原始文件重建。 */
  version: number
  /** 会话 id，postings 里的下标指向这里。 */
  sessionIds: string[]
  /** 词 → 出现过这个词的会话下标，升序、无重复。 */
  terms: Record<string, number[]>
  /** 超预算被丢掉的词条数。> 0 时界面要说"结果可能不全"。 */
  droppedTerms: number
  /** 建成时间，ISO 字符串。只用于界面展示，不参与失效判断。 */
  builtAt: string
}
```

- [ ] **Step 2: 定请求与响应。** 一个 IPC 方法要同时服务两层，用 `sessionId` 有没有来区分——这样第二层不可能被误当成第一层批量调用：

```ts
export interface SearchRequest {
  query: string
  /**
   * 给了就是第二层：只在这一个会话里定位，会解析这个文件。
   * 不给就是第一层：只查倒排表，不碰任何文件，这是 < 200 ms 的那条路。
   */
  sessionId?: string
  /** 候选会话数上限，默认 50。 */
  limit?: number
}

export interface SearchHit {
  sessionId: string
  eventId: string
  /** 事件在 `session.events` 里的下标，界面直接拿它设 cursor。 */
  eventIndex: number
  eventType: CodexEventType
  /** 已打码、已裁剪的上下文片段。 */
  snippet: string
  /** 片段里要高亮的区间，[起, 止)，相对 snippet 的下标。 */
  ranges: Array<[number, number]>
}

export interface SearchResponse {
  query: string
  /** 实际参与检索的词条（扩展之后）。界面可以据此解释"为什么这条也算命中"。 */
  terms: string[]
  /** 第一层结果：候选会话 id，按现有排序键（新的在前）。 */
  sessionIds: string[]
  /** 第二层结果。第一层查询时是空数组。 */
  hits: SearchHit[]
  /** 走了降级路径（索引缺失 / 损坏 / 开关关着 / 词全被丢）。 */
  degraded: boolean
  /** 降级或结果可能不全时给用户的一句话；正常时为 null。 */
  notice: string | null
}
```

- [ ] **Step 3: 常量进 `src/shared/constants.ts`。** 每个都写清为什么是这个数：

```ts
/** 倒排表格式版本。改了分词规则就得 +1，否则新老词条混在一张表里。 */
export const SEARCH_INDEX_VERSION = 1

/**
 * 倒排表体积预算。设计稿给的 ~30 MB：现有 session-index.json 在 674 个会话下
 * 是 2.6 MB，全文倒排比它大一个量级是正常的，再大就该问用户要不要建了。
 */
export const SEARCH_INDEX_BUDGET_BYTES = 30 * 1024 * 1024

/** 单个词条最长 48 字符。更长的是哈希、base64、data URI——搜不到它们没有损失。 */
export const SEARCH_MAX_TERM_LENGTH = 48

/** 纯数字词条最长 8 位。再长的是时间戳和行号，进索引只占地方。 */
export const SEARCH_MAX_NUMERIC_LENGTH = 8

/** 单个字段进索引前截到 64 KB。一次 cat 大文件的输出全切成词条毫无检索价值。 */
export const SEARCH_MAX_FIELD_LENGTH = 64 * 1024

/** 查询时一个词最多扩展成多少个词条。防止搜 "a" 把整张表拖出来。 */
export const SEARCH_MAX_EXPANSION = 64

/** 短于这个长度的查询词不做子串扩展（见 Task 4 Step 5，被一次真实误召回逼出来的）。 */
export const SEARCH_MIN_SUBSTRING_LENGTH = 3

/** 第一层默认返回多少个候选会话。 */
export const SEARCH_DEFAULT_LIMIT = 50

/** 查询串长度上限。再长的查询没有意义，只会让扩展炸开。 */
export const SEARCH_MAX_QUERY_LENGTH = 200

/** 片段长度上限。够看清一行代码或一句话，不够就点进去看。 */
export const SEARCH_SNIPPET_LENGTH = 160

/** 一个会话最多返回多少处命中。第二层的上限，防止一个巨型会话把响应撑爆。 */
export const SEARCH_MAX_HITS_PER_SESSION = 200
```

- [ ] **Step 4: `AppSettings` 加开关，`DEFAULT_SETTINGS` 默认开。** 默认开是因为不建索引就搜不了全文，而搜索是这一期的全部价值；关掉的理由只有一个——不想让这份文本落盘：

```ts
/** 建全文搜索索引。关掉后搜索降级为只搜标题，且磁盘上不留这份文本。 */
buildSearchIndex: boolean
```

- [ ] **Step 5: `normalizeSettings` 认这个字段。** 照 `store.ts` 里 `withDefaults` 的规矩：**逐字段补**，不能"有一个字段就整体当合法"。旧设置里没有 `buildSearchIndex`，补 `true`。

- [ ] **Step 6: `normalizeSearchRequest`。** 查询串来自 IPC，得当外部输入对待：截到 200 字符（再长的查询没有意义，只会让扩展炸开）、`limit` 夹到 `[1, 200]`、`sessionId` 只认非空字符串否则当没给。

- [ ] **Step 7: 补 `tests/shared/validators.test.ts`。** 三条：旧设置缺 `buildSearchIndex` 补成 `true`；给了 `false` 原样保留（不能被"看起来像默认值"的逻辑改回来）；`normalizeSearchRequest` 把超长查询截断、把 `limit: 0` 夹到 1、把空串 `sessionId` 当没给。

---

### Task 2: 分词——`src/main/search/tokenize.ts`

这一个模块只认字符，不认会话、不认设置、不碰文件系统。它是整期最热的循环（674 个会话的全部文本都要过一遍），所以按字符码扫，不用正则回溯。

**Files:**
- Create: `src/main/search/tokenize.ts`
- Test: `tests/search/tokenize.test.ts`

**Interfaces:**
- Consumes: `SEARCH_MAX_TERM_LENGTH` / `SEARCH_MAX_NUMERIC_LENGTH`
- Produces: `tokenize(text): string[]`、`parseQuery(text): ParsedQuery`——Task 3 建表和查表都用它，Task 6 定位也用它。**两边必须是同一个函数**，否则建表时切成一种、查表时切成另一种，就成了永远搜不到。

- [ ] **Step 1: ASCII 侧按"标识符"切，一次扫完。** 规格点名要求 `ENOENT`、`TS2345`、`node_modules` 能整词搜到，所以下划线和数字**属于词的一部分**，不是分隔符：

```ts
/** 组成 ASCII 词条的字符：字母、数字、下划线。 */
function isWordChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f // _
  )
}
```

`node_modules` 切出 `node_modules` 一个词，不是 `node` + `modules`；`TS2345` 切出 `TS2345`，不是 `TS` + `2345`。代价是搜 `modules` 搜不到 `node_modules`——这个由查询时的扩展补上（Task 3 Step 5），不在这里存子串：存子串会让表膨胀好几倍，而且"为什么搜 `de` 能搜到 `node_modules`"没法向用户解释。

- [ ] **Step 2: 中文侧走 bigram。** 相邻两字一组，`离线自检` → `离线` / `线自` / `自检`。单字成段（比如夹在英文里的一个"的"）就出这一个字：

```ts
/** 需要按 bigram 切的字符：中日韩表意文字与假名。 */
function isIdeograph(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 平假名、片假名
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
    (code >= 0xac00 && code <= 0xd7af) // 谚文
  )
}
```

不做真正的分词（不引词典、不引库）：bigram 在"能不能筛掉 99% 的会话"这件事上够用，而第二层还会做一次精确匹配，误召回在那里被挡掉。

- [ ] **Step 3: 中英混排靠"字符类别一变就断词"自然处理。** `修复ENOENT错误` 切出 `enoent` 和 `修复` / `错误`——不需要为混排写任何特殊分支，扫到类别边界就收尾当前词。ASCII 词条统一小写（搜 `enoent` 要能命中日志里的 `ENOENT`）；中文没有大小写，原样留。拉丁扩展、希腊、西里尔字母跟 ASCII 走同一套（整词、转小写，`café` 是一个词），但只列**字母区**——全角标点、弯引号、emoji 都得留在分隔符那一侧，不能图省事写成"凡是非 ASCII 非表意文字都算词"。

- [ ] **Step 4: 丢掉没有检索价值的长词条。** 超过 `SEARCH_MAX_TERM_LENGTH`（48）的丢，纯数字超过 `SEARCH_MAX_NUMERIC_LENGTH`（8）位的丢。理由分别是：

  - 48 字符以上的连续标识符，实际上只有哈希、base64、data URI、minified 代码——搜不到它们没有损失，而它们能把倒排表撑到几百 MB。
  - 8 位以上的纯数字是时间戳（`1756382400000`）和行号偏移，谁也不会去搜；但 `2345` 得留着（`TS2345` 已经是一个词，`4004` 这样的端口号也有人搜）。

  **这条规则不能被当成安全措施。** 密钥搜不到靠的是 Task 3 里的打码，不是靠"密钥太长被丢了"——所以 `tests/search/secrets.test.ts` 里的伪造密钥本体必须短于 48 字符（Task 3 Step 6），否则那个测试会因为错误的原因通过。

- [ ] **Step 5: `parseQuery` 与 `tokenize` 共用同一条扫描。** 差别只有一处：查询侧要知道用户是不是打了引号（短语搜索），所以额外返回原始短语串给第二层做精确匹配。实现上让 `tokenize` 做纯粹的切词，`parseQuery` 包一层：

```ts
export interface ParsedQuery {
  /** 参与倒排求交集的词条，已去重。 */
  terms: string[]
  /** 引号里的原文，第二层据此做精确匹配；没有引号时为 null。 */
  phrase: string | null
}
```

- [ ] **Step 6: 写 `tests/search/tokenize.test.ts`。** 规格点名的三个必须各有一条：

```ts
it('整词保留标识符与错误码', () => {
  expect(tokenize('rm 之后报 ENOENT')).toContain('enoent')
  expect(tokenize('error TS2345: 类型不匹配')).toContain('ts2345')
  expect(tokenize('删掉 node_modules 重装')).toContain('node_modules')
  // 反面：不能被下划线和数字切碎
  expect(tokenize('node_modules')).not.toContain('node')
  expect(tokenize('TS2345')).not.toContain('2345')
})

it('中文切成相邻 bigram', () => {
  expect(tokenize('离线自检')).toEqual(['离线', '线自', '自检'])
})

it('中英混排在类别边界断词', () => {
  const terms = tokenize('修复ENOENT错误')
  expect(terms).toContain('enoent')
  expect(terms).toContain('修复')
  expect(terms).toContain('错误')
})
```

再加：单字中文成词；ASCII 统一小写；48 字符以上的哈希被丢；13 位时间戳被丢而 `4004` 保留；空串与纯标点返回空数组（不是 `['']`——空词条会成为一个匹配所有会话的条目）。

---

### Task 3: 可搜索文本的唯一定义处——`src/main/search/sessionText.ts`

**这个模块存在的唯一理由是"知识只存一份"。** 第一层决定往索引里放什么，第二层决定在会话里搜哪些字段——这两件事必须是同一份定义。分开写的话，某天有人给第一层加了 `toolName` 而忘了第二层，用户看到的现象是：搜索列出了这个会话，点进去一个命中都没有，还带一句"命中 0 处"。那不是"没搜到"，那是 bug。

**Files:**
- Create: `src/main/search/sessionText.ts`
- Test: 由 `tests/search/secrets.test.ts` 与 `tests/search/locate.test.ts` 覆盖（这个模块单独测没有意义，它的正确性就是"两层一致"）

**Interfaces:**
- Consumes: `CodexSession` / `CodexEvent` / `SessionSummary`、`redactText`（`src/main/redaction/redact.ts`）
- Produces: `sessionTextFields(summary)`、`eventTextFields(event)`——Task 4 建表用，Task 6 定位用

- [ ] **Step 1: 定"一段可搜索文本"的形状。** 带上它从哪儿来，第二层才能把命中指回具体字段：

```ts
export interface TextField {
  /** 字段来源，界面上用来说明"命中在命令里"还是"在输出里"。 */
  label: string
  /** 已经打过码的文本。 */
  text: string
}
```

- [ ] **Step 2: 会话级字段。** 标题、项目名、日志文件名（`ENOENT` 那种搜法之外，很多人是记得文件名的）、agent 的昵称与线程 id。这些进倒排表时归到会话本身，第二层不用它们定位事件。

- [ ] **Step 3: 事件级字段，逐个字段列，不做"整个对象 JSON.stringify"。** 要进索引的：

  - `title`、`content`——正文，大头。
  - `command`——搜命令是最常见的用法之一。
  - `toolName`、`relatedFiles`（原始路径与显示路径都进，因为用户可能记的是 `~/…` 那个形态）。
  - `fileChanges[].path`、`fileChanges[].diff`——改了哪个文件、改了什么。
  - `test.failures[].name`、`test.failures[].message`——失败的测试名是高价值检索词。

  **明确不进索引的：**

  - `raw`——它是上面所有字段的原始 JSON，进索引等于把整个索引翻一倍，换来的只有"能搜到 JSON 键名"。
  - `fileChanges[].before` / `after`——整份文件内容，是体积第一大户，而它的有效信息已经在 `diff` 里。
  - `id` / `callId` / `parserId` / `sourceLine`——机器标识，没人搜。

- [ ] **Step 4: 每个字段都过 `redactText`，无条件。** 不读 `settings.redactSensitive`：

```ts
/**
 * 一条可搜索文本 = 打过码的那一份。
 *
 * 这里刻意不接受"要不要打码"这个参数——不给调用方留选择，就不会有人在
 * 某条路径上忘了打。索引是要落盘的，而 redactSensitive 那个开关管的是
 * "给界面看什么"，管不到"往磁盘写什么"。
 */
function field(label: string, value: string | null | undefined): TextField | null {
  if (value === undefined || value === null || value === '') return null
  const text = redactText(value)
  return text === '' ? null : { label, text }
}
```

逐字段调 `redactText` 与整份走 `redactEvent` 的结果是一样的（`redactEvent` 对这些字段做的正是这件事），但不用为了打码复制一份完整会话——扫描时内存里已经有 674 个会话的量在流动，能少复制一份就少一份。

- [ ] **Step 5: 单个字段设长度上限。** 一次 `cat` 大文件的输出可以是几 MB，全切成词条塞进倒排表毫无意义（那些词几乎出现在每个会话里，筛不掉任何东西）。取前 64 KB，并在注释里写清这是**索引侧**的截断，界面展示不受影响。

---

### Task 4: 倒排表——`src/main/search/invertedIndex.ts`

建、增量并、超预算裁、查。四件事一个文件，因为它们共用同一份"postings 是下标"的表示，拆开会把这份表示暴露成模块间契约。

**Files:**
- Create: `src/main/search/invertedIndex.ts`
- Test: `tests/search/invertedIndex.test.ts`, `tests/search/secrets.test.ts`, `tests/search/scale.test.ts`

**Interfaces:**
- Consumes: `tokenize` / `tokenizeQuery`（Task 2）、`sessionTextFields` / `eventTextFields`（Task 3）、`SearchIndexFile` 与各常量（Task 1）
- Produces: `collectTerms(session)`、`emptyIndex()`、`mergeIndex(...)`、`readIndexFile(value)`、`queryIndex(index, parsed)`——Task 5 建与并、Task 6/7 查

- [ ] **Step 1: `collectTerms(session): Set<string>`。** 一个会话进、一份去重词条出。扫描过程里对每个会话调一次，事件还在内存里的那一刻调，调完事件就可以丢：

```ts
export function collectTerms(session: CodexSession): Set<string> {
  const terms = new Set<string>()
  for (const { text } of sessionTextFields(session)) {
    for (const term of tokenize(text)) terms.add(term)
  }
  for (const event of session.events) {
    for (const { text } of eventTextFields(event)) {
      for (const term of tokenize(text)) terms.add(term)
    }
  }
  return terms
}
```

只存"这个词在这个会话里出现过"，不存词频、不存位置。位置由第二层现算——存位置会让索引大一个量级，而它只在用户真的点进去的那一个会话里有用。

- [ ] **Step 2: `mergeIndex` 做增量，并且只接受 `runScan` 给的结论。** 签名刻意长，把三样东西都要过来，不自己猜：

```ts
export function mergeIndex(input: {
  /** 上一次的表；没有就传 emptyIndex()。 */
  previous: SearchIndexFile
  /** 本次要移除的会话 id（library 那边算出来的 staleIds）。 */
  removed: ReadonlySet<string>
  /** 本次新产出的会话 id → 词条。 */
  added: ReadonlyMap<string, ReadonlySet<string>>
  /** 建成时间，由调用方传进来（这一层不读时钟，测试才能钉住结果）。 */
  builtAt: string
}): SearchIndexFile
```

- [ ] **Step 3: 下标重映射一次扫完。** 先算 `sessionIds` 的新数组（保留没被移除的、按原顺序，再接上新增的），同时得到 `旧下标 → 新下标` 的映射；然后一遍过倒排表：每个 postings 数组把旧下标换成新下标、丢掉映射到"已移除"的，空了的词条整条删掉。最后把 `added` 里的词条并进去。

  复杂度是 O(词条数 + 总 postings 长度)，与"有多少个会话变了"无关——674 个会话里改了 1 个也要走一遍全表。这是可以接受的：一次全表重映射在 30 MB 量级是几十毫秒，而它换来的是**不需要正向索引**，也就不需要维护第二份会过期的记忆。

- [ ] **Step 4: 超预算时丢 df 最高的词。** 体积用算术估，不能靠 `JSON.stringify` 之后量长度——那要求内存里先存在一份 30 MB 的字符串：

```ts
/**
 * 估算落盘体积。每个词条大约是：引号 + 词 + 冒号 + 中括号 + postings。
 * postings 里每个下标平均 4 个字符（674 会话最多 3 位数 + 逗号）。
 * 只要估得稳定、单调，就够用来决定丢哪些词——它不需要精确。
 */
function estimateBytes(terms: Record<string, number[]>): number
```

超了就按 **document frequency 从高到低** 丢，直到进预算。为什么是最高 df：一个出现在 600 个会话里的词，用它检索等于没检索（返回 89% 的库），但它的 postings 是最长的——丢掉它省最多的空间、损失最少的检索能力。反过来，只出现在 1 个会话里的词才是搜索真正有用的那部分。

同 df 的按词长倒序丢（长词更可能是噪声）。丢掉的条数累加进 `droppedTerms`，界面据此说"结果可能不全"。**绝不静默丢弃**。

- [ ] **Step 5: 查询时扩展词条，分三档、短路。** 用户打的词和索引里的词常常不完全一样（搜 `modules` 而表里是 `node_modules`），所以扩展；但扩展必须可解释、有上限：

  1. **完全命中**：`terms[word]` 存在 → 就用它，不再扩展。精确匹配优先，这样搜 `test` 不会因为扩展出 `test_helper` 而把结果搅乱。
  2. **前缀命中**：没有完全命中时，取所有以它开头的词条（搜 `enoen` 命中 `enoent`）。
  3. **子串命中**：还是没有，取所有含它的词条（搜 `modules` 命中 `node_modules`）。

  每档都按 `SEARCH_MAX_EXPANSION`（64）截断，**短的优先**——短词条离用户打的那个更近。

  **第 3 档另有一条下限：`SEARCH_MIN_SUBSTRING_LENGTH`（3）。** 比这个短的词只走前两档。这条线是实现时被一次真实的误召回逼出来的：搜 `sk` 时子串扩展命中了 `desktop`（de-**sk**-top，来自 fixture 的绝对路径），于是"搜密钥搜不到"那条断言变成了"搜密钥能搜到那个会话"。两个字符的针在任何一张真实词表里都能扎到一堆词，而"最短的 64 个"这个截断会让命中看起来完全随机。前两档不设这条线——`以 sk 开头` 还能向用户解释，`中间某处有 sk` 不能。

  中文 bigram 恰好两个字符，所以它们永远走不到第 3 档。但**它们会走到第 2 档**：`部署构建` 切出 部署 / 署构 / 构建，中间那个横跨两个词，任何真实文本里都没有，于是必然铺一次词表。这是常态而不是例外，所以那条路自己就得在预算内（实测 674 会话、四万词条下约 8 ms，见 `tests/search/scale.test.ts`）。

- [ ] **Step 6: 求交集，短的先来。** 多个词之间是 AND（搜"离线 自检"要的是两个都提到的会话）。先按 postings 长度升序排，用最短的那个当基底逐个求交，一旦交集空就立刻返回——这让"一个罕见词 + 一个常见词"的查询快得像只查了那个罕见词：

```ts
export function queryIndex(index: SearchIndexFile, parsed: ParsedQuery): {
  sessionIds: string[]
  /** 实际参与检索的词条，回给界面。 */
  terms: string[]
  /** 有词一个都没扩展出来（打错字、或那个词被预算裁掉了）。 */
  unmatched: string[]
}
```

某个词一档都没扩展出来时，**不能悄悄把它当不存在**（那会变成"搜两个词实际只搜了一个"），要么整个查询返回空、要么把它记进 `unmatched` 让界面说清"『xxx』没有出现在索引里"。取后者。

**但 `unmatched` 里会混进用户没打过的词。** 中文查询的跨词 bigram（`部署构建` 里的 `署构`）必然落进来，把它原样念给用户听是句胡话——那个"词"是分词器造的。Task 9 显示时要过一遍：只显示在原始查询串里能原样找到的那些。这件事放在渲染层是因为只有那里还留着用户打的原文；这一层只管把事实报全。

- [ ] **Step 7: `readIndexFile(value)` 把外部数据当外部数据。** 磁盘上的文件可能是旧版本、可能被截断、可能被别的进程写坏。逐字段校验，任何一处对不上就返回 `null`（调用方据此走降级），**不做半信半疑的修补**——一张缺了一半 postings 的倒排表比没有表更糟，它会让搜索静默地漏结果。`version` 不等于 `SEARCH_INDEX_VERSION` 也返回 `null`：这份文件随时能从原始会话重建，不值得为它写迁移代码。

- [ ] **Step 8: 写 `tests/search/invertedIndex.test.ts`。** 覆盖：建表后能按词查到会话；两个词求交集只返回都含的那个；扩展三档各一条（完全命中不再扩展、前缀命中、子串命中）；`unmatched` 在词不存在时被填上；`mergeIndex` 移除一个会话后没有任何 postings 还指向它（**遍历整张表断言**，不是只查一个词）；`mergeIndex` 新增会话时旧会话的命中不变；超预算时先丢 df 最高的词、`droppedTerms` 记数正确、剩下的表仍可正常查；`readIndexFile` 对版本不符 / 缺字段 / postings 不是数字数组 / 下标越界这四种坏数据都返回 `null`。

- [ ] **Step 9: 写 `tests/search/secrets.test.ts`——这一期的关键断言。** 新增 `tests/fixtures/search-secret.jsonl`，里面一条用户消息含一个 `sk-` 形态的伪造密钥。密钥本体要**短于 48 字符**，否则测试会因为"词太长被分词丢掉"而通过，那是错误的理由：

```ts
// 形态匹配 KNOWN_SECRET_PATTERNS 里的 openai 那条，本体 24 字符——
// 短于 SEARCH_MAX_TERM_LENGTH，所以它进不了索引只能是因为被打了码。
const FAKE_KEY = 'sk-live-0OpQrStUvWxYz123456'

it('索引里搜不到密钥', () => {
  const index = buildFrom(sessionWith(FAKE_KEY))

  // 一、搜它搜不到任何会话
  expect(queryIndex(index, parseQuery(FAKE_KEY)).sessionIds).toEqual([])

  // 二、整张表里没有任何词条含它的本体——这条才是真正的断言，
  //     前一条只能证明"查不到"，这一条证明"没写进去"。
  const body = FAKE_KEY.slice('sk-live-'.length).toLowerCase()
  for (const term of Object.keys(index.terms)) {
    expect(term).not.toContain(body)
  }

  // 三、同一条消息里的正常文本照样能搜到——证明这个会话确实被索引了，
  //     不是整条漏掉才"搜不到密钥"。
  expect(queryIndex(index, parseQuery('部署')).sessionIds).toHaveLength(1)
})
```

再加一条：序列化之后的字符串里也不含密钥本体（`JSON.stringify(index).toLowerCase()`），把"落盘"这一步也钉住。

---

### Task 5: 第四个存储文件——`src/main/storage/store.ts`

**Files:**
- Modify: `src/main/storage/store.ts`
- Test: `tests/storage/store.test.ts`

**Interfaces:**
- Consumes: 现有 `readJson` / `writeJsonAtomic` / `enqueue` / `path()`、`readIndexFile`（Task 4）
- Produces: `store.getSearchIndex()` / `store.saveSearchIndex()` / `store.clearSearchIndex()`——Task 6 用

- [ ] **Step 1: 加 `SEARCH_INDEX_FILE = 'search-index.json'` 到文件名常量那一组。** 与 `SETTINGS_FILE` / `INDEX_FILE` / `STATE_FILE` 放一起，别散落。

- [ ] **Step 2: `getSearchIndex()` 走 `readJson` + `readIndexFile` 两步。** 前者管"文件在不在、是不是合法 JSON"，后者管"内容是不是一张能用的表"。读不出来返回 `null`（不是 `emptyIndex()`）——调用方必须能区分"没有索引"（降级 + 提示）和"有一张空表"（库里真的没会话）。

  **这一层不缓存**，和前三个文件都不一样。表最大 30 MB，而 `library` 拿到之后本来就自己留着一份（`this.searchIndex`），store 再留一份就是白占一倍内存；况且整个生命周期里这个方法只在 `init()` 调一次，缓存省不下任何一次读。不缓存还顺手躲开一个坑：`clearSearchIndex()` 之后再读，缓存里那张已经删掉的表不会被当成"还在"。

- [ ] **Step 3: `saveSearchIndex()` 照 `saveIndex` 的模式：同一个 `enqueue(file, …)` 队列、同一个 `writeJsonAtomic`。** 没有缓存要更新（见 Step 2），所以 `saveIndex` 那条"缓存等写成功之后再更新"的纪律在这里自动成立——写失败时下一次 `getSearchIndex()` 直接读盘，拿到的就是磁盘上那张旧表，内存与磁盘不可能分叉。

- [ ] **Step 4: `clearSearchIndex()` 删文件而不是写一张空表。** 空表和没有表在语义上不同（见 Step 2），而"关掉开关就不留这份文本在磁盘上"要求的是真的删掉。文件本来就不存在时视作成功（`rm` 的 `force: true` 吞掉 `ENOENT`）。

  **删除也要走同一个写队列**，否则一次排在后面的 `saveSearchIndex` 会在删除之后又把文件写回来——"关掉开关"之后磁盘上重新出现一份完整的表，是这一步最难查的坏法。

  删不掉时（文件被别的进程占着之类）`console.warn` 记一条就继续，不抛。调用它的是 `clearIndex()`，那边还有会话索引和隐藏名单要清，为一个删不掉的文件把后面几步全放弃是更坏的结果。但**不能静默吞掉**：清空索引是用户为了隐私点的按钮，失败了总得留下痕迹。

- [ ] **Step 5: 补 `tests/storage/store.test.ts`。** 往返一次读回来相等；文件不存在时返回 `null`；文件是坏 JSON 时返回 `null` 而不抛；版本号不符时返回 `null`；**下标越界的表也返回 `null`**（这一条证明两步校验真接上了——只有 `readIndexFile` 看得出来）；`clearSearchIndex` 之后文件真的没了、`getSearchIndex()` 也不从缓存里把旧表捞回来、且重复调用不抛；删和写并发时删在后面就是删掉；删不掉时 `resolves` 且恰好记了一条。

---

### Task 6: 挂到扫描上——`src/main/library.ts`

这一步的全部难点是**生命周期**，不是建索引。索引本身在 `onSession` 里一行就攒完了；难的是让它和 `session-index.json` 分毫不差地一起过期。

**Files:**
- Modify: `src/main/library.ts`
- Test: `tests/library/searchLifecycle.test.ts`

**Interfaces:**
- Consumes: `collectTerms` / `mergeIndex` / `emptyIndex`（Task 4）、`store.getSearchIndex` / `saveSearchIndex` / `clearSearchIndex`（Task 5）、`settings.buildSearchIndex`（Task 1）
- Produces: 落盘的倒排表、`library.searchSessions(request)`（Task 7 的 IPC handler 调它）

- [ ] **Step 1: `init()` 里把表读进来，读不出来就记住"没有"。** 一个字段就够，不要两个：

```ts
private searchIndex: SearchIndexFile | null = null
```

`init()` 里 `this.searchIndex = await this.deps.store.getSearchIndex()`。**读失败不抛、不阻塞 `init`**——搜索坏了不该让整个应用打不开。

  **本来想再存一个"这次为什么没有表"的字段，实现时发现它是多余的。** 界面要的那句提示在查询的那一刻就能算出来：开关关着（读设置）、表是 `null`（读这个字段）、`droppedTerms > 0`（读表本身）——三个来源都是当下可读的事实。多存一个字段就多一份要跟着同步的记忆，而它唯一的作用是把已知的事实重述一遍。顺带一个好处：`store.getSearchIndex()` 已经把"文件不在、JSON 坏了、下标越界"三种坏法都收敛成了 `null`，那三种的提示措辞本来也是同一句。

- [ ] **Step 2: 扫描时在 `onSession` 里攒词条。** 那个回调现在这样写着：

```ts
onSession: (session) => {
  keep(toSummary(session) as SessionSummary)
  // 这里刻意不调用 remember()：扫描出来的会话立刻变成垃圾，
  // 用户真正点开某个会话时会重新解析那一个文件。
}
```

在 `keep(...)` 旁边加一行 `if (buildSearchIndex) producedTerms.set(session.id, collectTerms(session))`。**必须在这里做**，理由和那条注释是同一个：这一刻事件还在内存里，下一刻就被丢了；放到扫描之后再做就得把 674 个文件重读一遍。

开关在扫描开始前读一次存进局部变量，不在回调里每次读——扫描中途改设置不应该让索引变成半份。

- [ ] **Step 3: 复用的会话不需要重新攒词条——但"能不能复用"要多问一个条件。** `onReused` 收到的是"文件没变、直接沿用上次摘要"的那批，它们的词条已经在 `previous` 表里，`mergeIndex` 的重映射会原样保留。所以那个回调里刻意什么都不做，并且要有一条注释写清"为什么这里什么都不做"，否则下一个人会以为漏了。

  **但复用的判据本身得改。** 复用一个文件意味着 `onSession` 压根不会被调到，词条也就无从收集。于是"文件没变"这一个条件不够，还得加上"它的词条已经在表里"：

```ts
const indexedSessionIds = new Set(this.searchIndex?.sessionIds ?? [])
// …
lookupKnown: (candidate) => {
  const known = knownByPath.get(normalizePathKey(candidate.path, this.deps.platform)) ?? null
  if (known === null || !buildSearchIndex) return known
  return known.summaries.every((summary) => indexedSessionIds.has(summary.id)) ? known : null
}
```

  少了这个条件，Step 7 那句"打开开关后重新扫描一次就能建好"是一句空话：文件的大小与修改时间一个字节都没变，于是它被永久跳过，表永远建不起来。同一个洞还有另外三个入口——表被用户清掉、表在磁盘上坏掉、上一次扫描被取消掉的那部分。四个入口一个补法。

  `!buildSearchIndex` 时直接放行是有意的：开关关着的时候没有表要维护，不该为此付一次全量重解析的代价。

- [ ] **Step 4: 索引写回紧跟 `saveIndex`，共用 `staleIds` 与 `produced`。** 现有那段是：

```ts
const next = new Map(this.index.map((summary) => [summary.id, summary]))
for (const id of staleIds) { next.delete(id); this.cache.delete(id) }
for (const [id, summary] of produced) next.set(id, summary)
this.index = [...next.values()].sort((a, b) => sortKey(b) - sortKey(a))
await this.deps.store.saveIndex(this.index)
```

后面接上 `mergeIndex({ previous: this.searchIndex ?? emptyIndex(), removed: staleIds, added: producedTerms, builtAt })` 再 `saveSearchIndex`。**用的是同两个集合**——`staleIds` 已经把"目录读不动 / 深度调低 / 超体积上限都不算已删除"这些判断做完了（`provablyGone`），搜索索引照抄，不重新判断。

- [ ] **Step 5: 取消扫描时不写索引。** `staleIds` 那一段本来就在 `if (!result.cancelled)` 里；索引的写回要放在**同一个** `if` 里，而不是另开一个判断。中途取消时 `producedTerms` 只有一部分会话，此时把它并进去会让"没扫到的"和"确实没了的"混成一类。宁可整次不更新，留着旧表。

- [ ] **Step 6: `clearIndex()` 要把第四个文件也清掉。** 现在它清 `this.index`、`this.cache`、`hiddenSessionIds`。加 `this.searchIndex = null` + `await this.deps.store.clearSearchIndex()`。漏掉这一步的后果很具体：用户点了"清空本地索引"，界面上会话全没了，但磁盘上还留着一份含全部会话文本的倒排表——那正是这个按钮要消除的东西。

- [ ] **Step 7: 开关关掉的那一刻就清，不等下次扫描。** 在 `updateSettings` 里，检测到 `buildSearchIndex` 由 `true` 变 `false` 就立即 `clearSearchIndex()`。这样"关掉就不落盘"是当下为真的陈述，而不是"下次扫描之后才为真"。反向（`false` → `true`）不自动扫描，只在界面上提示需要重新扫描一次才有全文索引——擅自触发一次 674 文件的全量扫描太重。

- [ ] **Step 8: `forgetFile()` / `absorb()` 也要跟着走。** 前者是"这个文件不见了"，后者是导入。两处都已经在改 `this.index`，同一处加上对倒排表的移除 / 新增。这一步容易漏，因为它们不走 `runScan`。

  两处的形状一样（`removed` + `added` 一起并进表再落盘），所以抽一个私有的 `mergeSearchIndex({ removed, added })`，里面顺手把"开关关着就直接返回"这条判断收进去——否则用户关掉开关几秒之后一次导入又把 `search-index.json` 建了回来，那个开关就等于没用。

  **`forgetSession()` 反而刻意不动表。** 它做的是"把这一条从界面上藏起来"（记进 `hiddenSessionIds`、从 `this.index` 里滤掉），而搜索结果最后要过一遍 `rankSessionIds`，那一步按 `this.index` 排序并丢掉不在里面的 id——于是被藏起来的会话自然搜不出来，postings 则留到下次扫描随 `staleIds` 一起消失。这里不额外改表是因为改了也白改：`forgetSession` 不删源文件，下次扫描它照样会被重新索引回来。

- [ ] **Step 9: `searchSessions(request)`——第一层查询 + 降级。** 三条降级路径合成一句话给界面，措辞必须让用户知道"这次没搜全文"：

```ts
async searchSessions(request: SearchRequest): Promise<SearchResponse>
```

  - 开关关着 → `degraded: true`，`notice: '全文索引已关闭，这次只搜了标题。'`
  - 表不存在或读坏了 → `degraded: true`，`notice: '还没有全文索引（或索引已损坏），这次只搜了标题。重新扫描一次就能建好。'`
  - 表在但 `droppedTerms > 0` → `degraded: false`（全文是搜了的），`notice: '索引超出体积上限，丢掉了 N 个高频词，结果可能不全。'`

  降级时的"只搜标题"不另写一套匹配逻辑，而是用内存里的 `this.index` 现搭一张**临时**倒排表（每个摘要过一遍 `collectSummaryTerms`），再交给同一个 `queryIndex`：

```ts
private titleOnlyIndex(): SearchIndexFile {
  const added = new Map<string, ReadonlySet<string>>()
  for (const summary of this.index) added.set(summary.id, collectSummaryTerms(summary))
  // …mergeIndex 到一张空表上
}
```

  这比原本设想的"`tokenize` + 包含判断"多绕一步，换来的是**降级路与正常路走的是同一段检索代码**：同样的词条扩展三档、同样的 AND 求交、同样的 `unmatched` 语义。分成两套的话，"同一个词开着索引搜得到、关了搜不到"这类不一致迟早出现，而它对用户完全无法解释。表只在这一次查询里存在、查完就丢——674 个摘要建一张标题表是零点几毫秒的事，不值得缓存，缓存反而要跟着 `this.index` 一起失效。

  `collectSummaryTerms` 与 `collectTerms` 共用同一份字段清单（后者调前者再加上事件），所以降级搜的字段严格是全文那一套的子集，不会出现"降级路搜得到、全文路搜不到"的反向不一致。

  第一层的返回顺序沿用 `sortKey`（新的在前），与列表里看到的顺序一致。

- [ ] **Step 10: 写 `tests/library/searchLifecycle.test.ts`，照 `tests/library/scanIndex.test.ts` 的架子。** 同一个 `ROOT` / `sessionContent()` / `makeLibrary()` / `mkdtemp` 三件套。要覆盖的正是那个文件已经覆盖过的每一种失效情形，但断言换成"倒排表里还有没有它"：

  - 第一次扫描后，能按会话正文里的词搜到它。
  - 新增一个文件、再扫一次：新会话搜得到，旧会话仍然搜得到（**增量没有把旧的冲掉**）。
  - 文件内容改了、再扫一次：旧词搜不到了、新词搜得到（**是替换不是叠加**）。
  - 文件删了、再扫一次：搜不到了，且遍历整张表没有任何 postings 指向它。
  - **扫描被取消：倒排表与取消前一模一样**（深比较整个文件，不是只查一个词）。
  - 扫描范围之外的目录读不动（`EACCES`）时不误删——照 `provablyGone` 那几条各来一遍。
  - `clearIndex()` 之后 `store.getSearchIndex()` 返回 `null`、磁盘上文件不存在。
  - `buildSearchIndex: false` 下扫描完，磁盘上没有这个文件；随后打开开关再扫描，文件出现（**这一条钉的是 Step 3 那个复用判据**，少了它这一条会红）。
  - 开关由开变关的那一刻，文件立刻消失（不需要再扫描）。
  - 不经扫描的两条写回路各一条：导入进来的会话当场搜得到、且开关关着时导入不建表；点开一个源文件已经没了的会话（走 `forgetFile`）时它的词条一起清掉。
  - 用户主动移除的两种：隐藏来源的会话**压根不进表**（不是"搜出来了再挡掉"——正文躺在磁盘上跟移除了不是一回事），以及 `forgetSession` 之后搜不出来。隐藏来源还要单独再来一条"文件没变的重扫"，因为那种情形下复用规则会想留着它，隐藏必须比它更强势。
  - `droppedTerms > 0` 时那句提示：`degraded` 仍然是 `false`（全文是搜了的，只是可能不全），与"只搜了标题"是两件事。

  **断言落在项目名上，不落在会话 id 上。** 会话 id 是 `sha1(文件路径#draftKey)` 的前 16 位（`src/main/parsers/buildSession.ts`），**fixture 里 `session_meta` 那个 `session_id` 字段不会变成它**。写成期望值既看不懂也对不上，所以测试里用一层 `labelsOf()` 把 id 映射成 `projectName`（每个 fixture 一个项目名），要真实 id 的两个 API（`getSession` / `forgetSession`）则用 `idOf(项目名)` 反查。抄 `scanIndex.test.ts` 的架子时这一点没有提示——那个文件从不断言 id。

  **断言尽量落在磁盘上那份表**（新开一个 `LocalStore` 读），而不是内存里那份：用户关掉应用再打开拿到的就是磁盘上这一份，而"内存对了、磁盘错了"这种坏法要等到下次启动才露头。

  **"只搜了标题"要用两条断言合起来证明**：只在正文里出现的词搜不到 **且** 标题里的词搜得到。单看任何一条都可能只是"整个搜索都坏了"。这也是 `sessionContent()` 要把标题和正文分开传的原因——第一条消息成为标题，后面几条只进正文。

---

### Task 7: 第二层——`src/main/search/locate.ts`

**Files:**
- Create: `src/main/search/locate.ts`
- Modify: `src/main/library.ts`（`searchSessions` 里 `sessionId` 那一支）
- Test: `tests/search/locate.test.ts`

**Interfaces:**
- Consumes: `eventTextFields`（Task 3，**与第一层同一个函数**）、`parseQuery`（Task 2）、`getSession()` 现有的按需加载
- Produces: `locateHits(session, parsed): SearchHit[]`

- [ ] **Step 1: 一次只碰一个会话。** `searchSessions` 里 `request.sessionId` 有值时，走现有 `this.getSession(id)`（它自带 3 槽 LRU 和 `loadRaw` 的"只取要的那一个会话"逻辑），然后调 `locateHits`。**不循环候选**：不能为了"顺手把前 8 个候选都定位好"连解析 8 个文件，那既毁掉 200 ms 也毁掉 `SESSION_CACHE_LIMIT = 3`。

  走 `getSession` 而不是自己读文件，图的还有它已经做完的打码与路径替换：**片段里的字必须和时间线上看到的一模一样**，否则关掉「显示完整路径」之后，搜索结果反倒会把用户名露出来。这有个能说清的代价——被路径替换掉的那一截（用户名、`Users`）在第一层的表里是有的，第二层却找不到，于是"列出来了但命中 0 处"。让片段和时间线对不上比这更糟。文件在应用外面被删了（`getSession` 返回 `null`）就交空数组：第一层的候选来自磁盘上的表，它可能比现实旧一步。

  找的词是**用户打的词 ∪ 第一层扩展出来的词**。少了扩展出来的：搜 `modules` 时第一层靠 `node_modules` 把这个会话筛出来了，点进去却是"命中 0 处"。少了用户打的：降级路上表里只有标题那几个词，扩展不出任何东西，而这一层压根不需要表就能干活。这个并集在 `library.ts` 里就地拼好，`locateHits` 的签名保持 `(session, parsed)`。

  给了 `sessionId` 的那一支**照样要跑第一层的 `queryIndex`**——`terms` / `unmatched` / `sessionIds` / `degraded` / `notice` 这几个字段跟不给 `sessionId` 时必须是同一个答案，界面上那句提示不该因为用户点进了某个会话就变。

- [ ] **Step 2: 在字段里找位置，用与建索引相同的字段集。** 遍历 `session.events`，每个事件取 `eventTextFields(event)`（已打码），在每段文本里找匹配位置。有引号短语时只找短语；否则找每个词条，命中任意一个即算这个事件命中。

  **找位置分两步，不是一遍铺开。** 先每个词一次 `indexOf` 取最早的那一处当锚点，据此切出窗口，然后只在窗口里找全部命中。一个 64 KB 的输出里搜「的」有上万处，全找出来再排序再合并纯属白干——交出去的片段只有 160 字符，窗口外面的一处都用不上。分两步之后规模天然有界：同一个词在一个窗口里最多 160 处。

  大小写要折一份**等长**的小写副本（`foldCase`）出来找，下标才能拿回原文去切片段。绝大多数字符小写是一对一的，个别不是：土耳其语的 `İ`（U+0130）小写之后是两个码元，一个这样的字符就能让它后面所有高亮整体偏一位。碰上这种就逐码元折、折不动的原样留着——少匹配一个生僻字好过交出一串错位的区间。

- [ ] **Step 3: 片段按"命中居中"切，边界对齐到词。** 取 `SEARCH_SNIPPET_LENGTH`（160）字符，命中点尽量居中；撞到文本末尾就整段往左推，让最后一段片段也是满的 160 字符而不是"只剩 20 个字"。两端如果切在 ASCII 词的中间就往里挪到最近的非词字符，避免出现 `de_modules` 这种看着像另一个词的残片；挪动的上限是命中点本身——再往里就把要高亮的字也切掉了，那比残片严重得多。中日韩不参与对齐：每个字都是独立的意思，切在哪儿都不会拼出一个假词。

  截断处加省略号，而**省略号是 `snippet` 字符串的一部分，所以它的长度必须算进 `ranges` 的偏移**——界面拿到的下标是相对交出去的这个 `snippet` 的，它直接 `snippet.slice(from, to)`。偏移一次算完（`head.length - frame.from`），省略号写成常量而不是手写一个 `1`。算错一位高亮就偏一位，而那种错在界面上长得跟对的一模一样，用户只会觉得"这高亮怎么怪怪的"，不会报 bug。

  引号短语可能比窗口还长（`SEARCH_MAX_QUERY_LENGTH` 是 200，窗口只有 160），所以映射区间时右端要截到窗口边界（`Math.min(span.end, frame.to)`）：看不见的那一截不该被算进高亮，越界的下标会让界面 slice 出一串空。

- [ ] **Step 4: 同一事件里的多处命中合并成一个 `SearchHit`，`ranges` 给多段。** 界面上一个事件是一行，一行里高亮几处是自然的；一个事件返回三个 hit 会让"命中 N 处"这个数字与用户看到的行数对不上。同理，一个事件只认**第一个**命中的字段——`SearchHit` 只有一个 `field` 和一个 `snippet`，片段没法横跨两个字段。取第一个而不是"最好的那个"是因为 `eventTextFields` 的字段顺序本来就是"越像摘要的越靠前"，于是"第一个"是个能向用户解释的选择，而"最好的"要先定义什么叫好。

  合并只合**真正重叠**的区间，紧挨着的不合。中文 bigram 天生互相重叠：查询「部署构建」切出 部署 / 署构 / 构建，在原文里首尾相扣，不合并就是三段互相交叉的区间，界面上画不出来。而恰好首尾相接的两段（`部署` 后面紧跟 `构建`，中间没有重叠）是两处独立命中，各自都能在 snippet 上切回一个完整的词——合掉的话切回来是一串跨了两个词的字，而"切回来正好等于命中的词"是这一层最要紧的一条性质。


- [ ] **Step 5: 命中顺序 = 事件顺序。** 不做相关度排序：用户点进一个会话是要按时间线走的，把第 40 步排在第 3 步前面只会让"下一处"这个按钮变得难以预测。攒到 `SEARCH_MAX_HITS_PER_SESSION`（200）就停：一个几万条事件的会话里搜「的」会命中几千处，那个数字对用户没有任何用处，翻页却要翻到手酸。

- [ ] **Step 6: 写 `tests/search/locate.test.ts`。** 覆盖：命中在 `content` 里；命中在 `command` 里；命中在 `fileChanges[].diff` 里；一个事件里两处命中合并成一个 hit、`ranges` 两段；片段不切碎 ASCII 词；`ranges` 的下标在 snippet 上取子串正好等于命中的词（**这条最重要，它直接盯住"高亮偏一位"这类错误**）；引号短语只匹配整串、不匹配拆开的词；`eventIndex` 与 `session.events` 的下标一致（界面靠它设 cursor）。

  会话在测试里手搓，不读 fixture：这一层的输入就是 `CodexSession`，用真文件反而要先猜解析器会把那段 JSONL 变成什么样，断言就不再说明这一层的行为。默认事件的 `title` 留空——`field()` 对空值返回 `null`，所以只给 `content` 的事件第一个字段就是「内容」，要测字段顺序才补标题。

  「切回来」那条写成一个 `highlighted(hit)` 辅助函数（把每段 `ranges` 在 `snippet` 上切出来），几乎每条断言都顺手带上一遍：偏一位就会切出 `ENOEN` 而不是 `ENOENT`。省略号那条要专门造一个两端都被截断的片段，否则偏移里少算的那一位在短文本上看不出来。

- [ ] **Step 7: 一致性测试——两层用同一份定义。** 一条测试：随便构造一个会话，第一层 `collectTerms` 得到的每个 ASCII 词条，在第二层 `locateHits` 里都能定位到至少一处。这条测试是 `sessionText.ts` 存在的理由的可执行形式：将来谁给一层加了字段忘了另一层，它会红。

  **断言的范围要减掉摘要词条**：`collectTerms = collectSummaryTerms ∪ 事件词条`，而第二层是**故意**不搜摘要那几个字段的（一个"命中在项目名上"的 hit 在时间线上没有对应位置，界面点不过去），拿整个 `collectTerms` 去断言会按设计失败。所以先 `collectSummaryTerms` 减一遍，再限定 ASCII。限定 ASCII 顺带绕开了 `İ` 那个边界：`tokenize` 是切片之后再 `toLowerCase`，出来的词条可能比原文长一个码元，而等长的 `foldCase` 匹配不上它。中文词条另起一条，断言一样。

  两条都要先断言"词条集合非空"（`> 15` / `> 5`）：集合空了的话"每个都定位得到"永远是绿的，那是最难发现的一种假绿。


---

### Task 8: 一个 IPC 方法

设计稿给搜索的配额是一个方法（19 → 22 里的第一个），两层共用它，靠 `sessionId` 区分。

**Files:**
- Modify: `src/shared/ipc.ts`, `src/shared/types.ts`（`GleamApi`）, `src/main/ipc.ts`, `src/preload/api.ts`
- Test: 由 Task 6 / Task 7 的测试覆盖（IPC 层本身只是转发，没有自己的逻辑）

**Interfaces:**
- Consumes: `library.searchSessions`（Task 6 Step 9）、`normalizeSearchRequest`（Task 1 Step 6）
- Produces: `window.gleam.searchSessions(request)`——Task 9、10 用

- [ ] **Step 1: 频道名加进 `src/shared/ipc.ts`。** `sessionsSearch: 'sessions:search'`，与现有 `sessions:*` 一组放一起。

- [ ] **Step 2: `GleamApi` 加方法签名。** `searchSessions(request: SearchRequest): Promise<SearchResponse>`。

- [ ] **Step 3: `src/main/ipc.ts` 的 handler 先归一化再转发。** 参数来自渲染进程，照现有 handler 的规矩过一遍 `normalizeSearchRequest`，不把原始对象直接递进去。

- [ ] **Step 4: `src/preload/api.ts` 加一行。** 与其余方法同一个形态，不加任何额外逻辑——preload 只是桥。

---

### Task 9: 列表里的搜索框升级成跨会话搜索

现在 `SessionList` 里那个 `<input placeholder="搜索标题、项目或文件名">` 只在已加载的摘要上过滤。它继续留在原位，但多一层：本地过滤照旧即时生效，全文结果异步回来后合并进来。

**Files:**
- Modify: `src/renderer/hooks/useAppStore.tsx`, `src/renderer/components/SessionList.tsx`
- Test: 现有 `tests/renderer/*` 的形态（纯函数层）+ 手动过一遍

**Interfaces:**
- Consumes: `window.gleam.searchSessions`（Task 8）
- Produces: `searchQuery` / `searchResult` 状态与 `search` action——Task 10 的命中步进器读同一份

- [ ] **Step 1: 本地过滤一个字都不动。** 现有的 `matches()` 是**即时**的：打一个字立刻筛。全文搜索有 IPC 往返，哪怕只有 5 ms 也是异步的。两个一起用：输入的当下先用本地结果重画，全文结果回来再补上"本地没有但全文命中"的那些会话。打字过程中列表不能空一下再填回来。

- [ ] **Step 2: 防抖 200 ms，且旧请求的结果要能被丢掉。** 用一个自增的请求序号，回来时对不上当前序号就整份丢弃——不然打字快的时候会看到结果在几次查询之间跳。**不做取消**：第一层查询本身就是毫秒级，取消机制的复杂度不值得。

- [ ] **Step 3: 查询串太短时不发请求。** 一个 ASCII 字符会扩展出成百上千个词条，返回几乎整个库，看着像"搜索坏了"。ASCII 侧至少 2 个字符再发；中文一个字就发（一个汉字的信息量足够，且 bigram 单字是精确匹配）。

- [ ] **Step 4: 搜索框下面一行，说清这次搜了什么。** 这是"没有数据就说没有"在这一期的落点，四种话术：

  - 正常：`全文命中 N 个会话`
  - 降级：`只搜了标题 —— 还没有全文索引，重新扫描一次就能建好。`（开关关着时换成 `全文索引已关闭，只搜了标题。`）
  - 有丢词：`全文命中 N 个会话（索引超出上限丢了 M 个高频词，结果可能不全）`
  - 有 `unmatched`：`『xxx』没有出现在索引里`

  第四句只念**在原始查询串里能原样找到的**那些词。中文查询的跨词 bigram 必然出现在 `unmatched` 里（`部署构建` → `署构`），而用户从没打过那个"词"，念出来只会让人怀疑是不是自己打错了。过滤靠的就是这里还留着的原文，第一层没有它。

  这一行**不能省**：省掉它，用户就会把"降级只搜了标题"当成"库里真的没有"。

- [ ] **Step 5: 全文命中但被本地过滤条件排掉的会话，要算进列表。** 现在的 `matches()` 只看标题 / 项目 / 文件名；全文命中的会话很可能三个都不含查询词。合并时以"全文命中集合 ∪ 本地命中集合"为准，排序仍按现有的分组与时间顺序，不因为"是全文命中的"就往前插——排序规则突然变化比多等 200 ms 更让人困惑。

---

### Task 10: 命中定位与设置开关

**Files:**
- Modify: `src/renderer/pages/SessionsPage.tsx`, `src/renderer/pages/SettingsPage.tsx`
- Test: 手动过一遍（这两处是纯装配，逻辑都在已测的模块里）

**Interfaces:**
- Consumes: `searchQuery`（Task 9）、`window.gleam.searchSessions` 的第二层形态（Task 8）、现有的 `cursor: {sessionId, index}` / `setEventIndex`
- Produces: 无

- [ ] **Step 1: 点开一个会话时，带着当前查询串发一次第二层请求。** 有查询串才发；没有就一次都不发（不能让"平常点开会话"这条路多一次解析）。

- [ ] **Step 2: 自动跳到第一处命中。** 拿 `hits[0].eventIndex` 调现有的 `setEventIndex`。这是这一期"点进去能跳到命中的那一步"的兑现处。跳转要走现有的 cursor 路径，不新造一套滚动逻辑。

- [ ] **Step 3: 头部一个紧凑的步进器：`命中 N 处 ‹ ›`。** 前后两个按钮循环走 `hits`。命中 0 处时显示一句话而不是禁用按钮——理由与 A3 那个复制按钮完全相同：禁用态带 `pointer-events-none`，鼠标悬不上去，`title` 里的原因永远看不到。

- [ ] **Step 4: 第一层说命中、第二层找不到时，要说实话。** 正常情况下不该发生（Task 7 Step 7 那条一致性测试盯着它），但 bigram 天然会误召回（搜"离线自检"，某个会话里有"离线"和"自检"却不相邻）。这种情况显示 `这个会话里没找到完整匹配（索引按两字一组检索，可能多给了候选）`，不显示"命中 0 处"了事。

- [ ] **Step 5: 设置页加开关。** 放在"隐私与显示"那张卡里，紧跟打码开关——它们是同一类决定（什么东西可以落盘）：

```
建立全文搜索索引
在本机建一份倒排索引，让搜索能覆盖全部会话的正文。
索引只建在打码之后的文本上：密钥不会进索引，代价是也搜不到它们。
关掉后搜索只能搜标题，磁盘上也不会留这份文本。
```

- [ ] **Step 6: 设置页"本地数据"那段的措辞要跟着改。** 它现在写着"本应用只保存一份『索引』（会话摘要）和这些设置"——第四个文件出现之后这句话不再准确。改成把全文索引也点出来，并说明清空索引会把它一起删掉。

---

### Task 11: 收口

- [ ] **Step 1: 隐私声明多一条。** `PRIVACY_POINTS` 里加，位置紧跟现有那条打码声明：

```ts
'全文搜索索引只建在打码之后的文本上，密钥不会被写进索引（代价是也搜不到）。'
```

同时把"索引与设置只保存在你本机的应用数据目录中"那条覆盖到第四个文件——设计稿明确要求新文件列进 `privacyNotice` 的输出。

- [ ] **Step 2: 红线复查。** 新增四个模块自动进 `tests/security/offline.test.ts` 的扫描范围，但手动再过一遍：

```bash
grep -rn "child_process\|spawn(\|execFile(\|execSync(\|new Function(\|eval(" src/
```

只该匹配到注释里提"child_process 是红线"的那几处散文。

- [ ] **Step 3: 性能验收——`tests/search/scale.test.ts`。** 合成 674 个会话（每个几十条事件、正文里混中英文），建一次表，然后测第一层查询：

```ts
it('674 个会话下第一层查询远快于 200 ms', () => {
  const started = performance.now()
  for (const query of QUERIES) queryIndex(index, parseQuery(query))
  const perQuery = (performance.now() - started) / QUERIES.length
  expect(perQuery).toBeLessThan(200)
})
```

第一层的实际耗时是**毫秒级**（求交集只碰几个数组），所以 200 ms 这个界宽到不会在 CI 的任何一台机器上抖。要是哪天它红了，那说明真的退化了一个量级，不是环境慢。

同一个测试里断言表的估算体积在预算内，以及"如果超了，`droppedTerms > 0` 且表仍然可查"。

- [ ] **Step 4: `pnpm verify` 全绿。** typecheck + lint + 全部测试。注意 vitest **不做** typecheck，所以不能拿测试绿当类型没问题；`noUncheckedIndexedAccess` 开着，倒排表里大量 `terms[word]` 与 `sessionIds[i]` 的下标访问都得显式处理 `undefined`。

- [ ] **Step 5: 走一遍验收。** 对着设计稿第七节 A4 那一行：

  - **674 会话下查询 < 200 ms** —— Step 3 的测试；手上真实库里再实测一次打字的手感。
  - **fixture 里的密钥搜不到** —— Task 4 Step 9 的两条断言：查不到，且序列化后的文件里不含密钥本体。
  - 索引缺失 / 损坏时降级为只搜标题、有明确提示、不阻塞界面 —— Task 6 Step 9 + Task 9 Step 4。
  - 分词：`ENOENT` / `TS2345` / `node_modules` 整词可搜、中英混排 —— Task 2 Step 6。
  - 索引失效：文件改动 / 删除 / 取消扫描 —— Task 6 Step 10。
  - 第四个文件列进 `privacyNotice`、被 `sessionsClear` 清掉 —— Step 1 + Task 6 Step 6。
