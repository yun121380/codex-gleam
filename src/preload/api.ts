import { ipcRenderer } from 'electron'
import { IPC, type GleamApi } from '@shared/ipc'
import type {
  AppSettings,
  ExportRequest,
  ScanProgress,
  ScanRequest,
  SearchRequest,
  SelfCheckRequest
} from '@shared/types'

/**
 * 渲染进程能拿到的全部能力。
 *
 * 每个方法都只是一次 IPC 调用 —— 这里没有 fs、没有 path、没有 child_process，
 * 也没有把整个 ipcRenderer 暴露出去（那等于开后门）。
 */
export const gleamApi: GleamApi = {
  getBootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  completeFirstRun: () => ipcRenderer.invoke(IPC.completeFirstRun),
  getCandidateRoots: () => ipcRenderer.invoke(IPC.candidateRoots),
  getPrivacyNotice: () => ipcRenderer.invoke(IPC.privacyNotice),

  startScan: (request?: ScanRequest) => ipcRenderer.invoke(IPC.scanStart, request),
  cancelScan: () => ipcRenderer.invoke(IPC.scanCancel),
  onScanProgress: (listener: (progress: ScanProgress) => void) => {
    const handler = (_event: unknown, progress: ScanProgress): void => listener(progress)
    ipcRenderer.on(IPC.scanProgress, handler)
    return () => {
      ipcRenderer.removeListener(IPC.scanProgress, handler)
    }
  },
  pickFolderAndScan: () => ipcRenderer.invoke(IPC.scanPickFolder),

  listSessions: () => ipcRenderer.invoke(IPC.sessionsList),
  getSession: (sessionId: string) => ipcRenderer.invoke(IPC.sessionGet, sessionId),
  forgetSession: (sessionId: string) => ipcRenderer.invoke(IPC.sessionForget, sessionId),
  clearIndex: () => ipcRenderer.invoke(IPC.sessionsClear),
  importFiles: () => ipcRenderer.invoke(IPC.sessionsImport),
  loadSampleData: () => ipcRenderer.invoke(IPC.sessionsLoadSample),
  searchSessions: (request: SearchRequest) => ipcRenderer.invoke(IPC.sessionsSearch, request),

  getStats: () => ipcRenderer.invoke(IPC.statsGet),
  exportSession: (request: ExportRequest) => ipcRenderer.invoke(IPC.exportSession, request),
  auditRedaction: (sessionId: string) => ipcRenderer.invoke(IPC.redactionReport, sessionId),

  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch),

  revealInFolder: (targetPath: string, baseDir?: string | null) =>
    ipcRenderer.invoke(IPC.revealInFolder, targetPath, baseDir ?? null),

  readSelfCheck: (request?: SelfCheckRequest) => ipcRenderer.invoke(IPC.selfCheck, request)
}
