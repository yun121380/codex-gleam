import { hasAllowedExtension, isIgnoredDirName } from '@shared/validators'
import type { ScanIssue } from '@shared/types'
import type { FileSystemAccess } from './fsAccess'

export interface CandidateFile {
  path: string
  sizeBytes: number
  modifiedMs: number
  /** 相对扫描根目录的层级：根目录下的文件为 1。 */
  depth: number
  rootPath: string
}

export interface WalkOptions {
  roots: readonly string[]
  /** 文件可被收录的最大层级。maxDepth=6 表示 root/1/2/3/4/5/a.json 收录，再深一层不收录。 */
  maxDepth: number
  maxFileSizeBytes: number
  fs: FileSystemAccess
  /** 外部可随时把 cancelled 置为 true 来中止扫描。 */
  cancellation?: { cancelled: boolean }
  onProgress?: (progress: { dirsVisited: number; filesScanned: number; currentPath: string }) => void
  onIssue?: (issue: Omit<ScanIssue, 'displayPath'>) => void
  /**
   * 每看到一个候选扩展名的文件就回调一次 —— 包括因为太大或 stat 失败而没能
   * 收录成候选的那些。上层用它来判断"这个文件还在不在磁盘上"，
   * 而这个问题的答案不该受大小上限、候选数上限之类的处理策略影响。
   */
  onFileObserved?: (path: string) => void
  /** 单次扫描最多访问的目录数，防止异常结构导致无限扫描。 */
  maxDirectories?: number
  /** 最多收集多少个候选文件，防止候选数组本身撑爆内存。 */
  maxCandidates?: number
}

export interface WalkResult {
  candidates: CandidateFile[]
  dirsVisited: number
  filesScanned: number
  cancelled: boolean
  reachedDirectoryLimit: boolean
  /** 候选文件数触顶而提前停止。上层要把这件事告诉用户。 */
  reachedCandidateLimit: boolean
  /**
   * 目录列表**完整读完**的那些目录。
   *
   * 只有出现在这里的目录，才能推断出"某个文件已经不在磁盘上了"。
   * 被权限挡住、超过 maxDepth 没进去、命中忽略名单、遍历触顶提前收工的目录
   * 都不在这里 —— 那些地方我们压根没看清，不能拿"没看到"当"不存在"。
   */
  enumeratedDirs: string[]
  /**
   * 确认整棵子树都不存在的目录（读取时 ENOENT / ENOTDIR）。
   *
   * 这同样是**确定**的信息，而且比 enumeratedDirs 管得更宽：目录都没了，
   * 底下多深的文件也一并没了。用户删掉整个 Codex 目录后重新扫描，
   * 索引要能真的清空，靠的就是这一条。
   */
  absentDirs: string[]
}

const DEFAULT_MAX_DIRECTORIES = 20_000

/**
 * 候选文件数的硬上限。
 *
 * 遍历阶段就得有个天花板：原来是先把所有候选无限制地攒进数组，之后才在扫描器里
 * 截断到 20000 个。用户要是选了一个塞满 JSON 的项目目录，光这个数组就能吃掉几百兆。
 *
 * 这个值刻意远高于扫描器的 20000：正常情况下永远不会触顶，
 * 于是"取最近修改的 20000 个"那条规则照旧生效；只有异常目录才会撞上这道墙。
 */
const DEFAULT_MAX_CANDIDATES = 200_000

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code?: unknown }).code ?? '')
  }
  return ''
}

/**
 * 遍历候选目录，找出可能是 Codex 会话的文件。
 *
 * 规则（全部来自需求约束）：
 *   - 只走传入的根目录，绝不扫描整个硬盘；
 *   - 超过 maxDepth 的层级不再递归；
 *   - 命中忽略目录名的目录直接跳过；
 *   - 只看 .json / .jsonl；
 *   - 超过大小上限的文件跳过并记录原因；
 *   - 不跟随符号链接（避免目录环）。
 */
export async function walkForCandidates(options: WalkOptions): Promise<WalkResult> {
  const {
    roots,
    maxDepth,
    maxFileSizeBytes,
    fs,
    cancellation,
    onProgress,
    onIssue,
    onFileObserved,
    maxDirectories = DEFAULT_MAX_DIRECTORIES,
    maxCandidates = DEFAULT_MAX_CANDIDATES
  } = options

  const candidates: CandidateFile[] = []
  const visitedDirs = new Set<string>()
  const enumeratedDirs: string[] = []
  const absentDirs: string[] = []
  let dirsVisited = 0
  let filesScanned = 0
  let reachedDirectoryLimit = false
  let reachedCandidateLimit = false

  const isCancelled = (): boolean => cancellation?.cancelled === true
  const shouldStop = (): boolean =>
    isCancelled() || reachedDirectoryLimit || reachedCandidateLimit

  async function visit(dir: string, depth: number, rootPath: string): Promise<void> {
    if (shouldStop()) return

    const key = dir.toLowerCase()
    if (visitedDirs.has(key)) return
    visitedDirs.add(key)

    if (dirsVisited >= maxDirectories) {
      reachedDirectoryLimit = true
      return
    }

    dirsVisited += 1
    onProgress?.({ dirsVisited, filesScanned, currentPath: dir })

    let entries
    try {
      entries = await fs.readDirectory(dir)
    } catch (error) {
      const code = errorCode(error)
      // 目录不存在是完全正常的（比如这台机器上没装过 Codex），不当成问题报给用户；
      // 但"不存在"本身是确定的结论，得记下来 —— 上层靠它清掉已经消失的索引条目。
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        absentDirs.push(dir)
      } else {
        onIssue?.({
          path: dir,
          kind: 'unreadable',
          reason: `无法读取目录（${code || '未知错误'}）。`,
          suggestion: '可能是权限不足或目录被占用。可以在设置里移除该目录，或以管理员身份重试。'
        })
      }
      return
    }

    const subDirectories: string[] = []

    for (const entry of entries) {
      if (shouldStop()) return

      const childPath = joinPath(dir, entry.name)

      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (isIgnoredDirName(entry.name)) continue
        // 只有当子目录本身的层级仍小于 maxDepth 时才有必要进去找文件。
        if (depth + 1 < maxDepth) subDirectories.push(childPath)
        continue
      }

      if (!entry.isFile()) continue
      if (!hasAllowedExtension(entry.name)) continue

      // 先记下"它确实在磁盘上"，再谈能不能收录 —— 下面每一个 continue
      // 都是我们主动跳过它，不代表文件不存在。
      onFileObserved?.(childPath)

      filesScanned += 1
      onProgress?.({ dirsVisited, filesScanned, currentPath: childPath })

      let info
      try {
        info = await fs.statPath(childPath)
      } catch (error) {
        onIssue?.({
          path: childPath,
          kind: 'unreadable',
          reason: `无法读取文件信息（${errorCode(error) || '未知错误'}）。`,
          suggestion: '文件可能已被移动或权限受限，可稍后重新扫描。'
        })
        continue
      }

      if (info.size > maxFileSizeBytes) {
        onIssue?.({
          path: childPath,
          kind: 'skipped-large',
          reason: `文件有 ${formatMb(info.size)} MB，超过了 ${formatMb(maxFileSizeBytes)} MB 的上限，已跳过。`,
          suggestion: '如果确实需要打开它，可以在设置里提高"单个文件大小上限"后重新扫描。'
        })
        continue
      }

      candidates.push({
        path: childPath,
        sizeBytes: info.size,
        modifiedMs: info.mtimeMs,
        depth: depth + 1,
        rootPath
      })

      if (candidates.length >= maxCandidates) {
        reachedCandidateLimit = true
        return
      }
    }

    // 走到这里说明 entries 被逐条处理完了（上面每个提前 return 都跳过了这一行），
    // 这个目录里有哪些文件从此算是问清楚了。子目录能不能走完是另一回事。
    enumeratedDirs.push(dir)

    for (const subDir of subDirectories) {
      await visit(subDir, depth + 1, rootPath)
    }
  }

  for (const root of roots) {
    if (shouldStop()) break
    await visit(root, 0, root)
  }

  return {
    candidates,
    dirsVisited,
    filesScanned,
    cancelled: isCancelled(),
    reachedDirectoryLimit,
    reachedCandidateLimit,
    enumeratedDirs,
    absentDirs
  }
}

function joinPath(dir: string, name: string): string {
  const usesBackslash = dir.includes('\\') && !dir.includes('/')
  const separator = usesBackslash ? '\\' : '/'
  const trimmed = dir.replace(/[\\/]+$/, '')
  return `${trimmed}${separator}${name}`
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}
