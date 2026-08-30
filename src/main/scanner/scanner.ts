import { FINGERPRINT_HEAD_BYTES } from '@shared/constants'
import type {
  AppSettings,
  CandidateRoot,
  CodexSession,
  Platform,
  ScanIssue,
  ScanProgress,
  SessionSummary
} from '@shared/types'
import { loadSessionsFromFile } from '../parsers/loadSession'
import { fingerprintSample } from './fingerprint'
import type { FileSystemAccess } from './fsAccess'
import { normalizePathKey, toDisplayPath } from './paths'
import { ancestorDirs, loadThreadTitles } from './threadTitles'
import { walkForCandidates, type CandidateFile } from './walker'

/** 已经索引过、且文件没变过的候选文件可以直接复用上次的结果。 */
export interface KnownFile {
  fileSizeBytes: number
  fileModifiedAt: string | null
  summaries: SessionSummary[]
}

export interface ScanEngineArgs {
  roots: readonly CandidateRoot[]
  settings: AppSettings
  fs: FileSystemAccess
  homeDir: string | null
  platform: Platform
  cancellation: { cancelled: boolean }
  onProgress?: (progress: ScanProgress) => void
  /**
   * 每解析出一个会话就立刻交出去。
   *
   * 这是整个扫描器最重要的约定：**引擎自己绝不囤积会话**。
   * 一台机器上可能有上千个会话、几个 GB 的日志，
   * 把它们连同事件一起攒在数组里会直接撑爆内存。
   */
  onSession: (session: CodexSession) => void
  /** 命中缓存时直接复用，连文件都不用读。 */
  lookupKnown?: (candidate: CandidateFile) => KnownFile | null
  /** 复用缓存结果时回调。 */
  onReused?: (summaries: readonly SessionSummary[]) => void
}

export interface ScanEngineResult {
  sessionCount: number
  reusedCount: number
  parsedFileCount: number
  issues: ScanIssue[]
  progress: ScanProgress
  cancelled: boolean
  /**
   * 本次扫描在磁盘上**确实看到**的文件（已归一化的路径 key）。
   *
   * 由遍历阶段直接填，而不是等解析循环走到才记 —— 因为"文件还在不在"
   * 与"我们这次要不要解析它"是两个问题。超过大小上限、stat 失败、
   * 候选数触顶被截掉的文件，都仍然实实在在躺在磁盘上。
   */
  seenFileKeys: Set<string>
  /** 本次重新解析过的文件：它们的旧索引条目应当整批替换。 */
  refreshedFileKeys: Set<string>
  /**
   * 目录内容被完整列清的那些目录（已归一化）。
   *
   * 只有文件所在目录出现在这里，"这次没看到它"才等于"它没了"。
   */
  enumeratedDirKeys: Set<string>
  /** 确认整棵子树都不存在的目录（已归一化）。 */
  absentDirKeys: string[]
}

/** 进度更新的最小间隔：上千个文件时，每个文件都发一次 IPC 会把界面拖垮。 */
const PROGRESS_INTERVAL_MS = 120

/** 一次扫描最多处理的候选文件数，防止极端目录把应用卡死。 */
const MAX_CANDIDATE_FILES = 20_000

function emptyProgress(): ScanProgress {
  return {
    phase: 'idle',
    currentPath: '',
    dirsVisited: 0,
    filesScanned: 0,
    candidatesFound: 0,
    sessionsFound: 0,
    percent: 0,
    message: ''
  }
}

/** 把控制权交回事件循环，让取消按钮和进度更新有机会被处理。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 完整的扫描流程：遍历目录 → 读文件头做指纹 → 解析会话 → 立刻交出去。
 *
 * 全程只读；任何一步失败都只会变成一条 issue，不会中断整体扫描。
 */
export async function runScan(args: ScanEngineArgs): Promise<ScanEngineResult> {
  const {
    roots,
    settings,
    fs,
    homeDir,
    platform,
    cancellation,
    onProgress,
    onSession,
    lookupKnown,
    onReused
  } = args

  const progress = emptyProgress()
  const issues: ScanIssue[] = []

  const hidden = new Set(settings.hiddenSources.map((path) => normalizePathKey(path, platform)))

  const display = (target: string): string =>
    toDisplayPath(target, { showFullPaths: false, homeDir, platform })

  let lastReportAt = 0
  const report = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastReportAt < PROGRESS_INTERVAL_MS) return
    lastReportAt = now
    onProgress?.({ ...progress })
  }

  const addIssue = (issue: Omit<ScanIssue, 'displayPath'>): void => {
    // 问题列表也要有上限，否则一个坏目录能产生几万条。
    if (issues.length >= 500) return
    issues.push({ ...issue, displayPath: display(issue.path) })
  }

  progress.phase = 'walking'
  progress.message = '正在查找可能的会话文件…'
  report(true)

  const seenFileKeys = new Set<string>()

  const walk = await walkForCandidates({
    roots: roots.map((root) => root.path),
    maxDepth: settings.maxDepth,
    maxFileSizeBytes: settings.maxFileSizeMb * 1024 * 1024,
    fs,
    cancellation,
    onIssue: addIssue,
    onFileObserved: (path) => seenFileKeys.add(normalizePathKey(path, platform)),
    onProgress: (update) => {
      progress.dirsVisited = update.dirsVisited
      progress.filesScanned = update.filesScanned
      progress.currentPath = display(update.currentPath)
      // 遍历阶段占进度条的前 15%（真正耗时的是后面的解析）。
      progress.percent = Math.min(15, Math.round((update.filesScanned / 600) * 15))
      report()
    }
  })

  if (walk.reachedDirectoryLimit) {
    addIssue({
      path: roots[0]?.path ?? '',
      kind: 'unreadable',
      reason: '目录层级太多，为了避免长时间卡住，扫描提前结束了。',
      suggestion: '建议在设置里降低"最大搜索深度"，或改为直接选择 Codex 数据文件夹。'
    })
  }

  if (walk.reachedCandidateLimit) {
    addIssue({
      path: roots[0]?.path ?? '',
      kind: 'unreadable',
      reason: `候选文件太多（已经找到 ${walk.candidates.length} 个），为了不把内存吃光，遍历提前停下了。`,
      suggestion:
        '这个目录里的 JSON 文件太多了。建议改为直接选择 Codex 数据文件夹，或在设置里降低"最大搜索深度"。'
    })
  }

  let candidates = walk.candidates.filter(
    (candidate) => !hidden.has(normalizePathKey(candidate.path, platform))
  )

  if (candidates.length > MAX_CANDIDATE_FILES) {
    addIssue({
      path: roots[0]?.path ?? '',
      kind: 'unreadable',
      reason: `候选文件多达 ${candidates.length} 个，只处理了最近修改的前 ${MAX_CANDIDATE_FILES} 个。`,
      suggestion: '可以在设置里缩小扫描目录范围，或降低搜索深度。'
    })
    candidates = [...candidates].sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, MAX_CANDIDATE_FILES)
  }

  progress.phase = 'parsing'
  progress.candidatesFound = candidates.length
  progress.message = `找到 ${candidates.length} 个候选文件，正在识别…`
  progress.percent = 15
  report(true)

  // 整轮扫描只读一次 Codex 的会话名索引。
  const threadTitles = await loadThreadTitles({ fs, roots: roots.map((root) => root.path) })

  let sessionCount = 0
  let reusedCount = 0
  let parsedFileCount = 0
  const refreshedFileKeys = new Set<string>()

  for (let index = 0; index < candidates.length; index += 1) {
    if (cancellation.cancelled) break

    const candidate = candidates[index] as CandidateFile
    progress.currentPath = display(candidate.path)
    progress.percent = 15 + Math.round(((index + 1) / Math.max(1, candidates.length)) * 85)

    // 文件没变过就直接用上次的结果，一个字节都不用读。
    const known = lookupKnown?.(candidate)
    if (
      known &&
      known.fileSizeBytes === candidate.sizeBytes &&
      known.fileModifiedAt !== null &&
      Math.abs(Date.parse(known.fileModifiedAt) - candidate.modifiedMs) < 1000
    ) {
      onReused?.(known.summaries)
      reusedCount += 1
      sessionCount += known.summaries.length
      progress.sessionsFound = sessionCount
      report()
      continue
    }

    let head: string
    try {
      head = await fs.readHead(candidate.path, FINGERPRINT_HEAD_BYTES)
    } catch (error) {
      addIssue({
        path: candidate.path,
        kind: 'unreadable',
        reason: `无法读取文件内容（${error instanceof Error ? error.message : String(error)}）。`,
        suggestion: '文件可能被其他程序占用，稍后重新扫描即可。'
      })
      continue
    }

    const fingerprint = fingerprintSample(head, candidate.path)
    if (fingerprint.score < settings.confidenceThreshold) {
      addIssue({
        path: candidate.path,
        kind: 'not-a-session',
        reason: `识别可信度只有 ${Math.round(fingerprint.score * 100)}%：${fingerprint.reason}`,
        suggestion:
          '如果你确定这是 Codex 会话，可以在设置里调低"识别门槛"，或用"导入单个文件"强制打开它。'
      })
      continue
    }

    const loaded = await loadSessionsFromFile({
      filePath: candidate.path,
      fileSizeBytes: candidate.sizeBytes,
      modifiedMs: candidate.modifiedMs,
      fs,
      fingerprint,
      homeDir,
      platform,
      threadTitles,
      // 扫描只为算摘要：不留原始 JSON，事件对象在下一轮 GC 就能回收。
      keepRaw: false,
      // 批量扫描要求结构上确实是会话：光看词频，配置文件和崩溃报告也能骗过指纹。
      requireMeaningfulEvents: true
    })
    parsedFileCount += 1
    refreshedFileKeys.add(normalizePathKey(candidate.path, platform))

    for (const issue of loaded.issues) issues.push(issue)
    for (const session of loaded.sessions) {
      onSession(session)
      sessionCount += 1
    }

    progress.sessionsFound = sessionCount
    report()

    // 让出事件循环：否则上千个文件会让主进程完全无响应，取消按钮也点不动。
    await yieldToEventLoop()
  }

  progress.phase = cancellation.cancelled ? 'cancelled' : 'done'
  progress.percent = cancellation.cancelled ? progress.percent : 100
  progress.currentPath = ''
  progress.message = cancellation.cancelled
    ? `扫描已取消，已找到 ${sessionCount} 个会话。`
    : `找到 ${sessionCount} 个 Codex 会话。`
  report(true)

  return {
    sessionCount,
    reusedCount,
    parsedFileCount,
    issues,
    progress,
    cancelled: cancellation.cancelled,
    seenFileKeys,
    refreshedFileKeys,
    enumeratedDirKeys: new Set(walk.enumeratedDirs.map((dir) => normalizePathKey(dir, platform))),
    absentDirKeys: walk.absentDirs.map((dir) => normalizePathKey(dir, platform))
  }
}

/**
 * 直接解析用户手动选择的文件（跳过目录遍历，但仍然做指纹识别）。
 * 手动导入时把识别门槛放宽到 0 —— 用户已经明确说"就是这个文件"。
 */
export async function loadFilesDirectly(args: {
  filePaths: readonly string[]
  fs: FileSystemAccess
  homeDir: string | null
  platform: Platform
  maxFileSizeBytes: number
}): Promise<{ sessions: CodexSession[]; issues: ScanIssue[] }> {
  const { filePaths, fs, homeDir, platform, maxFileSizeBytes } = args
  const sessions: CodexSession[] = []
  const issues: ScanIssue[] = []

  const display = (target: string): string =>
    toDisplayPath(target, { showFullPaths: false, homeDir, platform })

  /*
   * 这里同样要读会话名索引。
   *
   * 这个函数不只服务"导入单个文件"，用户点开一个会话看详情时也走它 ——
   * 少读一次索引，详情页的标题就会和列表里的对不上。
   */
  const threadTitles = await loadThreadTitles({
    fs,
    roots: [...new Set(filePaths.flatMap((filePath) => ancestorDirs(filePath)))]
  })

  for (const filePath of filePaths) {
    let info
    try {
      info = await fs.statPath(filePath)
    } catch (error) {
      issues.push({
        path: filePath,
        displayPath: display(filePath),
        kind: 'unreadable',
        reason: `无法读取这个文件（${error instanceof Error ? error.message : String(error)}）。`,
        suggestion: '确认文件仍然存在，然后重新选择。'
      })
      continue
    }

    if (info.size > maxFileSizeBytes) {
      issues.push({
        path: filePath,
        displayPath: display(filePath),
        kind: 'skipped-large',
        reason: `文件有 ${(info.size / 1024 / 1024).toFixed(1)} MB，超过了当前的大小上限。`,
        suggestion: '可以在设置里提高"单个文件大小上限"后重试。'
      })
      continue
    }

    // 手动导入时读不到文件头也不阻塞：指纹只影响可信度显示，不决定是否解析。
    const head = await fs.readHead(filePath, FINGERPRINT_HEAD_BYTES).catch(() => '')
    const fingerprint = fingerprintSample(head, filePath)

    const loaded = await loadSessionsFromFile({
      filePath,
      fileSizeBytes: info.size,
      modifiedMs: info.mtimeMs,
      fs,
      fingerprint,
      homeDir,
      platform,
      threadTitles
    })

    for (const issue of loaded.issues) issues.push(issue)
    for (const session of loaded.sessions) sessions.push(session)
  }

  return { sessions, issues }
}
