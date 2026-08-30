import {
  ChartColumn,
  CircleCheckBig,
  Info,
  Layers,
  Search,
  Settings,
  Shield,
  TriangleAlert,
  WifiOff,
  X
} from 'lucide-react'
import { APP_NAME } from '@shared/constants'
import { Spinner } from './components/ui'
import { cx } from './lib/format'
import { useApp, type AppView } from './hooks/useAppStore'
import { PrivacyPage } from './pages/PrivacyPage'
import { ScanPage } from './pages/ScanPage'
import { SessionsPage } from './pages/SessionsPage'
import { SettingsPage } from './pages/SettingsPage'
import { StatsPage } from './pages/StatsPage'
import { WelcomePage } from './pages/WelcomePage'

const NAV: Array<{ view: AppView; label: string; icon: typeof Layers }> = [
  { view: 'sessions', label: '会话', icon: Layers },
  { view: 'stats', label: '统计', icon: ChartColumn },
  { view: 'settings', label: '设置', icon: Settings },
  { view: 'privacy', label: '隐私', icon: Shield }
]

export function App(): React.JSX.Element {
  const { ready, view, sessions, scanning, notice, actions } = useApp()

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <Spinner label="正在读取本地数据…" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[62px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-3">
          {NAV.map((item) => (
            <button
              key={item.view}
              type="button"
              title={item.label}
              onClick={() => actions.setView(item.view)}
              className={cx(
                'flex w-[50px] flex-col items-center gap-0.5 rounded-lg py-2 text-[10.5px] transition-colors',
                view === item.view
                  ? 'bg-accent-soft text-accent-ink'
                  : 'text-ink-faint hover:bg-raised hover:text-ink-soft'
              )}
            >
              <item.icon size={17} />
              {item.label}
            </button>
          ))}

          <div className="mt-auto flex flex-col items-center gap-1">
            <button
              type="button"
              title="重新扫描"
              onClick={() => void actions.startScan()}
              disabled={scanning}
              className={cx(
                'flex w-[50px] flex-col items-center gap-0.5 rounded-lg py-2 text-[10.5px] transition-colors',
                scanning
                  ? 'pointer-events-none text-ink-faint opacity-50'
                  : 'text-ink-faint hover:bg-raised hover:text-ink-soft'
              )}
            >
              <Search size={17} />
              扫描
            </button>
            <span
              title="本应用完全离线运行，所有网络请求都被拦截"
              className="mb-1 flex h-7 w-7 items-center justify-center rounded-lg text-file"
            >
              <WifiOff size={15} />
            </span>
          </div>
        </nav>

        <main className="min-w-0 flex-1">
          {view === 'welcome' ? (
            <WelcomePage />
          ) : view === 'scanning' ? (
            <ScanPage />
          ) : view === 'stats' ? (
            <StatsPage />
          ) : view === 'settings' ? (
            <SettingsPage />
          ) : view === 'privacy' ? (
            <PrivacyPage />
          ) : (
            <SessionsPage />
          )}
        </main>
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-line bg-surface px-3 py-1.5 text-[11px] text-ink-faint">
        <span>{APP_NAME}</span>
        <span>已索引 {sessions.length} 个会话</span>
        <span className="ml-auto">数据只保存在本机 · 不联网 · 不执行日志里的命令</span>
      </footer>

      {notice ? (
        <div className="pointer-events-none fixed bottom-8 left-1/2 z-50 -translate-x-1/2">
          <div
            className={cx(
              'pointer-events-auto flex max-w-[70vw] items-start gap-2 rounded-xl border px-3.5 py-2.5 shadow-xl',
              notice.tone === 'ok'
                ? 'border-file/40 bg-file-soft text-ink'
                : notice.tone === 'warn'
                  ? 'border-error/40 bg-error-soft text-ink'
                  : 'border-line bg-surface text-ink'
            )}
          >
            {notice.tone === 'ok' ? (
              <CircleCheckBig size={15} className="mt-0.5 shrink-0 text-file" />
            ) : notice.tone === 'warn' ? (
              <TriangleAlert size={15} className="mt-0.5 shrink-0 text-error" />
            ) : (
              <Info size={15} className="mt-0.5 shrink-0 text-ink-soft" />
            )}
            <span className="text-[12.5px] leading-relaxed break-words">{notice.text}</span>
            <button
              type="button"
              onClick={actions.dismissNotice}
              title="关闭提示"
              className="mt-0.5 shrink-0 rounded p-0.5 text-ink-faint hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function TitleBar(): React.JSX.Element {
  const { view, sessions, actions } = useApp()

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-[13px] font-bold text-canvas">
          C
        </span>
        <span className="text-[13.5px] font-semibold text-ink">{APP_NAME}</span>
      </div>
      <span className="text-[11.5px] text-ink-faint">看懂你和 Codex 一起做过的每一步</span>

      {view === 'welcome' && sessions.length > 0 ? (
        <button
          type="button"
          onClick={() => actions.setView('sessions')}
          className="ml-auto text-[12px] text-accent-ink hover:underline"
        >
          直接进入会话列表
        </button>
      ) : null}
    </header>
  )
}
