import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AppSettings,
  Bootstrap,
  ExportRequest,
  ExportResult,
  ImportResult,
  Platform,
  ScanRequest,
  ScanResult,
  SearchResponse,
  SelfCheckReport,
  SelfCheckRequest
} from '@shared/types'
import { normalizeSearchRequest } from '@shared/validators'
import type { SessionLibrary } from './library'
import type { FileSystemAccess } from './scanner/fsAccess'
import { revealInFolder } from './security'
import { readBuildEvidence, readDependencyEvidence } from './selfCheck/evidence'
import type { SecurityMonitor } from './selfCheck/monitor'
import { buildSelfCheckReport } from './selfCheck/report'

export interface IpcContext {
  library: SessionLibrary
  getWindow: () => BrowserWindow | null
  platform: Platform
  sampleDataAvailable: boolean
  /** 护栏装上时返回的那个监视器 —— 自检报告里的拦截计数从它来。 */
  securityMonitor: SecurityMonitor
  /** 构建期证据所在目录；开发机上没跑过 `pnpm evidence` 时是 null。 */
  evidenceDir: string | null
  isDev: boolean
  /** 读证据 JSON 用的文件访问；与 library 共用同一个实例。 */
  fs: FileSystemAccess
}

const EXPORT_FILTERS: Record<ExportRequest['format'], Array<{ name: string; extensions: string[] }>> = {
  markdown: [{ name: 'Markdown 报告', extensions: ['md'] }],
  html: [{ name: '网页报告', extensions: ['html'] }],
  json: [{ name: 'JSON 文件', extensions: ['json'] }]
}

export function registerIpcHandlers(context: IpcContext): void {
  const { library, getWindow } = context

  const sendProgress = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  ipcMain.handle(IPC.bootstrap, async (): Promise<Bootstrap> => {
    const [settings, sessions, appState, builtinRoots] = await Promise.all([
      library.getSettings(),
      library.listSessions(),
      library.getAppState(),
      library.getCandidateRoots()
    ])

    return {
      firstRun: !appState.firstRunCompleted,
      settings,
      platform: context.platform,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      sessions,
      builtinRoots,
      homeDir: library.homeDir,
      sampleDataAvailable: context.sampleDataAvailable,
      isPackaged: app.isPackaged
    }
  })

  ipcMain.handle(IPC.completeFirstRun, () => library.markFirstRunCompleted())

  ipcMain.handle(IPC.candidateRoots, () => library.getCandidateRoots())

  ipcMain.handle(IPC.privacyNotice, () => library.getPrivacyNotice())

  ipcMain.handle(IPC.scanStart, async (_event, request?: ScanRequest): Promise<ScanResult> => {
    return library.scan(request, (progress) => sendProgress(IPC.scanProgress, progress))
  })

  ipcMain.handle(IPC.scanCancel, () => {
    library.cancelScan()
  })

  ipcMain.handle(IPC.scanPickFolder, async (): Promise<ScanResult | null> => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: '选择要查找 Codex 会话的文件夹',
          buttonLabel: '就扫描这里',
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    if (result.canceled || result.filePaths.length === 0) return null

    return library.scan({ roots: result.filePaths, merge: true }, (progress) =>
      sendProgress(IPC.scanProgress, progress)
    )
  })

  ipcMain.handle(IPC.sessionsList, () => library.listSessions())

  ipcMain.handle(IPC.sessionGet, (_event, sessionId: string) => library.getSession(sessionId))

  ipcMain.handle(IPC.sessionForget, (_event, sessionId: string) => library.forgetSession(sessionId))

  ipcMain.handle(IPC.sessionsClear, () => library.clearIndex())

  ipcMain.handle(IPC.sessionsImport, async (): Promise<ImportResult> => {
    const window = getWindow()
    const options = {
      title: '选择 Codex 会话文件',
      buttonLabel: '打开',
      filters: [
        { name: 'Codex 会话文件', extensions: ['json', 'jsonl'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections'] as const
    }

    const result = window
      ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: true, cancelled: true, sessions: [], issues: [] }
    }

    return library.importFiles(result.filePaths)
  })

  ipcMain.handle(IPC.sessionsLoadSample, () => library.loadSampleData())

  // 归一化之后再递进去：查询串来自渲染进程，`limit` 可能是字符串、`sessionId`
  // 可能是空串。第一层的预算是"674 个会话 < 200 ms"，多接一个没截断的长查询就
  // 是白花时间。
  ipcMain.handle(IPC.sessionsSearch, (_event, request: unknown): Promise<SearchResponse> =>
    library.searchSessions(normalizeSearchRequest(request))
  )

  ipcMain.handle(IPC.statsGet, () => library.getStats())

  ipcMain.handle(IPC.redactionReport, (_event, sessionId: string) =>
    library.auditSession(sessionId)
  )

  ipcMain.handle(IPC.exportSession, async (_event, request: ExportRequest): Promise<ExportResult> => {
    try {
      const rendered = await library.renderExport(request)
      if (!rendered) {
        return { ok: false, error: '找不到这个会话，可能它已经从索引里移除了。' }
      }

      const window = getWindow()
      const saveOptions = {
        title: '保存会话报告',
        defaultPath: rendered.fileName,
        filters: [...EXPORT_FILTERS[request.format]]
      }

      const result = window
        ? await dialog.showSaveDialog(window, saveOptions)
        : await dialog.showSaveDialog(saveOptions)

      if (result.canceled || !result.filePath) {
        return { ok: false, cancelled: true }
      }

      await writeFile(result.filePath, rendered.content, 'utf8')
      return {
        ok: true,
        filePath: result.filePath,
        byteLength: Buffer.byteLength(rendered.content, 'utf8')
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC.settingsGet, () => library.getSettings())

  ipcMain.handle(IPC.settingsUpdate, (_event, patch: Partial<AppSettings>) =>
    library.updateSettings(patch ?? {})
  )

  ipcMain.handle(IPC.revealInFolder, (_event, targetPath: string, baseDir?: string | null) =>
    revealInFolder(targetPath, baseDir)
  )

  ipcMain.handle(
    IPC.selfCheck,
    async (_event, request?: SelfCheckRequest): Promise<SelfCheckReport> => {
      // 先授权、再读证据，顺序不能倒：从用户点下按钮到授权生效之间的那段时间
      // 要尽量短。读两个 JSON 是毫秒级的事，但排在授权前面就等于白花掉
      // 那 10 秒窗口预算的一部分。
      const probeArm =
        typeof request?.armProbe === 'string'
          ? context.securityMonitor.armProbe(request.armProbe)
          : null

      const [build, dependencies] = await Promise.all([
        readBuildEvidence(context.fs, context.evidenceDir),
        readDependencyEvidence(context.fs, context.evidenceDir)
      ])

      // 这里不 try/catch：证据读取器已经把文件层面的岔子变成了 issues（它不抛），
      // 真能冒到这儿的只剩编程错误——那种东西该响，不该被静默成一份空报告。
      return buildSelfCheckReport({
        monitor: context.securityMonitor.snapshot(),
        build: build.evidence,
        dependencies: dependencies.evidence,
        evidenceIssues: [...build.issues, ...dependencies.issues],
        isDev: context.isDev,
        probeArm
      })
    }
  )
}
