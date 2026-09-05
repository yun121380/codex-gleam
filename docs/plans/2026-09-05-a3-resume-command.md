# A3 · resume 命令 实现计划

> 每个步骤用 `- [ ]` 标记，按任务顺序逐条实施、逐条勾掉。

**Goal:** 在会话头部给一个「复制命令」按钮，把 `cd 到项目目录 && codex resume <会话 id>` 拼好放进剪贴板，让人回到终端一粘贴就能接着上次的会话聊。命令模板在设置里可编辑，占位符从当前会话填。**只复制到剪贴板，绝不执行。**

**Architecture:** 一个纯函数模块加两处调用点。`src/renderer/lib/resumeCommand.ts` 不认识 React、不认识剪贴板、不认识 Electron——输入是「模板 + 平台 + 会话里的两个字段」，输出是「拼好的命令」或「拼不出来的原因」。会话头部拿它的结果决定显示按钮还是显示原因；设置页只管把模板存进 `AppSettings`。剪贴板走渲染进程已经在用的 `navigator.clipboard.writeText`（`DetailPanel.tsx:314` 那套 `copied` + 1500 ms 复位），不新增任何 IPC 方法。

**Tech Stack:** 无新依赖。图标从已装的 `lucide-react` 取（`Terminal`）。

**Spec:** [docs/design/2026-09-05-parity-and-shareability-design.md](docs/design/2026-09-05-parity-and-shareability-design.md) —— 第 3.3 节（resume 命令）、第五节"没有数据就说没有"、第六节"安全测试自身扩展"、第七节 A3 行（验收：模板可编辑，只复制不执行）。

## Global Constraints

- **只复制，绝不执行。** 执行就要 `child_process`，那是红线：`tests/security/offline.test.ts` 扫整个 `src/`，禁 `child_process` / `spawn(` / `execFile(`。本期一行都不许碰这三个词，也不新增能执行外部程序的 IPC。
- **`{dir}` 填真实路径，不填打码后的显示路径。** 这串字符是要粘到终端里跑的，`~\projects\x` 这种缩写路径 `cd` 不过去。复制是纯本机动作，没有泄露面——`showFullPaths` 管的是**导出产物与界面文本**，管不到剪贴板。
- **拼不出来就说拼不出来，绝不给一条半成品命令。** 会话 id 缺失时不能拼出 `codex resume undefined`，也不能把占位符原样留在命令里让人拿去跑。这是第五节"没有数据就说没有，不要拿 0 冒充"在本期的形式。
- **替换是字面替换，一次扫完。** 不做转义、不做引号补齐——用户看到的模板就是他会拿到的命令。一次正则扫描替换掉全部占位符，不逐个 `replaceAll`：否则先填进去的值里若含 `{threadId}` 会被第二轮再替换一次。
- **替换进去的值先剥掉控制字符。** 日志里的路径理论上可以带换行，一个换行就把一行命令劈成两条。
- **默认模板按平台给。** spec 里写的 `cd -- {dir} && codex resume {threadId}` 在 Windows 上是坏的（cmd.exe 的 `cd` 不认 `--`，也不会跨盘符切换）。默认值必须在本机能直接用。
- 不改写任何原始会话文件；不引入网络；`fixtures/` 一个字节都不改。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `src/renderer/lib/resumeCommand.ts`（新建） | `defaultResumeTemplate` / `buildResumeCommand`：口径只在这里定一次 |
| `src/shared/types.ts`（改） | `AppSettings.resumeTemplate` |
| `src/shared/constants.ts`（改） | `DEFAULT_SETTINGS.resumeTemplate` 留空 = 跟随平台 |
| `src/shared/validators.ts`（改） | `normalizeSettings` 认识 `resumeTemplate` |
| `src/renderer/pages/SessionsPage.tsx`（改） | 会话头部的「复制命令」按钮与拼不出来时的说明 |
| `src/renderer/pages/SettingsPage.tsx`（改） | 模板输入框，placeholder 显示平台默认值 |
| `tests/renderer/resumeCommand.test.ts`（新建） | 纯函数单元测试 |
| `tests/shared/validators.test.ts`（改） | 旧设置缺 `resumeTemplate` 时补默认值 |

---

### Task 1: 设置里多一个模板字段

**Files:**
- Modify: `src/shared/types.ts`、`src/shared/constants.ts`、`src/shared/validators.ts`
- Test: `tests/shared/validators.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `AppSettings.resumeTemplate: string`。Task 2、3、4 都依赖它。

- [ ] **Step 1: 加字段**

在 `src/shared/types.ts` 的 `AppSettings` 里，三个单价字段之后加：

```ts
  /**
   * resume 命令模板，占位符 `{dir}` 与 `{threadId}` 从会话里填。
   *
   * 空字符串 = 跟随平台默认（见 `resumeCommand.ts` 的 `defaultResumeTemplate`）。
   * 默认值依赖平台，而 `DEFAULT_SETTINGS` 是个静态对象拿不到平台，
   * 所以这里存"空"，真正的默认值在知道平台的地方解析。
   */
  resumeTemplate: string
```

`src/shared/constants.ts` 的 `DEFAULT_SETTINGS` 末尾加 `resumeTemplate: ''`。

- [ ] **Step 2: 让容错转换认识它**

`normalizeSettings` 的返回对象里加一行，与 `priceCurrency` 同形：

```ts
    resumeTemplate: asString(input.resumeTemplate) ?? DEFAULT_SETTINGS.resumeTemplate
```

不 `trim()`：模板里的空格是有意义的（`cd /d "{dir}" && …`），而首尾空格不影响能不能跑。

- [ ] **Step 3: 测试**

`tests/shared/validators.test.ts` 里补两例——旧设置对象里没有这个键时拿到 `''`；给了字符串时原样保留。现有的 `normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)` 会自动覆盖"默认值本身"这一半。

---

### Task 2: 纯函数：拼命令

**Files:**
- Create: `src/renderer/lib/resumeCommand.ts`
- Test: `tests/renderer/resumeCommand.test.ts`（新建）

**Interfaces:**
- Consumes: `AppSettings.resumeTemplate`（Task 1）、`Platform`、会话上的 `projectPath` 与 `agent.threadId`。
- Produces: `defaultResumeTemplate(platform)`、`buildResumeCommand(input)`、`ResumeCommand`。Task 3、4 都只调这两个函数，不自己拼字符串。

放在 `src/renderer/lib/` 而不是塞进 `SessionsPage.tsx` 里的原因很实际：页面组件里的局部函数导不出来，就测不到。这条判据整个都是纯逻辑，值得单独一个文件。

- [ ] **Step 1: 平台默认模板**

```ts
/**
 * 各平台的默认模板。
 *
 * spec 3.3 写的是 `cd -- {dir} && codex resume {threadId}`，那是 POSIX 的写法：
 * Windows 上 cmd.exe 的 `cd` 不认 `--`，而且不带 `/d` 时**不会跨盘符切换**
 * ——项目在 D: 而终端在 C: 时，那条命令会一声不响地留在原地。
 * 默认值必须在本机直接可用，所以这里按平台分开给。
 *
 * 引号写进模板本身，不做自动补引号：路径里有空格是常态，
 * 而"用户看到的模板 = 他拿到的命令"这条比省几个字符重要。
 */
export function defaultResumeTemplate(platform: Platform): string {
  return platform === 'win32'
    ? 'cd /d "{dir}" && codex resume {threadId}'
    : 'cd -- "{dir}" && codex resume {threadId}'
}
```

- [ ] **Step 2: 结果类型**

```ts
export type ResumeCommand =
  | { ok: true; command: string }
  /** reason 直接显示在界面上，detail 进 title 讲清为什么。 */
  | { ok: false; reason: string; detail: string }
```

拼不出来时不返回一条带占位符的命令。半成品命令粘到终端里会真的执行，`codex resume {threadId}` 报的错跟"我们没数据"隔了好几层，用户得自己反推。

- [ ] **Step 3: 拼**

```ts
/** 我们认识的占位符。模板里其它 `{…}` 一律当字面文本，原样留着。 */
const PLACEHOLDERS = ['dir', 'threadId'] as const

export interface ResumeInput {
  /** 模板；空字符串表示跟随平台默认。 */
  template: string
  platform: Platform
  /** 真实项目目录，不是打码后的显示路径。 */
  dir: string | null
  /** Codex 自己的会话 id（rollout 里的 session_id）。 */
  threadId: string | null
}

export function buildResumeCommand(input: ResumeInput): ResumeCommand {
  const template = input.template.trim() === ''
    ? defaultResumeTemplate(input.platform)
    : input.template

  const values: Record<string, string | null> = {
    dir: clean(input.dir),
    threadId: clean(input.threadId)
  }

  // 只要模板真的用到的占位符 —— 用户把 `cd` 那一段删掉之后，
  // 会话没记项目目录就不该再挡着他复制。
  const missing = PLACEHOLDERS.filter(
    (name) => template.includes(`{${name}}`) && values[name] === null
  )
  if (missing.length > 0) return explain(missing)

  // 一次扫完，不逐个 replaceAll：先填进去的值里若正好含 `{threadId}`
  // （路径可以叫这个名字），第二轮会把它当占位符再替换一次。
  // 用函数形式的替换，替换值里的 `$&` 之类也就不会被当特殊记法。
  const command = template.replace(
    /\{(dir|threadId)\}/g,
    (_match, name: string) => values[name] as string
  )
  return { ok: true, command }
}
```

- [ ] **Step 4: 剥控制字符**

```ts
/**
 * 剥掉控制字符再填进命令里。
 *
 * 这串字符是要粘到终端里跑的：路径里只要混进一个换行，
 * 一条命令就变成两条，第二条是什么完全取决于路径长什么样。
 * 剥完成了空串就当没有这个值。
 */
function clean(value: string | null): string | null {
  if (value === null) return null
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return stripped === '' ? null : stripped
}
```

`explain` 按缺哪个给话：缺 `threadId` → reason「日志没记会话 id」、detail 说明 resume 认的是 rollout 里的 `session_id`，这份日志里没有；缺 `dir` → reason「日志没记项目目录」。两个都缺时两句都给。

- [ ] **Step 5: 测试**

`tests/renderer/resumeCommand.test.ts`：

- win32 默认模板含 `cd /d`、不含 `--`；darwin 与 linux 含 `cd --`
- 两个占位符都被填上，`{dir}` 用真实路径
- 自定义模板照用；模板留空/全空格时回落到平台默认
- 模板里不认识的占位符（`{foo}`）原样留着，不报错——那是用户自己的字面文本
- 缺 `threadId` → `ok: false`，reason 里有"会话 id"
- 缺 `dir` 且模板用了 `{dir}` → `ok: false`
- **缺 `dir` 但模板没用 `{dir}` → `ok: true`**（只挡真的用得到的）
- 路径里带换行、回车、NUL → 拼出来的命令里一个换行都没有
- 值只由控制字符组成 → 当缺失处理，不是拼出一条 `cd ""`
- 路径里含 `$&`、含 `{threadId}` 字面量 → 原样出现在命令里，不被二次替换
- 同一个占位符在模板里出现两次 → 两处都被替换

---

### Task 3: 会话头部的「复制命令」按钮

**Files:**
- Modify: `src/renderer/pages/SessionsPage.tsx`

**Interfaces:**
- Consumes: `buildResumeCommand`（Task 2）、`settings.resumeTemplate`（Task 1）、`bootstrap.platform`、`detail.projectPath`、`detail.agent.threadId`。
- Produces: 界面上的按钮。不产出任何被别处依赖的东西。

- [ ] **Step 1: 算出这个会话能不能 resume**

`SessionHeader` 已经从 `useApp()` 拿 `detail` 与 `settings`，把 `bootstrap` 一起取出来，在 `cost` 旁边算：

```ts
  const resume = buildResumeCommand({
    template: settings.resumeTemplate,
    platform: bootstrap?.platform ?? 'win32',
    // 真实路径，不是 displaySourceFile 那种缩写过的 —— 缩写路径 cd 不过去。
    dir: detail.projectPath,
    threadId: detail.agent.threadId
  })
```

`bootstrap` 类型上可空（首帧未就绪）。此时头部本来就还没渲染出来，兜底给 `'win32'` 只是为了不写 `!`。

- [ ] **Step 2: 复制状态**

照 `DetailPanel.tsx:294` 那套：`const [copied, setCopied] = useState(false)`，一个 `useEffect` 在 `copied` 为真时挂 1500 ms 定时器复位，返回 `clearTimeout`。不新造第二种复制反馈方式。

- [ ] **Step 3: 按钮**

右上角现在只有一个「导出报告」。改成一行两个，resume 在左（它是"回到终端继续"，比导出更常用）：

```tsx
        <div className="flex shrink-0 items-center gap-2">
          {resume.ok ? (
            <Button
              icon={Terminal}
              title={`复制到剪贴板（不会执行）：\n${resume.command}`}
              onClick={() => {
                void navigator.clipboard.writeText(resume.command).then(() => setCopied(true))
              }}
            >
              {copied ? '已复制' : '复制命令'}
            </Button>
          ) : (
            <span className="text-[11.5px] text-ink-faint" title={resume.detail}>
              {resume.reason}
            </span>
          )}
          <Button variant="primary" icon={Download} onClick={onExport}>
            导出报告
          </Button>
        </div>
```

拼不出来时用 `<span>` 而不是 `disabled` 的 `Button`：`ui.tsx:65` 给禁用态加了 `pointer-events-none`，鼠标悬停不上去，`title` 里的原因就永远看不到——一个说不出原因的灰按钮比一句话更差。这与用量徽标缺失时的处理同形（短文案在界面上，长解释在 `title` 里）。

- [ ] **Step 4: import**

`lucide-react` 的 import 列表里按字母序插入 `Terminal`；从 `../lib/resumeCommand` 引入 `buildResumeCommand`。

---

### Task 4: 设置页的模板输入框

**Files:**
- Modify: `src/renderer/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `defaultResumeTemplate`（Task 2）、`settings.resumeTemplate`（Task 1）、`bootstrap.platform`。
- Produces: 无。

- [ ] **Step 1: 新增一节**

在「用量单价」`Card`（`SettingsPage.tsx:211`）与「本地数据」之间插一个 `Card`：

```tsx
        <Card className="mt-3">
          <SectionTitle hint="留空就用平台默认">resume 命令</SectionTitle>
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            会话头部的「复制命令」按钮按这个模板拼出命令、放进剪贴板。
            <strong className="text-ink">本应用只复制，绝不执行</strong>
            —— 执行外部程序需要的接口在这里是被测试挡住的红线。
            <code>{'{dir}'}</code> 填会话的项目目录，<code>{'{threadId}'}</code> 填 Codex 的会话 id。
          </p>
          <div className="mt-3">
            <Field label="命令模板">
              <TextInput
                value={settings.resumeTemplate}
                placeholder={defaultResumeTemplate(bootstrap?.platform ?? 'win32')}
                onChange={(value) => void actions.updateSettings({ resumeTemplate: value })}
              />
            </Field>
          </div>
        </Card>
```

placeholder 用平台默认值，于是"留空 = 跟随平台"这件事不用靠文字解释——框里灰着的就是留空时会用的那条。

- [ ] **Step 2: 一句 Windows 提醒**

段末补一句：默认那条是给 cmd.exe 的；用 PowerShell 就把 `&&` 换成 `;`。这不是理论问题，PowerShell 5.1 至今不认 `&&`，而它是 Windows 上的默认终端。

- [ ] **Step 3: import**

`bootstrap` 从 `useApp()` 取（该页已在取 `settings` 与 `actions`）；`defaultResumeTemplate` 从 `../lib/resumeCommand` 引入。

---

### Task 5: 收口

**Files:** 无新增。

- [ ] **Step 1: 红线复查**

```
grep -rn "child_process\|spawn(\|execFile(" src/
```

必须一条不中。`tests/security/offline.test.ts` 扫的是整个 `src/`，本期两个新文件自动落在它的覆盖范围里，不需要为此新增测试——spec 第六节"新增文件不引入任何被禁 API"这一条由那个已有测试履行。

- [ ] **Step 2: `pnpm verify`**

typecheck + lint + test 三步全绿。注意 vitest 不做类型检查，只跑 `pnpm vitest run` 的绿不算数。

- [ ] **Step 3: 走一遍验收**

spec 第七节 A3 行：**模板可编辑，只复制不执行**。

- 设置里改模板 → 会话头部的按钮立刻按新模板拼（`settings` 是 store 里的状态，改完即刻重渲染）
- 清空模板 → 回落到平台默认，placeholder 里灰着的就是它
- 点按钮 → 剪贴板里是命令本身，终端里什么都没发生
- 拿一个 `agent.threadId` 为 null 的会话 → 界面上是一句原因，没有按钮，也没有半成品命令

