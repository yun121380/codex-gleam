import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  AppSettings,
  Bootstrap,
  CodexSession,
  ExportRequest,
  ExportResult,
  ScanIssue,
  ScanProgress,
  ScanResult,
  SessionSummary,
  StatsOverview
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'

export type AppView = 'welcome' | 'scanning' | 'sessions' | 'stats' | 'settings' | 'privacy'

interface AppState {
  ready: boolean
  bootstrap: Bootstrap | null
  settings: AppSettings
  sessions: SessionSummary[]
  issues: ScanIssue[]
  lastScan: ScanResult | null
  scanning: boolean
  progress: ScanProgress | null
  view: AppView
  selectedId: string | null
  detail: CodexSession | null
  detailLoading: boolean
  notice: { tone: 'info' | 'ok' | 'warn'; text: string } | null
}

interface AppActions {
  setView: (view: AppView) => void
  startScan: (roots?: string[]) => Promise<void>
  cancelScan: () => Promise<void>
  pickFolderAndScan: () => Promise<void>
  importFiles: () => Promise<void>
  loadSampleData: () => Promise<void>
  selectSession: (sessionId: string | null) => Promise<void>
  forgetSession: (sessionId: string) => Promise<void>
  clearIndex: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  completeFirstRun: () => Promise<void>
  refreshSessions: () => Promise<void>
  loadStats: () => Promise<StatsOverview | null>
  exportSession: (request: ExportRequest) => Promise<ExportResult>
  /** baseDir 用来解析相对路径（日志里的文件路径常常是相对工作目录的）。 */
  revealInFolder: (path: string, baseDir?: string | null) => Promise<void>
  dismissNotice: () => void
  showNotice: (tone: 'info' | 'ok' | 'warn', text: string) => void
}

type AppStore = AppState & { actions: AppActions }

const AppContext = createContext<AppStore | null>(null)

function api(): Window['gleam'] {
  return window.gleam
}

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AppState>({
    ready: false,
    bootstrap: null,
    settings: DEFAULT_SETTINGS,
    sessions: [],
    issues: [],
    lastScan: null,
    scanning: false,
    progress: null,
    view: 'welcome',
    selectedId: null,
    detail: null,
    detailLoading: false,
    notice: null
  })

  const noticeTimer = useRef<number | null>(null)

  const patch = useCallback((next: Partial<AppState>) => {
    setState((current) => ({ ...current, ...next }))
  }, [])

  const showNotice = useCallback(
    (tone: 'info' | 'ok' | 'warn', text: string) => {
      patch({ notice: { tone, text } })
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
      noticeTimer.current = window.setTimeout(() => patch({ notice: null }), 6000)
    },
    [patch]
  )

  const loadDetail = useCallback(
    async (sessionId: string | null) => {
      if (sessionId === null) {
        patch({ selectedId: null, detail: null, detailLoading: false })
        return
      }
      patch({ selectedId: sessionId, detailLoading: true })
      try {
        const detail = await api().getSession(sessionId)
        setState((current) =>
          current.selectedId === sessionId
            ? { ...current, detail, detailLoading: false }
            : { ...current, detailLoading: false }
        )
        if (!detail) showNotice('warn', '这个会话的原始文件可能已被移动或删除，无法打开。')
      } catch (error) {
        patch({ detailLoading: false })
        showNotice('warn', `打开会话失败：${describeError(error)}`)
      }
    },
    [patch, showNotice]
  )

  // 首次载入：读取索引与设置，决定进入欢迎页还是主界面，并顺手打开第一个会话。
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const bootstrap = await api().getBootstrap()
        if (cancelled) return
        const firstId = bootstrap.sessions[0]?.id ?? null
        patch({
          ready: true,
          bootstrap,
          settings: bootstrap.settings,
          sessions: bootstrap.sessions,
          view: bootstrap.firstRun && bootstrap.sessions.length === 0 ? 'welcome' : 'sessions',
          selectedId: firstId
        })
        if (firstId) await loadDetail(firstId)
      } catch (error) {
        if (cancelled) return
        patch({ ready: true })
        showNotice('warn', `启动时读取本地数据失败：${describeError(error)}`)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [loadDetail, patch, showNotice])

  // 扫描进度订阅。
  useEffect(() => {
    const unsubscribe = api().onScanProgress((progress) => {
      setState((current) => ({ ...current, progress }))
    })
    return unsubscribe
  }, [])

  // 主题跟随设置。
  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme
  }, [state.settings.theme])

  /**
   * 扫描结束后停在扫描页展示结果（"找到 X 个会话"），由用户点击进入列表。
   * 这样即使一个都没找到，也有地方放"接下来可以试什么"的引导。
   */
  const applyScanResult = useCallback(
    (result: ScanResult) => {
      const firstId = result.sessions[0]?.id ?? null
      let nextSelected: string | null = firstId

      setState((current) => {
        nextSelected =
          current.selectedId && result.sessions.some((session) => session.id === current.selectedId)
            ? current.selectedId
            : firstId
        return {
          ...current,
          sessions: result.sessions,
          issues: result.issues,
          lastScan: result,
          scanning: false,
          view: 'scanning',
          selectedId: nextSelected
        }
      })

      if (nextSelected) void loadDetail(nextSelected)
    },
    [loadDetail]
  )

  const startScan = useCallback(
    async (roots?: string[]) => {
      patch({
        scanning: true,
        view: 'scanning',
        progress: {
          phase: 'walking',
          currentPath: '',
          dirsVisited: 0,
          filesScanned: 0,
          candidatesFound: 0,
          sessionsFound: 0,
          percent: 0,
          message: '正在准备…'
        }
      })
      try {
        const request = roots && roots.length > 0 ? { roots, merge: true } : undefined
        const result = await api().startScan(request)
        applyScanResult(result)
      } catch (error) {
        patch({ scanning: false, view: 'sessions' })
        showNotice('warn', `扫描失败：${describeError(error)}`)
      }
    },
    [applyScanResult, patch, showNotice]
  )

  const actions = useMemo<AppActions>(
    () => ({
      setView: (view) => patch({ view }),

      startScan,

      cancelScan: async () => {
        await api().cancelScan()
      },

      pickFolderAndScan: async () => {
        try {
          patch({ scanning: true, view: 'scanning' })
          const result = await api().pickFolderAndScan()
          if (!result) {
            patch({ scanning: false, view: state.sessions.length > 0 ? 'sessions' : 'welcome' })
            return
          }
          applyScanResult(result)
        } catch (error) {
          patch({ scanning: false, view: 'sessions' })
          showNotice('warn', `扫描所选文件夹失败：${describeError(error)}`)
        }
      },

      importFiles: async () => {
        try {
          const result = await api().importFiles()
          if (result.cancelled) return
          if (!result.ok && result.sessions.length === 0) {
            const reason = result.issues[0]?.reason ?? '这个文件里没有找到会话内容。'
            showNotice('warn', reason)
          }
          const sessions = await api().listSessions()
          const firstNew = result.sessions[0]?.id ?? null
          patch({
            sessions,
            issues: result.issues,
            view: 'sessions',
            ...(firstNew ? { selectedId: firstNew } : {})
          })
          if (firstNew) void loadDetail(firstNew)
          if (result.sessions.length > 0) {
            showNotice('ok', `已导入 ${result.sessions.length} 个会话。`)
          }
        } catch (error) {
          showNotice('warn', `导入失败：${describeError(error)}`)
        }
      },

      loadSampleData: async () => {
        try {
          const result = await api().loadSampleData()
          if (!result.ok) {
            showNotice('warn', result.error ?? '载入示例数据失败。')
            return
          }
          const sessions = await api().listSessions()
          const firstNew = result.sessions[0]?.id ?? sessions[0]?.id ?? null
          patch({
            sessions,
            issues: result.issues,
            view: 'sessions',
            ...(firstNew ? { selectedId: firstNew } : {})
          })
          if (firstNew) void loadDetail(firstNew)
          showNotice('ok', `已载入 ${result.sessions.length} 个示例会话，可以随便点着看。`)
        } catch (error) {
          showNotice('warn', `载入示例数据失败：${describeError(error)}`)
        }
      },

      selectSession: loadDetail,

      forgetSession: async (sessionId) => {
        try {
          const sessions = await api().forgetSession(sessionId)
          const nextId = sessions[0]?.id ?? null
          patch({ sessions })
          if (sessionId === state.selectedId) await loadDetail(nextId)
          showNotice('ok', '已从本地索引中移除（原始文件没有被删除）。')
        } catch (error) {
          showNotice('warn', `移除失败：${describeError(error)}`)
        }
      },

      clearIndex: async () => {
        try {
          const sessions = await api().clearIndex()
          patch({ sessions, detail: null, selectedId: null, issues: [] })
          showNotice('ok', '本地索引已清空，你的原始会话文件没有任何变化。')
        } catch (error) {
          showNotice('warn', `清空索引失败：${describeError(error)}`)
        }
      },

      updateSettings: async (settingsPatch) => {
        try {
          const settings = await api().updateSettings(settingsPatch)
          patch({ settings })
          // 打码开关会影响已展示的内容，需要重新取一次。
          if ('redactSensitive' in settingsPatch) {
            const sessions = await api().listSessions()
            patch({ sessions })
            if (state.selectedId) await loadDetail(state.selectedId)
          }
        } catch (error) {
          showNotice('warn', `保存设置失败：${describeError(error)}`)
        }
      },

      completeFirstRun: async () => {
        try {
          await api().completeFirstRun()
        } catch {
          // 首次引导标记失败不影响使用。
        }
      },

      refreshSessions: async () => {
        try {
          const sessions = await api().listSessions()
          patch({ sessions })
        } catch (error) {
          showNotice('warn', `刷新列表失败：${describeError(error)}`)
        }
      },

      loadStats: async () => {
        try {
          return await api().getStats()
        } catch (error) {
          showNotice('warn', `统计失败：${describeError(error)}`)
          return null
        }
      },

      exportSession: async (request) => {
        try {
          const result = await api().exportSession(request)
          if (result.ok && result.filePath) {
            showNotice('ok', `报告已保存到：${result.filePath}`)
          } else if (result.error) {
            showNotice('warn', `导出失败：${result.error}`)
          }
          return result
        } catch (error) {
          const message = describeError(error)
          showNotice('warn', `导出失败：${message}`)
          return { ok: false, error: message }
        }
      },

      revealInFolder: async (path, baseDir) => {
        try {
          const ok = await api().revealInFolder(path, baseDir)
          if (!ok) showNotice('warn', '找不到这个文件，它可能已经被移动或删除了。')
        } catch (error) {
          showNotice('warn', `打开文件位置失败：${describeError(error)}`)
        }
      },

      dismissNotice: () => patch({ notice: null }),
      showNotice
    }),
    [applyScanResult, loadDetail, patch, showNotice, startScan, state.selectedId, state.sessions]
  )

  const value = useMemo<AppStore>(() => ({ ...state, actions }), [state, actions])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppStore {
  const store = useContext(AppContext)
  if (!store) throw new Error('useApp 必须在 AppProvider 内部使用。')
  return store
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Electron 的 IPC 错误会带一长串前缀，这里只保留最后一句有用的。
    const message = error.message.split(': ').pop() ?? error.message
    return message
  }
  return String(error)
}
