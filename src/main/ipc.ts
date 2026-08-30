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
  ScanResult
} from '@shared/types'
import type { SessionLibrary } from './library'
import { revealInFolder } from './security'

export interface IpcContext {
  library: SessionLibrary
  getWindow: () => BrowserWindow | null
  platform: Platform
  sampleDataAvailable: boolean
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

  ipcMain.handle(IPC.statsGet, () => library.getStats())

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
}
