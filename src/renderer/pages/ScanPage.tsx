import { useState } from 'react'
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FolderSearch,
  Import,
  RefreshCw,
  Search,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide-react'
import type { ScanIssue } from '@shared/types'
import { Button, Card, ProgressBar } from '../components/ui'
import { formatDuration } from '../lib/format'
import { useDisplayPath } from '../lib/displayPath'
import { useApp } from '../hooks/useAppStore'

/** 扫描进行中与扫描结果两个状态共用一个页面。 */
export function ScanPage(): React.JSX.Element {
  const { scanning, progress, lastScan, bootstrap, actions } = useApp()
  const displayPath = useDisplayPath()

  if (scanning || !lastScan) {
    return <ScanningView />
  }

  const found = lastScan.sessions.length

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-3xl px-8 py-12">
        <div className="mb-8">
          <p className="text-[12px] tracking-wide text-ink-faint">
            扫描{lastScan.cancelled ? '已取消' : '完成'}
            {lastScan.durationMs > 0 ? ` · 用时 ${formatDuration(lastScan.durationMs)}` : ''}
          </p>
          <h1 className="mt-1 text-[27px] leading-tight font-semibold text-ink">
            找到 {found} 个 Codex 会话
          </h1>
          {found > 0 ? (
            <p className="mt-2 text-[14px] text-ink-soft">
              共查看了 {progress?.filesScanned ?? 0} 个文件，其中 {progress?.candidatesFound ?? 0}{' '}
              个是可能的会话文件。
            </p>
          ) : null}
        </div>

        {found > 0 ? (
          <>
            <Button variant="primary" size="lg" icon={ArrowRight} onClick={() => actions.setView('sessions')}>
              开始查看这些会话
            </Button>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" icon={RefreshCw} onClick={() => void actions.startScan()}>
                再扫一次
              </Button>
              <Button size="sm" icon={FolderSearch} onClick={() => void actions.pickFolderAndScan()}>
                再扫描其他文件夹
              </Button>
            </div>
          </>
        ) : (
          <Card className="border-tool/35 bg-tool-soft/25">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
              <TriangleAlert size={16} className="text-tool" />
              没找到会话，别担心，试试下面几种办法
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
              最常见的原因是：Codex 把会话存在了别的位置，或者这台电脑上还没有产生过会话记录。
            </p>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <ActionTile
                icon={RefreshCw}
                title="重新扫描"
                description="有时候 Codex 正在写文件，稍等一下再扫一次就有了。"
                onClick={() => void actions.startScan()}
              />
              <ActionTile
                icon={FolderSearch}
                title="选择 Codex 数据文件夹"
                description="如果你知道 Codex 的数据目录，直接指给我看。"
                onClick={() => void actions.pickFolderAndScan()}
              />
              <ActionTile
                icon={FolderSearch}
                title="选择项目文件夹"
                description="有些配置会把会话记录写在项目目录里。"
                onClick={() => void actions.pickFolderAndScan()}
              />
              <ActionTile
                icon={Import}
                title="导入单个 JSON / JSONL 文件"
                description="你手里已经有会话文件时，这是最快的办法。"
                onClick={() => void actions.importFiles()}
              />
              {bootstrap?.sampleDataAvailable ? (
                <ActionTile
                  icon={Sparkles}
                  title="载入示例数据"
                  description="先用内置的虚构示例，看看这个工具长什么样。"
                  onClick={() => void actions.loadSampleData()}
                />
              ) : null}
            </div>

            <details className="mt-4 rounded-lg border border-line bg-surface px-3.5 py-2.5">
              <summary className="cursor-pointer text-[13px] font-medium text-ink">
                可能的文件位置（点开看）
              </summary>
              <ul className="mt-2 space-y-1">
                {(bootstrap?.builtinRoots ?? []).map((root) => (
                  <li key={root.path} className="flex items-baseline gap-2 text-[12px]">
                    <span className="shrink-0 text-ink-faint">{root.label}</span>
                    <span className="min-w-0 flex-1 font-mono break-all text-ink-soft">
                      {displayPath(root.path)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
                会话文件通常叫 rollout-*.jsonl、session-*.json 或 history.jsonl，可以用文件资源管理器搜索
                「*.jsonl」来找。
              </p>
            </details>
          </Card>
        )}

        <IssueList issues={lastScan.issues} />
      </div>
    </div>
  )
}

function ScanningView(): React.JSX.Element {
  const { progress, actions } = useApp()
  const stats = [
    { label: '已扫描文件', value: progress?.filesScanned ?? 0 },
    { label: '已查看目录', value: progress?.dirsVisited ?? 0 },
    { label: '候选文件', value: progress?.candidatesFound ?? 0 },
    { label: '已识别会话', value: progress?.sessionsFound ?? 0 }
  ]

  return (
    <div className="flex h-full items-center justify-center bg-canvas px-8">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
            <Search size={17} />
          </span>
          <div>
            <h1 className="text-[17px] font-semibold text-ink">正在查找 Codex 会话…</h1>
            <p className="text-[12px] text-ink-faint">
              {progress?.message || '正在准备…'}
            </p>
          </div>
        </div>

        <ProgressBar percent={progress?.percent ?? 0} />

        <p className="mt-2 h-4 truncate font-mono text-[11.5px] text-ink-faint" title={progress?.currentPath}>
          {progress?.currentPath || ' '}
        </p>

        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-lg border border-line bg-surface px-3 py-2.5">
              <div className="text-[11px] text-ink-faint">{stat.label}</div>
              <div className="text-[20px] leading-tight font-semibold tabular-nums text-ink">
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6">
          <Button icon={X} onClick={() => void actions.cancelScan()}>
            取消扫描
          </Button>
        </div>

        <p className="mt-5 text-[12px] leading-relaxed text-ink-faint">
          整个过程只在你的电脑上进行：我只读取文件内容用来识别，不会修改、移动或上传任何东西。
        </p>
      </div>
    </div>
  )
}

function ActionTile({
  icon: Icon,
  title,
  description,
  onClick
}: {
  icon: typeof RefreshCw
  title: string
  description: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-3 text-left transition-colors hover:border-accent/45 hover:bg-surface-2"
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-soft">
        <Icon size={14} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{title}</span>
        <span className="block text-[12px] leading-relaxed text-ink-soft">{description}</span>
      </span>
    </button>
  )
}

const ISSUE_LABEL: Record<ScanIssue['kind'], string> = {
  'skipped-large': '文件太大，已跳过',
  unreadable: '读不到这个文件',
  'parse-failed': '内容无法解析',
  'not-a-session': '看起来不是会话文件',
  'partial-records': '部分内容有问题',
  empty: '文件里没有内容',
  busy: '上一次扫描还没结束'
}

/** 把解析问题摊开给用户看：哪个文件、为什么、可以做什么。 */
export function IssueList({ issues }: { issues: readonly ScanIssue[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (issues.length === 0) return null

  // "看起来不是会话文件"是最常见也最不重要的一类，默认折在后面。
  const important = issues.filter((issue) => issue.kind !== 'not-a-session')
  const ordered = [...important, ...issues.filter((issue) => issue.kind === 'not-a-session')]

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2.5 text-left hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown size={14} className="text-ink-faint" />
        ) : (
          <ChevronRight size={14} className="text-ink-faint" />
        )}
        <CircleAlert size={14} className="text-tool" />
        <span className="flex-1 text-[13px] text-ink">
          有 {issues.length} 个文件没能变成会话
          {important.length > 0 ? `（其中 ${important.length} 个值得看一下）` : ''}
        </span>
      </button>

      {open ? (
        <ul className="mt-2 space-y-1.5">
          {ordered.slice(0, 60).map((issue, index) => (
            <li
              key={`${issue.path}-${index}`}
              className="rounded-lg border border-line bg-surface px-3.5 py-2.5"
            >
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10.5px] text-ink-faint">
                  {ISSUE_LABEL[issue.kind]}
                </span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-soft"
                  title={issue.displayPath}
                >
                  {issue.displayPath}
                </span>
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink">{issue.reason}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink-faint">{issue.suggestion}</p>
            </li>
          ))}
          {ordered.length > 60 ? (
            <li className="px-1 text-[12px] text-ink-faint">还有 {ordered.length - 60} 条未显示。</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
