import type {
  AppSettings,
  Bootstrap,
  CandidateRoot,
  CodexSession,
  ExportRequest,
  ExportResult,
  ImportResult,
  PrivacyNotice,
  RedactionReport,
  ScanProgress,
  ScanRequest,
  ScanResult,
  SearchRequest,
  SearchResponse,
  SessionSummary,
  StatsOverview
} from './types'

/** 全部 IPC 频道名。渲染进程只能通过 preload 暴露的方法访问这些频道。 */
export const IPC = {
  bootstrap: 'app:bootstrap',
  completeFirstRun: 'app:complete-first-run',
  candidateRoots: 'app:candidate-roots',
  privacyNotice: 'app:privacy-notice',

  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',
  scanProgress: 'scan:progress',
  scanPickFolder: 'scan:pick-folder',

  sessionsList: 'sessions:list',
  sessionGet: 'sessions:get',
  sessionForget: 'sessions:forget',
  sessionsClear: 'sessions:clear',
  sessionsImport: 'sessions:import',
  sessionsLoadSample: 'sessions:load-sample',
  sessionsSearch: 'sessions:search',

  statsGet: 'stats:get',
  exportSession: 'export:session',
  redactionReport: 'redaction:report',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  revealInFolder: 'os:reveal-in-folder'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * preload 通过 contextBridge 暴露给渲染进程的全部能力。
 * 渲染进程没有 Node.js 访问权限，只能调用这些方法。
 */
export interface GleamApi {
  getBootstrap(): Promise<Bootstrap>
  completeFirstRun(): Promise<void>
  getCandidateRoots(): Promise<CandidateRoot[]>
  getPrivacyNotice(): Promise<PrivacyNotice>

  startScan(request?: ScanRequest): Promise<ScanResult>
  cancelScan(): Promise<void>
  /** 订阅扫描进度；返回取消订阅函数。 */
  onScanProgress(listener: (progress: ScanProgress) => void): () => void
  /** 让用户选择一个文件夹并立即扫描；用户取消时返回 null。 */
  pickFolderAndScan(): Promise<ScanResult | null>

  listSessions(): Promise<SessionSummary[]>
  getSession(sessionId: string): Promise<CodexSession | null>
  /** 只从本地索引移除，绝不删除原始文件。 */
  forgetSession(sessionId: string): Promise<SessionSummary[]>
  clearIndex(): Promise<SessionSummary[]>
  importFiles(): Promise<ImportResult>
  loadSampleData(): Promise<ImportResult>
  /**
   * 跨会话搜索。不带 `sessionId` 是第一层（哪些会话里有这些词），带上就多跑一层
   * 定位（这个会话里命中在哪几条事件上）。两种都走同一个频道，省掉一次往返。
   */
  searchSessions(request: SearchRequest): Promise<SearchResponse>

  getStats(): Promise<StatsOverview>
  exportSession(request: ExportRequest): Promise<ExportResult>
  /**
   * 这一次打码的旁路报告：打掉了什么、什么判过之后没打。
   *
   * 报告里只有打过码的上下文，**没有原值**；会话不存在时返回 `null`，而不是一份空报告。
   */
  auditRedaction(sessionId: string): Promise<RedactionReport | null>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  /**
   * 在系统文件管理器中定位文件（本地操作，不涉及网络）。
   * baseDir 用来解析相对路径 —— 日志里记的常常就是 `src/app.ts` 这种。
   */
  revealInFolder(targetPath: string, baseDir?: string | null): Promise<boolean>
}
