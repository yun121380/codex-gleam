# A1 · CI 与三平台打包 实现计划

> 每个步骤用 `- [ ]` 标记，按任务顺序逐条实施、逐条勾掉。

**Goal:** 给仓库加上 GitHub Actions 的三平台校验与发布流水线，让 `paths.ts` 里写好但从未执行过的 macOS / Linux 代码真正在那两个平台上跑一遍测试，并让打 tag 就能产出三平台安装包与 `SHA256SUMS.txt`。

**Architecture:** 两个 workflow 文件加一个构建期证据脚本。`verify.yml` 在 windows / macos / ubuntu 三平台上跑 `pnpm verify`（typecheck + lint + test），是 PR 的必需检查。`release.yml` 由 `v*` tag 触发，三平台各自跑 `electron-builder`，产物与校验和上传到 GitHub Release。两个 workflow 都额外产出两份 JSON 构建产物（`build-evidence.json`、`dependency-tree.json`）供 B3 的离线自检页读取——A1 只负责生成它们并把它们放进打包产物，不负责展示。

**Tech Stack:** GitHub Actions、pnpm 10（`action-setup`）、Node 20（`actions/setup-node` 带 pnpm 缓存）、electron-builder 26、Node 内置 `crypto` / `child_process`（**只在 `scripts/` 下的构建期脚本里**，不进 `src/`）。

**Spec:** [docs/design/2026-09-05-parity-and-shareability-design.md](docs/design/2026-09-05-parity-and-shareability-design.md) —— 第 3.4 节（CI 与三平台）与第 4.3 节表格最后两行（构建期校验结果、完整依赖树）。

## Global Constraints

以下值逐字来自 spec，本计划每个任务都隐含遵守：

- 平台矩阵：**windows / macos / ubuntu-latest × Node 20**。
- 安装依赖必须带 **`--frozen-lockfile`**。
- 校验命令是 **`pnpm verify`**（`package.json` 里已存在，等于 typecheck + lint + test）。
- `verify.yml` **设为必需检查**。
- `release.yml` **打 tag 触发**，三平台 `electron-builder`，**`SHA256SUMS.txt` 上传到 Release**。
- **`publish: null` 保持不动，不引入自动更新渠道。**
- CI 额外做一件为第四节服务的事：**把完整依赖树打进构建日志并作为构建产物保存**，供离线自检页展示。
- `src/` 下**不得**新增 `child_process` / `fetch` / `http` / 自动更新库的引用——`tests/security/offline.test.ts` 会扫描源码。构建期脚本放在 `scripts/`，不在扫描范围内（扫描范围见该测试文件的 `SOURCE_DIRS`）。
- 不改写原始会话文件；本期完全不碰 `src/main/`。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `.github/workflows/verify.yml`（新建） | 三平台 × Node 20 跑 `pnpm verify`，PR 与 push 触发 |
| `.github/workflows/release.yml`（新建） | tag 触发，三平台打包 + 汇总 SHA256 + 建 Release |
| `scripts/buildEvidence.mjs`（新建） | 构建期证据生成器：测试数、git sha、时间、平台，写 `build/generated/build-evidence.json` |
| `scripts/dependencyTree.mjs`（新建） | 依赖树生成器：`pnpm list --json --depth Infinity` → `build/generated/dependency-tree.json` |
| `scripts/sha256sums.mjs`（新建） | 对给定目录下的产物算 SHA-256，输出 `SHA256SUMS.txt` |
| `package.json`（改） | 新增 `package:mac`、`package:linux`、`evidence` 三个脚本 |
| `electron-builder.yml`（改） | `extraResources` 加上 `build/generated`，让证据 JSON 进安装包 |
| `.gitignore`（改） | 忽略 `build/generated/` |
| `tests/scripts/sha256sums.test.ts`（新建） | 校验和脚本的单元测试 |
| `tests/scripts/buildEvidence.test.ts`（新建） | 证据 JSON 形状的单元测试 |

`build/generated/` 是构建期产物目录，不入库。B3 读取它，读不到就显示"开发模式，构建期证据不可用"（那是 B3 的任务，不在本计划内）。

---

### Task 1: 校验和脚本

**Files:**
- Create: `scripts/sha256sums.mjs`
- Test: `tests/scripts/sha256sums.test.ts`

**Interfaces:**
- Consumes: 无（本期第一个任务）。
- Produces: `scripts/sha256sums.mjs` 默认导出 `writeSums(dir: string, outFile: string, patterns: string[]): Promise<string>`，返回写入的文本内容；命令行用法 `node scripts/sha256sums.mjs <dir> <outFile>`。Task 4 的 `release.yml` 调用它。

- [ ] **Step 1: 写失败的测试**

创建 `tests/scripts/sha256sums.test.ts`：

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { writeSums } from '../../scripts/sha256sums.mjs'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gleam-sums-'))
}

describe('writeSums', () => {
  it('对匹配的文件输出 "<sha256>  <文件名>" 两空格格式', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'app.exe'), 'hello', 'utf8')
    const out = join(dir, 'SHA256SUMS.txt')

    const text = await writeSums(dir, out, ['.exe'])

    // sha256('hello')
    const expected =
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  app.exe\n'
    expect(text).toBe(expected)
    expect(await readFile(out, 'utf8')).toBe(expected)
  })

  it('按文件名排序，保证同样的输入得到同样的输出', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'b.zip'), 'b', 'utf8')
    await writeFile(join(dir, 'a.zip'), 'a', 'utf8')
    const out = join(dir, 'SHA256SUMS.txt')

    const text = await writeSums(dir, out, ['.zip'])

    const names = text.trim().split('\n').map((line) => line.split('  ')[1])
    expect(names).toEqual(['a.zip', 'b.zip'])
  })

  it('跳过不匹配后缀的文件与子目录', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'keep.exe'), 'x', 'utf8')
    await writeFile(join(dir, 'skip.blockmap'), 'x', 'utf8')
    const out = join(dir, 'SHA256SUMS.txt')

    const text = await writeSums(dir, out, ['.exe'])

    expect(text).toContain('keep.exe')
    expect(text).not.toContain('skip.blockmap')
  })

  it('目录里没有匹配文件时抛错，不写出空文件', async () => {
    const dir = await makeDir()
    const out = join(dir, 'SHA256SUMS.txt')

    await expect(writeSums(dir, out, ['.exe'])).rejects.toThrow('没有找到')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run tests/scripts/sha256sums.test.ts
```

预期：FAIL，报 `Failed to resolve import "../../scripts/sha256sums.mjs"`。

- [ ] **Step 3: 写实现**

创建 `scripts/sha256sums.mjs`：

```js
// 构建期脚本：给发布产物算 SHA-256。
// 只在 CI 与本地打包时运行，不属于应用源码（src/ 下不允许出现 node:crypto 之外的构建期依赖）。
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

/**
 * 对 dir 下后缀命中 patterns 的文件算 SHA-256，写成 sha256sum 兼容格式。
 *
 * @param {string} dir 产物目录
 * @param {string} outFile 输出文件路径
 * @param {string[]} patterns 要收录的后缀，例如 ['.exe', '.zip']
 * @returns {Promise<string>} 写入的文本
 */
export async function writeSums(dir, outFile, patterns) {
  const entries = await readdir(dir, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isFile() && patterns.includes(extname(entry.name)))
    .map((entry) => entry.name)
    .sort()

  if (names.length === 0) {
    throw new Error(`没有找到可校验的产物：${dir}（后缀 ${patterns.join(' ')}）`)
  }

  const lines = []
  for (const name of names) {
    const buffer = await readFile(join(dir, name))
    const digest = createHash('sha256').update(buffer).digest('hex')
    lines.push(`${digest}  ${name}`)
  }

  const text = `${lines.join('\n')}\n`
  await writeFile(outFile, text, 'utf8')
  return text
}

const DEFAULT_PATTERNS = ['.exe', '.zip', '.dmg', '.AppImage', '.deb', '.rpm', '.snap']

if (process.argv[1] && process.argv[1].endsWith('sha256sums.mjs')) {
  const [, , dir = 'release', outFile = 'release/SHA256SUMS.txt'] = process.argv
  const text = await writeSums(dir, outFile, DEFAULT_PATTERNS)
  process.stdout.write(text)
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run tests/scripts/sha256sums.test.ts
```

预期：PASS，4 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add scripts/sha256sums.mjs tests/scripts/sha256sums.test.ts && git commit -m "feat(ci): add SHA256SUMS generator for release artifacts"
```

---

### Task 2: 构建期证据与依赖树脚本

**Files:**
- Create: `scripts/buildEvidence.mjs`
- Create: `scripts/dependencyTree.mjs`
- Modify: `package.json`（新增 `evidence` 脚本）
- Modify: `.gitignore`（忽略 `build/generated/`）
- Test: `tests/scripts/buildEvidence.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `scripts/buildEvidence.mjs` 导出 `buildEvidence(input: { gitSha: string | null; testCount: number | null; platform: string; builtAt: string }): BuildEvidence`，其中
    ```
    BuildEvidence = {
      schemaVersion: 1
      gitSha: string | null
      testCount: number | null
      platform: string
      builtAt: string
    }
    ```
    以及 `main(): Promise<void>`，写 `build/generated/build-evidence.json`。
  - `scripts/dependencyTree.mjs` 写 `build/generated/dependency-tree.json`。
  - **B3 的离线自检页读这两个文件。** 字段名与上面的形状是 B3 的输入契约，改名会让 B3 编译失败。

- [ ] **Step 1: 写失败的测试**

创建 `tests/scripts/buildEvidence.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

import { buildEvidence } from '../../scripts/buildEvidence.mjs'

describe('buildEvidence', () => {
  it('产出固定形状，schemaVersion 恒为 1', () => {
    const evidence = buildEvidence({
      gitSha: 'abc1234',
      testCount: 462,
      platform: 'win32',
      builtAt: '2026-09-05T00:00:00.000Z'
    })

    expect(evidence).toEqual({
      schemaVersion: 1,
      gitSha: 'abc1234',
      testCount: 462,
      platform: 'win32',
      builtAt: '2026-09-05T00:00:00.000Z'
    })
  })

  it('拿不到 git sha 或测试数时写 null，不编造 0', () => {
    const evidence = buildEvidence({
      gitSha: null,
      testCount: null,
      platform: 'linux',
      builtAt: '2026-09-05T00:00:00.000Z'
    })

    expect(evidence.gitSha).toBeNull()
    expect(evidence.testCount).toBeNull()
  })
})
```

拿不到就写 `null` 而不是 0，与 spec 第五节"没有数据就说没有，不要拿 0 冒充"一致。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run tests/scripts/buildEvidence.test.ts
```

预期：FAIL，报 `Failed to resolve import "../../scripts/buildEvidence.mjs"`。

- [ ] **Step 3: 写 buildEvidence.mjs**

创建 `scripts/buildEvidence.mjs`：

```js
// 构建期脚本：把"这份包是怎么造出来的"固化成一个 JSON，随包发出去。
// B3 的离线自检页读它；读不到就显示"开发模式，构建期证据不可用"。
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OUT_DIR = join('build', 'generated')
const OUT_FILE = join(OUT_DIR, 'build-evidence.json')

/** @param {{gitSha: string | null; testCount: number | null; platform: string; builtAt: string}} input */
export function buildEvidence(input) {
  return {
    schemaVersion: 1,
    gitSha: input.gitSha,
    testCount: input.testCount,
    platform: input.platform,
    builtAt: input.builtAt
  }
}

function readGitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** 从 `pnpm test` 的输出里抓 vitest 的 "Tests  N passed" 行。抓不到返回 null。 */
function readTestCount() {
  try {
    const output = execFileSync('pnpm', ['test'], { encoding: 'utf8', stdio: 'pipe' })
    const match = /Tests\s+(\d+)\s+passed/.exec(output)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

export async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const evidence = buildEvidence({
    gitSha: process.env.GITHUB_SHA ?? readGitSha(),
    testCount: readTestCount(),
    platform: process.platform,
    builtAt: new Date().toISOString()
  })
  await writeFile(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write(`build evidence → ${OUT_FILE}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('buildEvidence.mjs')) {
  await main()
}
```

- [ ] **Step 4: 写 dependencyTree.mjs**

创建 `scripts/dependencyTree.mjs`：

```js
// 构建期脚本：把完整依赖树落成 JSON，既进构建日志也进安装包。
// spec 3.4：「把完整依赖树打进构建日志并作为构建产物保存，供离线自检页展示」。
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OUT_DIR = join('build', 'generated')
const OUT_FILE = join(OUT_DIR, 'dependency-tree.json')

function readTree() {
  try {
    const output = execFileSync('pnpm', ['list', '--json', '--depth', 'Infinity'], {
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024
    })
    return JSON.parse(output)
  } catch {
    return null
  }
}

export async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const tree = readTree()
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tree
  }
  await writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  // 同时打进构建日志。
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('dependencyTree.mjs')) {
  await main()
}
```

- [ ] **Step 5: 接上 package.json 与 .gitignore**

在 `package.json` 的 `scripts` 里，紧跟 `verify` 之后加一行：

```json
    "evidence": "node scripts/buildEvidence.mjs && node scripts/dependencyTree.mjs",
```

在 `.gitignore` 末尾加两行：

```
build/generated/
```

- [ ] **Step 6: 跑测试与脚本确认通过**

```bash
pnpm vitest run tests/scripts/buildEvidence.test.ts
```

预期：PASS，2 个测试通过。

```bash
pnpm evidence
```

预期：stdout 出现 `build evidence → build\generated\build-evidence.json` 与一行 JSON；`build/generated/` 下出现两个文件，`build-evidence.json` 里 `gitSha` 是当前 HEAD、`testCount` 是当前测试数（本地能跑 `pnpm test` 就是数字）。

- [ ] **Step 7: 提交**

```bash
git add scripts/buildEvidence.mjs scripts/dependencyTree.mjs tests/scripts/buildEvidence.test.ts package.json .gitignore && git commit -m "feat(ci): generate build evidence and dependency tree artifacts"
```

---

### Task 3: verify.yml —— 三平台校验

**Files:**
- Create: `.github/workflows/verify.yml`

**Interfaces:**
- Consumes: `package.json` 里已有的 `verify` 脚本（typecheck + lint + test）。
- Produces: 一个名为 `verify` 的 workflow，job 名 `verify (${{ matrix.os }})`。仓库设置里要把这三个 job 设为必需检查（Step 3 的手动步骤）。

- [ ] **Step 1: 写 workflow**

创建 `.github/workflows/verify.yml`：

```yaml
name: verify

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: verify-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    name: verify (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          run_install: false

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      # ELECTRON_SKIP_BINARY_DOWNLOAD：verify 只跑 typecheck/lint/test，
      # 不需要 250 MB 的 Electron 二进制，跳过能省掉三个平台各一次下载。
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
        env:
          ELECTRON_SKIP_BINARY_DOWNLOAD: 1

      - name: Verify
        run: pnpm verify
```

`fail-fast: false` 是刻意的：一个平台红了要能看到另外两个平台的结果，否则"mac 和 Linux 到底行不行"这个问题还是没答案。

- [ ] **Step 2: 本地先自己跑一遍同样的命令**

```bash
pnpm verify
```

预期：typecheck 两遍通过、ESLint 无错、Vitest 全绿（当前基线 462 个测试，加上 Task 1/2 的 6 个新测试应为 468）。本地红的话 CI 一定红，先修本地。

- [ ] **Step 3: 提交并推分支，确认三平台绿灯**

```bash
git add .github/workflows/verify.yml && git commit -m "ci: verify on windows, macos and ubuntu with node 20"
```

推到一个分支并开 PR，在 Actions 页确认三个 job 全绿。

**mac / Linux 首次执行时可能出现的真实失败**（这正是本任务的价值——这些代码从没在那两个平台上跑过）：

- `src/main/scanner/paths.ts` 的测试若断言了 Windows 风格分隔符，在 posix 上会失败。修法是让断言走 `path.join`，而不是硬编码 `\`。
- `tests/support/` 的虚拟文件系统若用了 `C:\` 前缀的绝对路径，在 posix 上 `path.isAbsolute` 判定不同。修法是按 `process.platform` 选前缀。
- 大小写敏感的文件系统会暴露 import 路径大小写写错的地方。修法是改 import。

这些修完各自单独提交，commit message 前缀用 `fix(test):`。

- [ ] **Step 4: 把三个 job 设为必需检查**

在 GitHub 仓库 Settings → Branches → `main` 的保护规则里，把 `verify (windows-latest)`、`verify (macos-latest)`、`verify (ubuntu-latest)` 三个勾上。这一步在网页上做，没有命令。

**验收：** 三平台绿灯，且 macOS / Linux 上的 `tests/scanner/` 确实执行了（在 Actions 日志里能看到那些测试名）。

---

### Task 4: release.yml —— 三平台打包与发布

**Files:**
- Modify: `package.json`（新增 `package:mac`、`package:linux`）
- Modify: `electron-builder.yml`（`extraResources` 收录 `build/generated`）
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Task 1 的 `scripts/sha256sums.mjs`、Task 2 的 `pnpm evidence`。
- Produces: 打 `v*` tag 后的一个 GitHub Release，附带三平台产物与 `SHA256SUMS.txt`；每个平台的 `build/generated/*.json` 通过 `extraResources` 进入安装包的 `resources/generated/` 目录（B3 从 `process.resourcesPath` 下读取）。

- [ ] **Step 1: 加打包脚本**

`package.json` 的 `scripts` 里，紧跟已有的 `package:win` 之后加两行：

```json
    "package:mac": "pnpm run build && electron-builder --mac",
    "package:linux": "pnpm run build && electron-builder --linux",
```

（`package:win` 已存在，形如 `pnpm run build && electron-builder --win`；这两行照它的样子写。`electron-builder.yml` 里的 `mac: [dmg]` 与 `linux: [AppImage]` target 块已经存在，不用改。）

- [ ] **Step 2: 让证据 JSON 进安装包**

在 `electron-builder.yml` 里加一段 `extraResources`（与 `files:` 同级）：

```yaml
extraResources:
  - from: build/generated
    to: generated
    filter:
      - "**/*.json"
```

**`publish: null` 一行不动** —— 这是 spec 写死的：不引入自动更新渠道。

- [ ] **Step 3: 验证本地打包仍然成功**

```bash
pnpm evidence && pnpm package:dir
```

预期：`release/win-unpacked/resources/generated/` 下出现 `build-evidence.json` 与 `dependency-tree.json`。

- [ ] **Step 4: 写 release workflow**

创建 `.github/workflows/release.yml`：

```yaml
name: release

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    name: build (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            script: package:win
          - os: macos-latest
            script: package:mac
          - os: ubuntu-latest
            script: package:linux

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          run_install: false

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # 先跑一遍校验：不给自己发一个测试是红的包。
      - name: Verify
        run: pnpm verify

      # 构建期证据（测试数 / git sha / 时间）与完整依赖树，
      # 同时打进构建日志并随包发出（spec 3.4 与 4.3）。
      - name: Build evidence and dependency tree
        run: pnpm evidence

      - name: Package
        run: pnpm ${{ matrix.script }}

      - name: Upload build evidence
        uses: actions/upload-artifact@v4
        with:
          name: evidence-${{ matrix.os }}
          path: build/generated/*.json

      - name: Collect installers
        shell: bash
        run: |
          mkdir -p dist-artifacts
          find release -maxdepth 1 -type f \
            \( -name '*.exe' -o -name '*.zip' -o -name '*.dmg' \
               -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) \
            -exec cp {} dist-artifacts/ \;
          ls -l dist-artifacts

      - name: Upload installers
        uses: actions/upload-artifact@v4
        with:
          name: installers-${{ matrix.os }}
          path: dist-artifacts/*

  publish:
    name: publish release
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          run_install: false

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Download installers
        uses: actions/download-artifact@v4
        with:
          pattern: installers-*
          path: dist-artifacts
          merge-multiple: true

      # SHA256SUMS.txt 必须在所有平台的产物都到齐之后一次算完，
      # 否则三个平台各自算一份，用户拿到三个互不包含的清单。
      - name: Compute checksums
        run: node scripts/sha256sums.mjs dist-artifacts dist-artifacts/SHA256SUMS.txt

      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          files: dist-artifacts/*
          generate_release_notes: true
          fail_on_unmatched_files: true
```

`publish` 单独一个 job 的理由写在注释里：校验和必须在三平台产物齐了之后算，不能各平台自己算。

- [ ] **Step 5: 用一个预发布 tag 验证整条流水线**

```bash
git add package.json electron-builder.yml .github/workflows/release.yml && git commit -m "ci: release windows, macos and linux packages with checksums"
```

推上去之后打一个测试 tag（用 `v0.0.0-ci-test` 这种明显是测试的名字，验证完在网页上删掉 Release 与 tag）：

```bash
git tag v0.0.0-ci-test && git push origin v0.0.0-ci-test
```

预期：三个 build job 绿灯，`publish` job 建出一个 Release，里面有 Windows 的 `.exe` + `.zip`、macOS 的 `.dmg`、Linux 的 `.AppImage`，外加一个 `SHA256SUMS.txt`，其内容覆盖全部上述文件。

**mac 打包首次可能失败的真实原因：** 未签名的 `.dmg` 在 CI 上会因为找不到签名身份而报错。修法是在 `Package` 这一步加 `env: CSC_IDENTITY_AUTO_DISCOVERY: false`，明确表示"这是未签名构建"。这不是绕过检查，是告诉 electron-builder 别去找不存在的证书。

- [ ] **Step 6: 清理测试 tag 并提交任何修复**

在网页上删掉 `v0.0.0-ci-test` 的 Release，然后：

```bash
git push --delete origin v0.0.0-ci-test && git tag -d v0.0.0-ci-test
```

（这一步会删远端 tag。它是本任务刚创建的测试 tag，删除前请确认 Release 页面上没有别人下载过它。）

---

### Task 5: 补上仓库门面文件

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`

**Interfaces:**
- Consumes: Task 3 的 `verify.yml`（CONTRIBUTING 里要引用"PR 必须过三平台 verify"）。
- Produces: 无代码接口。

这两份文件不是仪式感——CI 建好之后，"提 PR 要满足什么"必须有个地方写清楚，否则必需检查会变成一堵没有说明书的墙。

- [ ] **Step 1: 写 CONTRIBUTING.md**

创建 `CONTRIBUTING.md`：

```markdown
# 参与开发

## 环境

Node.js 20 以上、pnpm。

```bash
pnpm install
pnpm dev
```

## 提 PR 之前

```bash
pnpm verify
```

它等于 `typecheck` + `lint` + `test`。CI 会在 windows / macos / ubuntu 三个平台上各跑一遍同样的命令，三个都必须绿。

## 三条不能破的底线

本项目有一批用测试锁住的约束，`tests/security/offline.test.ts` 会扫描全部源码：

1. **不引入网络能力**：`fetch`、`XMLHttpRequest`、`new WebSocket`、`EventSource`、`sendBeacon`、`http` / `https` 模块、自动更新库，一个都不能出现在 `src/` 下。
2. **不引入执行能力**：`child_process`、`spawn(`、`execFile(` 不能出现在 `src/` 下。构建期脚本放 `scripts/`，不在扫描范围内。
3. **不改写用户的原始会话文件**：文件系统访问只读。

如果你的功能看起来必须破其中一条，那大概是设计问题，先开 issue 讨论。

## 提交信息

用 `type(scope): summary` 格式，例如 `feat(search): add inverted index`。
```

- [ ] **Step 2: 写 SECURITY.md**

创建 `SECURITY.md`：

```markdown
# 安全策略

## 报告漏洞

请通过 GitHub 的 Private vulnerability reporting 提交，不要开公开 issue。

## 这个应用的攻击面

拾光不联网、不执行命令、只读打开你的会话文件。所以最值得报的两类问题是：

1. **打码漏了。** 某种形态的密钥没被识别，出现在界面、导出产物或本地索引里。请附上一个**伪造的**样例（不要发真密钥）。
2. **离线约束被绕过。** 发现任何形式的对外请求、命令执行或对原始文件的写入。

## 已知的、刻意的限制

- 跨会话搜索索引建在**打码后**的文本上，所以密钥搜不到。这是设计选择，不是缺陷。
- 打码只发生在展示与导出层，原始文件一个字节都不改。所以打码漏了不会污染你的原始数据，但会污染你分享出去的产物。
```

- [ ] **Step 3: 提交**

```bash
git add CONTRIBUTING.md SECURITY.md && git commit -m "docs: add contributing guide and security policy"
```

---

## 验收

- 三平台 verify 绿灯，且 macOS / Linux 上 `tests/scanner/` 的测试确实执行了（spec 第七节 A1 的验收条件："三平台绿灯，mac/Linux 路径测试真的执行了"）。
- 打 tag 能产出三平台安装包与一份覆盖全部产物的 `SHA256SUMS.txt`。
- `electron-builder.yml` 的 `publish: null` 未被改动。
- `pnpm test` 里新增 6 个测试（Task 1 的 4 个 + Task 2 的 2 个），且 `tests/security/offline.test.ts` 仍然全绿——`scripts/` 下的 `child_process` 不在它的扫描范围内，如果它红了，说明扫描范围包含了 `scripts/`，此时应当在测试里把 `scripts/` 显式排除，并在测试文件里写明理由。

## 自检记录

- **Spec 覆盖**：3.4 节两个 workflow → Task 3、Task 4；"`--frozen-lockfile` + `pnpm verify`" → Task 3 Step 1；"设为必需检查" → Task 3 Step 4；"`SHA256SUMS.txt` 上传到 Release" → Task 1 + Task 4；"`publish: null` 保持不动" → Task 4 Step 2 明确写了不动；"把完整依赖树打进构建日志并作为构建产物保存" → Task 2 的 `dependencyTree.mjs`（既 stdout 又 upload-artifact）；4.3 表格"构建期校验结果（测试数、git sha、时间）" → Task 2 的 `buildEvidence.mjs`。
- **占位符扫描**：无 TBD / TODO / "适当处理错误"。每个 Step 都带可执行命令或完整文件内容。mac 打包与 posix 路径两处"可能失败"给了具体症状与具体修法，不是"处理一下报错"。
- **类型一致性**：`writeSums(dir, outFile, patterns)` 在 Task 1 定义、Task 4 Step 4 按同样的位置参数调用（`node scripts/sha256sums.mjs dist-artifacts dist-artifacts/SHA256SUMS.txt`）。`BuildEvidence` 的五个字段在 Task 2 定义，B3 计划里按同名读取。
