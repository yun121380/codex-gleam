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
  RedactionReport,
  ScanIssue,
  ScanProgress,
  ScanResult,
  SearchHit,
  SearchResponse,
  SessionSummary,
  StatsOverview
} from '@shared/types'
import {
  DEFAULT_SETTINGS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MAX_HITS_PER_SESSION
} from '@shared/constants'
import { shouldSearchFullText } from '../lib/searchNotice'

export type AppView =
  | 'welcome'
  | 'scanning'
  | 'sessions'
  | 'stats'
  | 'settings'
  | 'privacy'
  // 自检不在主导航里：它是「想核对的时候去看一眼」，不是日常操作。
  // 入口挂在那个 WifiOff 徽标上和隐私页里。
  | 'self-check'

/**
 * 当前打开的会话里，那些命中落在哪几步上。
 *
 * `sessionId` 与 `query` 跟着一起存，界面才能判断"这份命中是不是这个会话、这次查询的"
 * —— 第二层请求还在路上时，这两样用户都可能已经改掉了。
 */
export interface SessionHits {
  sessionId: string
  query: string
  /** 事件顺序，一个事件最多一处（见 `locate.ts` 里那条约定）。 */
  hits: SearchHit[]
  /** 撞到了每会话命中上限，真实数量比 `hits.length` 更多。 */
  capped: boolean
  /** 这个会话是第一层给出的候选之一。0 命中时靠它决定该说哪句话。 */
  candidate: boolean
}

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
  /** 搜索框里的原文。列表的本地过滤直接读它，所以它必须是同步更新的。 */
  searchQuery: string
  /** 最近一次全文查询的结果。`null` = 没搜过 / 查询串还太短。 */
  searchResult: SearchResponse | null
  /**
   * 当前打开的会话里的命中位置。`null` = 没查过，或者手上那份已经对不上当前查询了。
   *
   * 读到的是过滤后的值（见 provider 末尾那段派生）；内部 state 里可能还留着一份旧的。
   */
  sessionHits: SessionHits | null
  /**
   * 当前会话的打码报告。`null` = 没审计过，或者刚换了会话。
   *
   * 换会话时必须清掉。上一个会话的报告留在这儿，是这一期最容易犯的那种展示型
   * 泄露：面板顶上写着 B 会话的标题，列出来的却是 A 会话里的东西。
   */
  redactionReport: RedactionReport | null
  /** 审计在跑。审计要把原始文件重新读一遍，慢到必须让人看见它在动。 */
  auditing: boolean
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
  /**
   * 审计一个会话，把报告填进 `redactionReport`。
   *
   * 报告只进内存：不写文件，也不进导出产物。点开面板时调一次。
   */
  auditRedaction: (sessionId: string) => Promise<void>
  /** baseDir 用来解析相对路径（日志里的文件路径常常是相对工作目录的）。 */
  revealInFolder: (path: string, baseDir?: string | null) => Promise<void>
  dismissNotice: () => void
  showNotice: (tone: 'info' | 'ok' | 'warn', text: string) => void
  /**
   * 改搜索框。查询串**立刻**进 state（本地过滤即时生效），全文查询防抖 200 ms 再发。
   */
  setSearchQuery: (query: string) => void
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
    notice: null,
    searchQuery: '',
    searchResult: null,
    sessionHits: null,
    redactionReport: null,
    auditing: false
  })

  const noticeTimer = useRef<number | null>(null)
  const searchTimer = useRef<number | null>(null)
  /**
   * 请求序号。回来的结果对不上当前序号就整份丢掉。
   *
   * 不做取消：第一层查询是毫秒级的，取消机制的复杂度不值得；而"打字快时结果在
   * 几次查询之间跳"是真的会被看见的毛病。
   */
  const searchSeq = useRef(0)

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

  const runSearch = useCallback(
    async (query: string, seq: number) => {
      try {
        const response = await api().searchSessions({ query })
        // 对不上号说明用户又打字了，这份结果已经是旧的。
        if (seq !== searchSeq.current) return
        patch({ searchResult: response })
      } catch (error) {
        if (seq !== searchSeq.current) return
        // 搜索失败时**清掉**上一份结果而不是留着：留着等于拿旧查询的命中冒充新查询的。
        patch({ searchResult: null })
        showNotice('warn', `搜索失败：${describeError(error)}`)
      }
    },
    [patch, showNotice]
  )

  const setSearchQuery = useCallback(
    (query: string) => {
      // 这一次 patch 是同步的，列表的本地过滤靠它保持"打一个字立刻筛"的手感。
      patch({ searchQuery: query })

      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
      // 序号先加，再决定发不发：在飞的那次请求从此刻起就作废了，哪怕它马上回来。
      searchSeq.current += 1

      if (!shouldSearchFullText(query)) {
        patch({ searchResult: null })
        return
      }

      const seq = searchSeq.current
      searchTimer.current = window.setTimeout(() => void runSearch(query, seq), SEARCH_DEBOUNCE_MS)
    },
    [patch, runSearch]
  )

  // 卸载时把两个计时器都停掉：它们的回调会 setState。
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
    },
    []
  )

  const loadDetail = useCallback(
    async (sessionId: string | null) => {
      // 打码报告跟着会话走。它不像 `sessionHits` 那样在读的一侧过滤新鲜度，
      // 所以这里就得清干净 —— 面板里挂着上一个会话的密钥清单是彻底的错。
      if (sessionId === null) {
        patch({
          selectedId: null,
          detail: null,
          detailLoading: false,
          redactionReport: null,
          auditing: false
        })
        return
      }
      patch({
        selectedId: sessionId,
        detailLoading: true,
        redactionReport: null,
        auditing: false
      })
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
   * 第二层查询：点开一个会话、或者查询串变了，就把**这一个**会话解析一遍，定位命中的位置。
   *
   * 触发条件挂在 `searchResult` 而不是 `searchQuery` 上，图的是它两件现成的好处：它已经
   * 防抖过（不会每敲一个字就去解析一次文件），而且它带着第一层的候选名单 —— 0 命中时要靠
   * 那份名单决定该说哪句话。没有查询串时它是 `null`，于是"平常点开一个会话"这条路上一次
   * 多余的解析都不会有。
   */
  useEffect(() => {
    const sessionId = state.selectedId
    const result = state.searchResult

    // 没有查询串（或者会话都没选）时什么都不发。state 里可能还留着上一次的命中，
    // 但它过不了下面那道"对得上当前查询"的新鲜度检查，界面上不会显示。
    if (sessionId === null || result === null) return

    let cancelled = false

    void (async () => {
      try {
        const response = await api().searchSessions({ query: result.query, sessionId })
        if (cancelled) return
        setState((current) =>
          current.selectedId === sessionId
            ? {
                ...current,
                sessionHits: {
                  sessionId,
                  query: result.query,
                  hits: response.hits,
                  capped: response.hits.length >= SEARCH_MAX_HITS_PER_SESSION,
                  candidate: result.sessionIds.includes(sessionId)
                }
              }
            : current
        )
      } catch (error) {
        if (cancelled) return
        setState((current) =>
          current.selectedId === sessionId ? { ...current, sessionHits: null } : current
        )
        showNotice('warn', `在这个会话里定位命中失败：${describeError(error)}`)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [showNotice, state.searchResult, state.selectedId])

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
          // 搜索结果一起清掉：它说的"命中 N 个会话"指的是刚被清空的那些会话。
          patch({
            sessions,
            detail: null,
            selectedId: null,
            issues: [],
            searchQuery: '',
            searchResult: null,
            redactionReport: null,
            auditing: false
          })
          showNotice('ok', '本地索引已清空，你的原始会话文件没有任何变化。')
        } catch (error) {
          showNotice('warn', `清空索引失败：${describeError(error)}`)
        }
      },

      updateSettings: async (settingsPatch) => {
        try {
          const settings = await api().updateSettings(settingsPatch)
          patch({ settings })
          // 全文索引开关一动，上一份全文结果就不再代表磁盘上的东西了。
          if ('buildSearchIndex' in settingsPatch) patch({ searchResult: null })
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

      auditRedaction: async (sessionId) => {
        patch({ auditing: true })
        try {
          const report = await api().auditRedaction(sessionId)
          // 审计要把原始文件整份重读一遍，回来时用户可能已经换了会话 —— 这份报告
          // 说的不是他现在看着的会话，只能丢掉，不能填进去。
          setState((current) =>
            current.selectedId === sessionId
              ? { ...current, redactionReport: report, auditing: false }
              : { ...current, auditing: false }
          )
          // `null` 的意思是"没审计成"，不是"很干净"。这两句话在这里必须分开说。
          if (!report) {
            showNotice('warn', '没能审计这个会话，它的原始文件可能已被移动或删除。')
          }
        } catch (error) {
          patch({ auditing: false, redactionReport: null })
          showNotice('warn', `审计失败：${describeError(error)}`)
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
      showNotice,
      setSearchQuery
    }),
    [
      applyScanResult,
      loadDetail,
      patch,
      setSearchQuery,
      showNotice,
      startScan,
      state.selectedId,
      state.sessions
    ]
  )

  /**
   * 命中只在"还对得上当前会话、当前查询"时才算数 —— 这道检查放在读的一侧做，
   * 而不是在上面那个 effect 里同步清一次 state。
   *
   * 好处不只是省掉一次级联渲染：清空的写法要等 effect 跑完才生效，而这里是**当帧**生效 ——
   * 用户清掉搜索框、或者改了查询串的那一刻，旧查询的"命中 3 处"就不再出现在头部，
   * 不会挂着等第二层的下一趟请求回来。state 里那份残留会被下一次成功的响应盖掉。
   */
  const sessionHits = useMemo(() => {
    const hits = state.sessionHits
    if (hits === null || state.searchResult === null) return null
    return hits.sessionId === state.selectedId && hits.query === state.searchResult.query
      ? hits
      : null
  }, [state.searchResult, state.selectedId, state.sessionHits])

  const value = useMemo<AppStore>(
    () => ({ ...state, sessionHits, actions }),
    [state, sessionHits, actions]
  )

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
