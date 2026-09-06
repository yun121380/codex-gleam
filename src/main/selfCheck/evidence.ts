import { join } from 'node:path'
import { SELF_CHECK_MAX_EVIDENCE_BYTES, SELF_CHECK_MAX_PACKAGES } from '@shared/constants'
import type { BuildEvidence, DependencyEvidence } from '@shared/types'
import { isRecord, safeJsonParse } from '@shared/validators'
import type { FileSystemAccess } from '../scanner/fsAccess'

/**
 * 构建期证据的读取器。
 *
 * 生产端 A1 就做完了，这里只是把它读出来：`scripts/buildEvidence.mjs` 写
 * `build-evidence.json`、`scripts/dependencyTree.mjs` 写 `dependency-tree.json`，
 * `electron-builder.yml` 的 extraResources 把它们拷进包里的 `generated/`。
 * 三个地方都在注释里写着「B3 的离线自检页读它」——这个文件就是那句话的兑现。
 *
 * 走 `FileSystemAccess` 而不是直接 `fs/promises`，是为了让下面每一条失败路径
 * 都能被单测真的走一遍（包括「文件比上限还大」这种在真实磁盘上很难造的情况）。
 */

const BUILD_FILE = 'build-evidence.json'
const DEPENDENCY_FILE = 'dependency-tree.json'

/** pnpm list 会把依赖分门别类放在这几个键下面，每一类的结构相同。 */
const DEPENDENCY_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

type JsonResult = { value: unknown; issue: null } | { value: null; issue: string }

/**
 * 严格取字符串，**不用 `validators.ts` 的 `asString`**。
 *
 * `asString(42)` 会给你 `"42"`——那套宽松是为 Codex 各版本日志格式不一准备的。
 * 这两份 JSON 是我们自己的脚本按固定 schema 写的，出现一个数字类型的 `gitSha`
 * 只说明写的那一方坏了。把它渲染成 `"42"` 是替坏数据圆场，而这一页存在的意义
 * 恰恰是不替任何人圆场。
 */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 严格取数字，理由同 `str`。 */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 读一份 JSON 证据。三条失败路径**各给一句不同的中文原因，一条都不许静默成空**。
 *
 * 静默的空和真实的空在界面上长得一模一样，而它们的含义相反：一个是「这台机器上
 * 没跑过 `pnpm evidence`」，一个是「文件在那儿但我们读坏了」。前者无关紧要，
 * 后者说明这份包的构建证据不可信——把它们显示成同一个样子，等于把后者藏起来。
 */
async function readJsonEvidence(
  fs: FileSystemAccess,
  path: string,
  label: string
): Promise<JsonResult> {
  let text: string
  let truncated: boolean

  try {
    const result = await fs.readText(path, SELF_CHECK_MAX_EVIDENCE_BYTES)
    text = result.text
    truncated = result.truncated
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : null
    return {
      value: null,
      issue: `${label}读不到${code === null ? '' : `（${code}）`}。`
    }
  }

  if (truncated) {
    // 被截断的文本解析出来一定是坏 JSON，但说成「格式坏」就把人指向了错误的方向——
    // 那会让人去查生成脚本，而真正的问题是这份文件大得离谱。
    return {
      value: null,
      issue: `${label}比上限（${SELF_CHECK_MAX_EVIDENCE_BYTES} 字节）还大，没有读完，因此没有解析。`
    }
  }

  const parsed = safeJsonParse(text)
  if (!parsed.ok) {
    return { value: null, issue: `${label}格式坏了，解析不了：${parsed.error}` }
  }

  return { value: parsed.value, issue: null }
}

/**
 * 读构建期校验证据。
 *
 * `dir` 为 null 时**不是岔子**：那是开发模式的常态（没跑过 `pnpm evidence`），
 * 页面自己会说「构建期证据不可用」。往 `issues` 里塞一句只会让真正的岔子被淹掉。
 */
export async function readBuildEvidence(
  fs: FileSystemAccess,
  dir: string | null
): Promise<{ evidence: BuildEvidence | null; issues: string[] }> {
  if (dir === null) return { evidence: null, issues: [] }

  const result = await readJsonEvidence(fs, join(dir, BUILD_FILE), '构建期校验证据')
  if (result.issue !== null) return { evidence: null, issues: [result.issue] }
  if (!isRecord(result.value)) {
    return { evidence: null, issues: ['构建期校验证据不是一个对象，忽略。'] }
  }

  const raw = result.value
  // 逐字段取，**不因为一个字段坏就把整份丢掉**：`gitSha` 拿到了而 `testCount` 坏了，
  // 那也是一半证据，比没有强。哪个字段是 null，页面上就那一格显示「不可用」。
  return {
    evidence: {
      schemaVersion: num(raw.schemaVersion),
      gitSha: str(raw.gitSha),
      testCount: num(raw.testCount),
      platform: str(raw.platform),
      builtAt: str(raw.builtAt)
    },
    issues: []
  }
}

/**
 * 把 `pnpm list --json --depth Infinity` 那份嵌套结构拍平成「有哪些包、各是什么版本」。
 *
 * 这是这个文件里唯一有算法的地方，三件事值得写下来：
 *
 * 1. **递归要防环。** pnpm 的输出理论上是树，但 `peerDependencies` 的解析结果里
 *    出现过自引用。这里用去重键当访问标记——同一个 `name@version` 的子树内容相同，
 *    第二次遇到直接返回既防了环也省了活。
 * 2. **同名不同版本各留一条。** 一个依赖树里同时有两个版本的 `semver` 是常态，
 *    合并成一条就把真相抹了——而「这个包里到底装了哪些东西」正是这一页要回答的问题。
 * 3. **根包不收。** 顶层那个节点是应用自己（`gleam@1.0.0`），不是它的依赖。
 *    混进去会让 `packageCount` 多出一个假数，而应用自己的版本在关于页早就有了。
 */
export function flattenDependencyTree(tree: unknown): {
  packages: Array<{ name: string; version: string }>
  total: number
  truncated: boolean
} {
  const seen = new Set<string>()
  const collected: Array<{ name: string; version: string }> = []

  const walkGroup = (group: unknown): void => {
    if (!isRecord(group)) return
    for (const [name, node] of Object.entries(group)) {
      if (!isRecord(node)) continue
      const version = str(node.version)
      // 没有版本的条目在这一页上没有核对价值——「装了 semver」而不说哪个版本，
      // 等于什么都没说。子树照旧要走，它下面的包各自有自己的版本。
      if (version !== null) {
        const key = `${name}@${version}`
        if (seen.has(key)) continue
        seen.add(key)
        collected.push({ name, version })
      }
      for (const childKey of DEPENDENCY_KEYS) walkGroup(node[childKey])
    }
  }

  // 顶层是数组（工作区里每个包一项），每项自己是根包，只走它的依赖分组。
  const roots = Array.isArray(tree) ? tree : [tree]
  for (const root of roots) {
    if (!isRecord(root)) continue
    for (const key of DEPENDENCY_KEYS) walkGroup(root[key])
  }

  collected.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    if (a.version === b.version) return 0
    return a.version < b.version ? -1 : 1
  })

  return {
    packages: collected.slice(0, SELF_CHECK_MAX_PACKAGES),
    // 截断**之前**的真实条数。列表是给人翻的，这个数才是精确的——
    // 和拦截清单那里 `recent.length` 不等于 `appBlocked` 是同一个道理。
    total: collected.length,
    truncated: collected.length > SELF_CHECK_MAX_PACKAGES
  }
}

/** 读完整依赖树证据。`dir` 为 null 的含义同 `readBuildEvidence`。 */
export async function readDependencyEvidence(
  fs: FileSystemAccess,
  dir: string | null
): Promise<{ evidence: DependencyEvidence | null; issues: string[] }> {
  if (dir === null) return { evidence: null, issues: [] }

  const result = await readJsonEvidence(fs, join(dir, DEPENDENCY_FILE), '依赖树证据')
  if (result.issue !== null) return { evidence: null, issues: [result.issue] }
  if (!isRecord(result.value)) {
    return { evidence: null, issues: ['依赖树证据不是一个对象，忽略。'] }
  }

  const raw = result.value
  const flat = flattenDependencyTree(raw.tree)

  const issues: string[] = []
  // `tree` 为 null 是脚本记录的一条真实失败：`pnpm list` 没跑成时它就写 null。
  // 那时拍平出来是个空列表——不说一句，页面上就是「0 个依赖」，比撒谎好不了多少。
  if (raw.tree === null) issues.push('依赖树证据里没有树，生成时 pnpm list 没跑成。')

  return {
    evidence: {
      generatedAt: str(raw.generatedAt),
      packageCount: flat.total,
      packages: flat.packages,
      packagesTruncated: flat.truncated
    },
    issues
  }
}
