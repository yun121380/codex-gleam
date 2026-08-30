<div align="center">
  <img src="build/icon.svg" width="128" alt="拾光" />
  <h1>拾光 · Gleam</h1>
  <p><a href="README.en.md">English</a> · 简体中文</p>
</div>

**完全离线的本地 Codex 会话查看器。**

它会在你电脑上常见的 Codex 数据目录里找到会话文件，然后用一个三栏界面把整个协作过程摊开给你看：
你提了什么要求、Codex 执行了哪些命令、改了哪些文件、哪一步失败了、最后做成了什么。

你不需要知道什么是 JSON、JSONL、目录路径或命令行。

![会话列表与时间线](docs/screenshots/02-sessions.png)

---

## 它不做什么

这一节写在最前面，因为它比功能更重要：

- **不调用任何 AI 接口**，也不在本地跑模型。所有"总结"都是确定性规则算出来的数字。
- **不调用任何云端服务、遥测、错误上报或远程配置**。
- **不需要登录、注册、账号或 API Key**。`.env.example` 里没有任何密钥要填。
- **断网后功能完整**。渲染界面的网络请求在 Electron 层被直接取消（不是"尽量不请求"，是"请求发不出去"）。
- **从不执行会话日志里的任何命令**。命令只作为文字展示，代码里根本没有引入执行命令的能力。
- **从不修改你的原始会话文件**。只读打开，读完就关。
- **不扫描整个硬盘**。默认只看已知的 Codex 候选目录。
- **没有自动更新**，打包配置里发布渠道是关闭的。
- **不使用 CDN**。所有依赖随应用打包，字体使用系统自带字体栈，一个字体文件都不下载。

这些约束不是靠自觉维持的，`tests/security/offline.test.ts` 会扫描全部源码，
一旦有人引入 `child_process`、`fetch`、`http` 或自动更新库，测试立刻失败。

---

## 快速开始

需要 [Node.js](https://nodejs.org/) 20 以上和 [pnpm](https://pnpm.io/)。

```bash
pnpm install          # 安装依赖（会下载 Electron 二进制，约 250 MB）
pnpm dev              # 启动开发环境（热更新）
```

第一次启动会看到欢迎页。点「开始自动扫描」即可；
如果这台电脑上还没有 Codex 会话，可以点「先用示例数据看看效果」，
应用会载入内置的虚构示例，完整体验一遍所有功能。

### 全部命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发模式启动，改代码即时生效 |
| `pnpm build` | 构建主进程 / preload / 渲染进程三份产物到 `out/` |
| `pnpm start` | 用构建产物启动（不带热更新，最接近正式运行） |
| `pnpm typecheck` | TypeScript 类型检查（Node 侧 + 浏览器侧各一遍） |
| `pnpm lint` | ESLint 检查 |
| `pnpm test` | 运行 Vitest 全部测试 |
| `pnpm verify` | 依次执行类型检查、Lint、测试 |
| `pnpm package:win` | 构建 Windows 安装包（NSIS） |
| `pnpm package:dir` | 只生成免安装目录，调试打包问题时更快 |

### 构建 Windows 安装包

```bash
pnpm package:win
```

产物在 `release/` 目录：

- `Gleam-Setup-1.0.0-x64.exe` —— NSIS 安装包，可自选安装目录，会创建桌面与开始菜单快捷方式。
- `win-unpacked/` —— 免安装版本，直接双击里面的 exe 也能跑。

> 第一次打包时 electron-builder 需要联网下载 NSIS 工具链（约 60 MB）。
> 这是**构建期**的一次性下载，和应用本身无关 —— 打出来的应用运行时不联网。

---

## 默认会扫描哪些目录

Windows 下的内置候选目录（顺序即扫描顺序）：

| 目录 | 说明 |
| --- | --- |
| `%USERPROFILE%\.codex` | Codex 主目录 |
| `%APPDATA%\Codex` | Codex 应用数据 |
| `%LOCALAPPDATA%\Codex` | Codex 本地数据 |
| `%APPDATA%\OpenAI\Codex` | OpenAI Codex 应用数据 |
| `%LOCALAPPDATA%\OpenAI\Codex` | OpenAI Codex 本地数据 |
| `%USERPROFILE%\.config\codex` | Codex 配置目录 |

环境变量不存在时（比如某台机器没有 `%APPDATA%`）对应条目会被安静跳过，不会生成 `undefined\...` 这种坏路径。

macOS 与 Linux 的路径也已经内置（`~/.codex`、`~/Library/Application Support/Codex`、
`$XDG_CONFIG_HOME/codex` 等）。扫描器本身是平台无关的，加一个新目录只需要往
`src/main/scanner/paths.ts` 的模板数组里加一行。

### 扫描规则

- 最大递归深度 **6 层**（`root/1/2/3/4/5/a.json` 会被收录，再深一层不会）。
- 跳过目录：`node_modules`、`.git`、`dist`、`build`、`Cache`、`Temp`、`Logs`
  （另外还跳过 `.pnpm-store`、`.venv`、`__pycache__`、`target`、`out`，理由相同）。
- 只检查 `.json` 与 `.jsonl`。
- 跳过超过 **100 MB** 的文件。
- 不跟随符号链接，避免目录环。
- 识别阶段**只读文件开头 64 KB**，不把整个文件载入内存。

### 大目录下的表现

在一台真实机器上实测（`~/.codex` 共 **1207 个 JSON/JSONL 文件、3.6 GB**，最大单文件 223 MB）：

| 指标 | 结果 |
| --- | --- |
| 首次完整扫描 | **36—90 秒**（取决于磁盘缓存），识别出 674 个会话 |
| 峰值内存 | 约 **580 MB**（扫描期间，结束后回落） |
| 本地索引体积 | 2.6 MB |
| 再次扫描 | 文件没变的直接复用，**几乎瞬间完成** |
| 解析出的内容 | 10811 条命令（937 条失败）、4587 个被改动的文件、1771 个通过的测试 |
| 无法归类的记录 | 162 条，占全部步骤的 **0.02%** |

这里有两个关键设计：

1. **扫描过程不囤积会话。** 每个文件解析完立刻算出摘要就把事件丢掉，
   内存占用只和"当前这一个文件"有关，不随会话总数增长。
   你真正点开某个会话时，才会重新解析那一个文件（内存里最多同时保留 3 个完整会话）。
2. **增量扫描。** 索引里记着每个文件的大小和修改时间，
   下次扫描时没变过的文件直接复用上次结果，连读都不读。

扫描期间主进程会主动让出事件循环，所以进度条会持续更新，「取消扫描」随时点得动。

**原文件删了，索引也会跟着清。** 重新扫描时，凡是位于扫描范围内、
但这次没在磁盘上找到的会话，会从索引里移除；文件内容变了的话，它的旧条目会被整批替换。
两个例外：扫描被中途取消时不做任何删除（信息不完整，宁可保守），
你手动导入、位于扫描范围之外的会话也不会被误删。

### 怎么添加自己的扫描目录

三种方式，任选其一：

1. **在应用里加**（推荐）：打开「设置 → 扫描范围 → 自定义扫描目录」，
   把目录路径粘进去点「添加」，然后重新扫描。同一页还能调整搜索深度、文件大小上限和识别门槛。
2. **临时扫一次**：主界面左上角的「扫描其他文件夹」按钮，选一个目录立刻扫描，不写进设置。
3. **用环境变量**：设置 `GLEAM_EXTRA_DIRS`，多个目录用分号分隔（Windows 下不能用冒号，
   否则会把盘符切开）：

   ```
   GLEAM_EXTRA_DIRS=D:\backup\codex;E:\projects\logs
   ```

如果一个都没找到，应用会给出可点击的引导：重新扫描、选择 Codex 数据文件夹、
选择项目文件夹、查看可能的文件位置、导入单个 JSON/JSONL 文件。

---

## 会话是怎么被认出来的

Codex 的日志格式并不统一，所以这里没有写死任何一种格式。

**指纹评分**：读取文件开头，统计 `session_id`、`tool_calls`、`working_directory`、`messages`、
`role` + `user`/`assistant`、ISO 时间戳等特征，加权求和后归一化到 0—1；
同时对 `compilerOptions`、`devDependencies`、`lockfileVersion` 这类特征扣分，
于是 `package.json` 和 `tsconfig.json` 不会被误当成会话。分数会作为「识别可信度」显示在界面上，
门槛可以在设置里调。

**结构性验证**：指纹只是廉价的初筛，它靠词频，所以会误判 —— 实测中一份 Sentry 崩溃报告
因为正文提到了 conversation、session、shell、command，拿到了 100% 的指纹分，
和真实会话完全无法区分。所以扫描时还有一道结构关：**一个会话必须至少包含一条对话或动作事件**
（消息、命令、文件改动、测试、错误之一）。全是无法归类记录的文件会被判为"不是会话"。
这道关把 82 个配置与状态文件挡在了索引外（`plugin.json`、`manifest.json`、
`scope_v3.json` 之类）。

这道关只对**批量扫描**生效。你用「导入单个文件」明确指定某个文件时不做这项检查 ——
那时你已经替它做了判断。

**多适配器解析**：按得分挑选最合适的适配器，认不出就层层降级：

| 适配器 | 适用形态 |
| --- | --- |
| `jsonl-events` | 每行一个事件的 `.jsonl`（会按会话 id 自动切分同一文件里的多个会话） |
| `json-session-object` | 根对象带 `messages` / `events` / `turns` / `sessions` |
| `json-session-array` | 根数组，每一项是一个完整会话 |
| `json-event-array` | 根数组，整体是一串事件 |
| `json-deep-search` | 兜底：在任意深度里找出最像事件列表的数组 |

**统一事件模型**：所有记录最终都变成同一种 `CodexEvent`，类型有
`session_start`、`user_message`、`assistant_message`、`reasoning`、`tool_call`、
`shell_command`、`command_output`、`file_read`、`file_write`、`file_edit`、`git_diff`、
`test_start`、`test_result`、`error`、`unknown`。

### 两件必须做的\"减法\"

在真实数据上实测后加的，不做这两步界面基本没法用：

**一、丢掉 harness 的自言自语。** 实测一份日志里 5500 条记录有 **2896 条是噪音**：
`item_completed` 只是把前面已经出现过的记录再播报一遍（纯重复）、`token_count`
是用量计数器、`sub_agent_activity` 是子智能体活动通知、还有任务生命周期、
上下文压缩、界面日志等等。这些记录**整条丢弃**，不进时间线。
清理后「其他记录」的占比从 **52% 降到 0.4%**。

被丢弃的类型清单在 `src/shared/constants.ts` 的 `NOISE_RECORD_TYPES` 里，一目了然。
注意：丢弃噪音**不会**被当成"解析失败"，所以不会弹出无意义的警告。

**二、把思考过程折叠起来。** Codex 的 `reasoning` 记录能占到全部步骤的一半以上
（实测 80 万步里有 52 万步是思考过程）。它们不是给你看的回答，所以单独成一类、
**默认不显示**；时间线上有个「思考过程 N」的按钮，想看随时打开。

**三、同一句话只留一份。** Codex 有两条并行的记录通道：一条是给界面看的通知
（`event_msg`），一条是正式记录（`response_item`），同一句话会被写两遍。
麻烦的是这两条**往往不挨着** —— 中间常常隔着这一回合的思考、回复和若干条
`turn_context`，实测最远隔了 48 条事件，只看紧邻几条会漏掉绝大多数。

所以判据是**时间**而不是距离：镜像记录的时间戳几乎相同（实测 4280 对里最大差
2.44 秒），而用户真的把同一句话说两遍，中间至少隔着一次回复（实测 143 对里最小差
3.22 秒）。阈值取 3 秒正好落在这条清晰的分界线上，既能合掉镜像，
又不会把「改动前后各跑一次测试」「多智能体互发的同样通知」这类真实重复吃掉。

### 会话标题是怎么来的

Codex Desktop 每开一个会话，都会先以 `role=user` 的身份注入一段
`<recommended_plugins>`（可安装插件清单），随后还会不断补 `<environment_context>`。
这些都不是人说的话 —— 直接拿"第一条用户消息"当标题，结果就是**每个会话都叫
`<recommended_plugins>`**。

标题因此按可靠程度依次回退：

1. **文件里写明的标题**；
2. **Codex 自己起的会话名** —— 它在主目录下维护着一份 `session_index.jsonl`，
   里面是"构思 Codex 生态助力项目"这种真名字。实测能覆盖 64% 的会话；
3. **第一条真正是人说的消息**；
4. 文件名。

认注入内容用的是**形状**而不是固定清单：整段文本被一个 snake_case 标签包住就算。
实测 150 个真实会话里的 902 段注入内容（`recommended_plugins`、`environment_context`、
`turn_aborted`、`multi_agent_mode`、`model_switch`、`skills_instructions` 等）
全都是这个形状，而人写的消息没有一条是 —— 这样 Codex 以后新加的注入块也能自动认出来。
认出来之后它们归到「会话开始」那一类，不再冒充「你说」。

例外是 `<codex_delegation>`：对一个子会话来说，它 `<input>` 里就是这趟要做的事，
所以只剥掉外壳、把指令留下。

### 并行子代理折叠成一组

Codex 派子代理并行干活时，每个子代理写自己的一份日志，而它们收到的是**同一段任务描述** ——
于是标题、项目、时间全都一样。实测一个父会话下最多挂了 **114 个**子代理，
列表里就是一百多行长得完全一样的条目。

分组依据是 Codex 自己写在 `session_meta` 里的 `parent_thread_id`，**不是靠标题猜**。
猜是不行的：好几个月前各自打过一句 "hi" 的会话也会重名，它们之间毫无关系。
展开后每个子代理显示 Codex 给它起的代号和分工，一眼就能分辨：

```
按当前对话确定的循证流方案直接实现…        [▸ 114 个并行子代理]
   ├ Poincare · repo flow audit          27 步
   ├ Bacon · worker research            413 步
   ├ Galileo · frontend audit            25 步
   └ Zeno · final review                274 步
```

实测 603 个会话折叠后剩 **387 行**，少了 216 行。

这里还顺带修了两个解析问题，不修的话父子关系认不全：

- 早期版本的 `session_meta` 只有 `id` 没有 `session_id`，而类型标记写在外层
  （`{type:"session_meta", payload:{id:…}}`）。原来只看内层类型，48 个文件的会话 id 认不出来。
- 分叉出来的会话会把**来源会话的 `session_meta` 一起抄进自己的文件**。
  原来会把它当成"文件里的第二个会话"，还让它抢走整个文件的身份 —— 于是这些子代理顶着父会话的 id。

修完之后，246 个带 `parent_thread_id` 的文件全部认得出来。

### 工具调用参数是代码时怎么办

有些 harness 的工具参数不是 JSON，而是一小段代码：

```js
const r = await tools.exec_command({ cmd: "npm test", workdir: "C:\\proj" })
```

```js
const patch = "*** Begin Patch\n*** Update File: src/a.ts\n...";
await tools.apply_patch({ input: patch })
```

真正有用的信息（执行了什么命令、改了哪个文件）藏在字符串字面量里。
`src/main/parsers/toolScript.ts` 会把它们抽出来 —— 它自带一个 JS 字符串字面量读取器，
处理 `\n`、`\"`、`\uXXXX` 和 Windows 路径里的反斜杠。**它只做文本抽取，绝不执行代码。**

实测效果：命令抽取率 **99%**，被识别出改动的文件从 **7 个变成 4587 个**。
在这之前，这类日志里的每一步都只显示干巴巴的「执行命令」，而且一个文件改动都认不出来。

每个事件都带 `id`、`timestamp`、`type`、`title`、`content`、`sourceFile`、
`workingDirectory`、`relatedFiles`、`success`、`raw` —— 认不出的字段一律原样留在 `raw` 里，
在详情面板底部可以展开查看。**任何单条记录出问题都不会让整个会话失败**：
坏行会被跳过并在会话顶部给出提示（第几行、什么原因、可以做什么）。

---

## 界面

![会话列表与时间线](docs/screenshots/02-sessions.png)

**左栏 · 会话列表**：项目名、标题、最近活动时间、时长、步数、成功/失败、改动文件数、识别可信度。
支持按最近使用/项目/事件数排序，按项目分组，搜索，以及「全部 / 有失败 / 改过代码 / 全部成功」筛选。
每行右侧的删除按钮只会把它从**本地索引**里移除，绝不删除原始文件。

**中栏 · 时间线**：完整还原整个过程。支持上一步 / 下一步 / 播放 / 暂停（键盘 `←` `→` `空格`），
按关键字搜索、只看失败、只看代码修改，逐条展开/折叠。
思考过程默认折叠，点「思考过程 N」可以展开。

**右栏 · 详情**：按事件类型切换呈现方式 —— 对话走 Markdown 渲染，命令是终端风格，
命令输出保留换行并还原 ANSI 颜色，文件改动显示路径与 Diff，测试结果分通过/失败/跳过，
错误单独高亮，最下面永远有一个可折叠的「原始数据」。

![测试结果详情](docs/screenshots/03-test.png)

**统计页**：会话总数、最近 7 天、总命令数、失败命令数、修改文件数、测试通过/失败、
最常用项目、最常改的文件类型、总时长，外加最近 14 天的趋势图。全部由
`src/main/stats/stats.ts` 用确定性规则算出，同样的输入永远得到同样的输出。

![统计页](docs/screenshots/05-stats.png)

---

## 敏感信息打码

默认开启。API Key、Token、Password、Secret、Authorization、Cookie 等字段的值会被替换成 `[已打码]`。

![打码效果](docs/screenshots/04-redaction.png)

除了按键名匹配，还认得一批**已知格式**的密钥（`sk-`、`ghp_`、`github_pat_`、`xox*-`、
`AKIA…`、`AIza…`、`npm_`、JWT、`-----BEGIN … PRIVATE KEY-----`、URL 里的 `user:password@`）。

同时刻意**不**误伤这些：`author`（含 "auth"）、`keyboard`、`keywords`、
`input_tokens` / `total_tokens` / `token_count` 这类用量统计，
以及源码里的 `password: str = Field(...)` —— 那个 `str` 是类型名，不是密码。

打码只发生在**展示与导出**这一层，你的原始文件一个字节都不会变。

### 两个容易漏掉密钥的地方

都是审查时揪出来的，不修就是实打实的泄露口子：

**一、深处的密钥。** 深度打码原来到第 14 层就把整个子树**原样**返回，
藏在更深处的密钥于是完整出现在"原始数据"面板和 JSON / HTML 导出里。
上限本身也定得太低：实测 37555 条真实记录里，`session_meta` 的工具 schema 能到 22 层
（占 0.8%），那些内容会被无谓地截掉。

现在上限抬到 40 层，而且到了上限**绝不原样返回** —— 字符串照常打码，
数字与布尔原样返回（藏不住密钥），只有对象和数组换成 `[嵌套过深，未展开]`。
这个占位符和 `[已打码]` 刻意分开：后者表示"这里本来是个密钥"，
前者只表示"这里太深了没往下看"，别让人误会自己的数据里有密钥。

**二、带空格的密码。** 通用「键: 值」规则原来不允许值里出现空格，于是
`password: my secret phrase` 只会打码第一个词；而第一个词不足 4 个字符时
（`my` 就是），整条**完全不打码**。

现在允许空格，但值遇到下一个运算符就停 —— 这一条同样重要：
既避免 `user=demo password=x` 被整条当成 `user` 的值吞掉（吞掉的部分不会被当成键来检查，
后面那个真密钥就永远轮不到打码），也避免把源码里的类型标注整段糊掉。
实测 120 个真实会话 46 万行：被打码的行从 1101 降到 1066，
也就是说泄露堵上了，过度打码反而比原来更少。

---

## 导出

任意会话都可以导出成三种格式：

1. **Markdown 报告** —— 适合贴进笔记或仓库。
2. **静态 HTML 报告** —— 双击就能用浏览器打开。**零 `<script>`、零外链**，
   样式全部内联，自带一条 `default-src 'none'` 的 CSP。
3. **标准 JSON** —— 带 `schemaVersion` 的结构化数据，方便再加工。

导出前可以选择：是否包含命令输出、是否附带原始 JSON、是否显示完整路径
（关掉会把用户目录写成 `~`，截图分享时不会暴露电脑用户名）、是否对敏感信息打码。

![导出对话框](docs/screenshots/06-export.png)

导出内容包括会话基本信息、你的需求、Codex 的关键回复、执行过的命令（含退出码）、
修改过的文件（含 Diff）、测试结果、错误记录、完整时间线和统计数字。

---

## 安全设计

| 措施 | 位置 |
| --- | --- |
| 所有文件访问只在主进程完成 | `src/main/` |
| 渲染进程没有 Node.js（`contextIsolation` 开、`nodeIntegration` 关、`sandbox` 开） | `src/main/main.ts` |
| 只通过 `contextBridge` 暴露 19 个具体方法，不暴露 `ipcRenderer` | `src/preload/` |
| 取消一切非本地协议的网络请求 | `src/main/security.ts` |
| 禁止页面跳转外部地址、禁止新开窗口、禁止 `<webview>` | `src/main/security.ts` |
| 拒绝一切权限申请（摄像头、定位、通知……） | `src/main/security.ts` |
| 生产环境 CSP：`default-src 'none'; connect-src 'none'` | `electron.vite.config.ts` + 响应头 |
| 移除默认菜单（它带有指向外部网站的链接） | `src/main/main.ts` |
| 单实例锁 | `src/main/main.ts` |

实测：在渲染进程里执行 `fetch('https://example.com')`、加载外链图片、
建立 WebSocket 连接，三者全部被拦截。

---

## 项目结构

```
src/
  main/                    Electron 主进程（唯一能碰文件系统的地方）
    main.ts                入口：创建窗口、装配依赖
    security.ts            网络拦截、导航限制、权限拒绝
    ipc.ts                 IPC 处理器
    library.ts             会话库：索引、缓存、打码出口
    scanner/
      paths.ts             候选目录生成（纯函数，可测）
      fsAccess.ts          只读文件系统抽象（便于注入虚拟文件系统）
      walker.ts            深度 / 忽略 / 大小限制的目录遍历
      fingerprint.ts       Codex 会话指纹评分
      scanner.ts           扫描流程编排
    parsers/
      adapters.ts          多适配器 + 选择器
      normalize.ts         统一事件转换（核心）
      toolScript.ts        工具参数是代码时的抽取（只读文本，不执行）
      patch.ts             apply_patch 与 unified diff 解析
      testOutput.ts        各测试框架输出解析
      loadSession.ts       读文件 → 记录 → 会话
      buildSession.ts      会话统计与摘要
    redaction/
      patterns.ts          敏感字段与已知密钥格式
      redact.ts            文本 / 结构 / 会话三层打码
    exporters/
      reportModel.ts       三种导出共用的报告模型
      markdown.ts / html.ts / json.ts
    stats/stats.ts         确定性统计
    storage/store.ts       本地 JSON 存储（原子写入）
  preload/
    preload.ts             contextBridge 注入
    api.ts                 暴露给渲染进程的全部能力
  renderer/
    App.tsx                外壳与导航
    pages/                 欢迎 / 扫描 / 会话 / 统计 / 设置 / 隐私
    components/            列表、时间线、详情、Diff、终端输出、图表、导出对话框
    hooks/                 全局状态与播放控制
    lib/                   格式化、ANSI 解析、Diff 视图模型、图标映射
    styles/index.css       Tailwind v4 主题（深色 / 浅色）
  shared/
    types.ts               领域模型
    constants.ts           扫描规则、指纹权重、事件元数据
    validators.ts          运行时校验与容错转换
    ipc.ts                 IPC 契约
tests/
  scanner/ parsers/ redaction/ exporters/ stats/ shared/ security/
  support/                 虚拟文件系统与 fixture 辅助
fixtures/                  内置虚构示例会话（应用内可一键载入）
```

---

## 测试

```bash
pnpm test
```

覆盖的内容：

- Windows 路径解析、候选目录生成、环境变量缺失、路径归一化与展示路径
- 扫描深度限制、忽略目录规则、扩展名过滤、大小上限、权限错误、取消扫描
- JSON / JSONL 格式识别，`package.json` 与 `tsconfig.json` 的排除
- 事件统一转换：消息、命令、输出、补丁、测试、错误、思考过程、未知类型
- 命令与输出的配对（含 `call_id` 精确匹配与栈式兜底）
- 噪音记录被整条丢弃，且不被误算成解析失败
- 工具脚本解析：JS 字符串字面量读取、`cmd:` / `workdir:` 抽取、内嵌补丁、并发命令
- 失败判定的保守性（输出里提到 `error` 不算失败）
- 分块读取时中文与 emoji 跨边界不产生乱码
- 索引维护：新增、删除、内容变更、取消扫描、范围外文件不被误删
- 索引边界：`C:\foo` 与 `C:\foobar` 是两个目录，不会被前缀判断误删
- 并发安全：并发扫描只跑一次、冲突请求明确拒绝；并发写设置 / 索引不丢更新、不报 ENOENT
- 不完整记录、损坏 JSON、空文件、超大文件、超长单行
- 敏感字段打码，以及"不误伤"用例（含深层嵌套、带空格的值、源码里的类型标注）
- 统计计算的确定性
- Markdown / HTML / JSON 导出，含 HTML 转义、"无外链"断言与并发命令的输出归属
- **源码级安全检查**：不存在 `child_process`、`fetch`、`http`、自动更新库、外链资源

示例数据全部是虚构的（`demo-shop`、`demo-blog`、`demo-dashboard`、`demo-crawler`、
`demo-notes`、`demo-report`），里面出现的密钥都是明显伪造的占位值，不涉及任何真实 Codex 数据。
其中 `sample-agent-harness.jsonl` 刻意模仿了"多智能体 harness"那种格式：
混着噪音记录、思考过程、参数是代码的工具调用，用来锁定上面那些减法行为。

---

## 已知限制

- **Codex 的真实日志格式无法完全确定。** 本项目没有假设某一种固定格式，
  而是用"指纹评分 + 多适配器 + 未知字段保留"来应对。如果遇到解析得不好的文件，
  它仍然会被展示出来（认不出的部分归为「其他记录」，原始内容完整保留），
  你也可以在详情面板的「原始数据」里看到本来的样子。
- **Diff 用的是自研的本地渲染，不是 Monaco。** 规格允许"Monaco 或其他本地 Diff 编辑器"，
  这里选择了基于 `diff` 库 + 自绘的方案：`@monaco-editor/react` 默认从 CDN 加载
  Monaco，与"不使用 CDN"直接冲突；而完整内联 Monaco 会让安装包增大很多，
  对一个只需要只读 Diff 的工具并不划算。
- **单个 JSON 文件超过 32 MB 会被跳过**（整份 JSON 必须一次读完才能解析）。
  JSONL 会流式读取，但单个文件最多读前 32 MB / 50000 条记录，
  超出部分会在会话顶部明确提示（实测中只有 2 个超大文件触发了这条）。
- **首次扫描一个几 GB 的会话目录需要约一分钟。** 这一步必须逐条解析才能算出准确的
  命令数、失败数和改动文件，没有捷径；好在结果会被增量缓存，之后再扫几乎不花时间。
- **界面用的是系统字体。** 为了不打包字体文件、不访问 CDN，字体走
  `Segoe UI / 微软雅黑 / 苹方` 这样的系统字体栈，不同系统上字形会略有差异。
- **统计口径是固定规则**：命令数包含普通命令与测试命令；apply_patch 算文件修改不算命令；
  网页搜索、MCP 工具的结果不算命令；「最近 7 天」以会话结束时间为准
  （缺失时依次退回开始时间、文件修改时间、索引时间）。
- **有些 harness 根本不记录退出码。** 实测某类日志的命令输出里只有 `Output:` 和
  `Wall time N seconds`，没有任何退出码字段。这种情况下本应用**只认无歧义的失败标记**
  （`command not found`、`Script error:`、`ParserError`、harness 自己报告的执行失败），
  其余一律显示「结果未记录」。这是刻意的：输出里出现 `error` 就判失败会把
  `rg error`、打印告警的 lint 全都误标成红色 —— 谎报比不报更糟。
  日志里确实写了退出码时（如 `exit code: 1`）会正常识别。
- **被丢弃的噪音类型是一份清单，不是智能判断。** 遇到清单外的新噪音类型时，
  它会以「其他记录」的形式出现在时间线上（原始内容完整保留）。
  往 `src/shared/constants.ts` 的 `NOISE_RECORD_TYPES` 里加一行即可。
- **"从索引中移除"不会阻止下次扫描重新发现同一个文件**中的其他会话，
  被移除的那个会话本身会保持隐藏（记录在设置里）。
- 目前只在 Windows 11 上做过实机验证。macOS / Linux 的路径与打包配置已经写好，但未实测。

---

## 许可

MIT
