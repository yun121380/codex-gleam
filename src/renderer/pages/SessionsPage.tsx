import { useEffect, useMemo, useState } from 'react'
import {
  CircleAlert,
  Download,
  FolderOpen,
  FolderSearch,
  Import,
  Play,
  Sparkles,
  Terminal,
  TriangleAlert
} from 'lucide-react'
import type { AppSettings, ExportFormat, ExportOptions, UsageSummary } from '@shared/types'
import { DetailPanel } from '../components/DetailPanel'
import { ExportDialog } from '../components/ExportDialog'
import { SessionList } from '../components/SessionList'
import { Timeline } from '../components/Timeline'
import { Badge, Button, EmptyState, Spinner } from '../components/ui'
import {
  formatBytes,
  formatCost,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatTokens,
  truncateMiddle
} from '../lib/format'
import { buildResumeCommand } from '../lib/resumeCommand'
import { useApp } from '../hooks/useAppStore'

export function SessionsPage(): React.JSX.Element {
  const { sessions, selectedId, detail, detailLoading, settings, bootstrap, actions } = useApp()
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  /**
   * 当前看到第几步。游标记住它属于哪个会话，
   * 于是切换会话时自然回到第一步，不需要用 effect 去重置。
   */
  const [cursor, setCursor] = useState<{ sessionId: string | null; index: number }>({
    sessionId: null,
    index: 0
  })
  const eventIndex = cursor.sessionId === selectedId ? cursor.index : 0
  const setEventIndex = (index: number): void => setCursor({ sessionId: selectedId, index })

  const currentEvent = useMemo(() => {
    if (!detail) return null
    return detail.events[Math.min(eventIndex, detail.events.length - 1)] ?? null
  }, [detail, eventIndex])

  const onExport = async (format: ExportFormat, options: ExportOptions): Promise<void> => {
    if (!selectedId) return
    setExporting(true)
    const result = await actions.exportSession({ sessionId: selectedId, format, options })
    setExporting(false)
    if (result.ok || result.cancelled) setExportOpen(false)
  }

  if (sessions.length === 0) {
    return (
      <div className="h-full bg-canvas">
        <EmptyState
          icon={FolderSearch}
          title="还没有任何会话"
          description="扫描一下常见目录，或者直接导入你手上的会话文件。也可以先用示例数据体验完整流程。"
        >
          <Button variant="primary" icon={Play} onClick={() => void actions.startScan()}>
            开始自动扫描
          </Button>
          <Button icon={FolderSearch} onClick={() => void actions.pickFolderAndScan()}>
            选择文件夹
          </Button>
          <Button icon={Import} onClick={() => void actions.importFiles()}>
            导入文件
          </Button>
          {bootstrap?.sampleDataAvailable ? (
            <Button icon={Sparkles} onClick={() => void actions.loadSampleData()}>
              载入示例数据
            </Button>
          ) : null}
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[300px] shrink-0">
        <SessionList
          sessions={sessions}
          selectedId={selectedId}
          showFullPaths={settings.showFullPaths}
          onSelect={(id) => void actions.selectSession(id)}
          onForget={(id) => void actions.forgetSession(id)}
          onRescan={() => void actions.startScan()}
          onImport={() => void actions.importFiles()}
          onPickFolder={() => void actions.pickFolderAndScan()}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {detail ? (
          <SessionHeader
            onExport={() => setExportOpen(true)}
            onReveal={() => void actions.revealInFolder(detail.sourceFile)}
          />
        ) : null}

        <div className="flex min-h-0 flex-1">
          {detailLoading && !detail ? (
            <div className="flex flex-1 items-center justify-center bg-canvas">
              <Spinner label="正在读取这个会话…" />
            </div>
          ) : detail ? (
            <>
              <div className="w-[430px] shrink-0">
                <Timeline
                  session={detail}
                  selectedIndex={eventIndex}
                  onSelectIndex={setEventIndex}
                  playbackIntervalMs={settings.playbackIntervalMs}
                />
              </div>
              <div className="min-w-0 flex-1">
                <DetailPanel
                  event={currentEvent}
                  showFullPaths={settings.showFullPaths}
                  onRevealFile={(path, baseDir) => void actions.revealInFolder(path, baseDir)}
                />
              </div>
            </>
          ) : (
            <div className="flex-1 bg-canvas">
              <EmptyState
                icon={FolderOpen}
                title="选一个会话看看"
                description="左边列出了所有找到的会话，点任意一个就能看到完整过程。"
              />
            </div>
          )}
        </div>
      </div>

      <ExportDialog
        open={exportOpen}
        busy={exporting}
        sessionTitle={detail?.title ?? ''}
        onClose={() => setExportOpen(false)}
        onConfirm={(format, options) => void onExport(format, options)}
      />
    </div>
  )
}

function SessionHeader({
  onExport,
  onReveal
}: {
  onExport: () => void
  onReveal: () => void
}): React.JSX.Element | null {
  const { detail, settings, bootstrap } = useApp()
  const [copied, setCopied] = useState(false)

  // 复制反馈 1500 ms 后自己消失，与 DetailPanel 里的命令块同一套。
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  if (!detail) return null

  const path = settings.showFullPaths ? detail.sourceFile : detail.displaySourceFile
  const cost = detail.usage
    ? formatCost(
        detail.usage,
        settings.pricePerMillionInput,
        settings.pricePerMillionOutput,
        settings.priceCurrency
      )
    : null

  const resume = buildResumeCommand({
    template: settings.resumeTemplate,
    platform: bootstrap?.platform ?? 'win32',
    // 真实路径，不是 displaySourceFile 那种缩写过的 —— `~\x` 这种路径 cd 不过去。
    // 复制是纯本机动作，showFullPaths 管的是导出产物与界面文本。
    dir: detail.projectPath,
    threadId: detail.agent.threadId
  })

  return (
    <header className="shrink-0 border-b border-line bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="rounded bg-raised px-1.5 py-0.5 text-ink-soft">{detail.projectName}</span>
            <span>{formatDateTime(detail.startedAt)}</span>
            {detail.durationMs > 0 ? <span>持续 {formatDuration(detail.durationMs)}</span> : null}
            <span>{formatBytes(detail.fileSizeBytes)}</span>
          </div>
          <h1 className="mt-0.5 truncate text-[15px] font-semibold text-ink" title={detail.title}>
            {detail.title}
          </h1>
          <button
            type="button"
            onClick={onReveal}
            title={`在文件管理器中定位：${path}`}
            className="mt-0.5 flex max-w-full items-center gap-1 truncate font-mono text-[11.5px] text-ink-faint hover:text-accent-ink"
          >
            <FolderOpen size={11} className="shrink-0" />
            <span className="truncate">{truncateMiddle(path, 78)}</span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {resume.ok ? (
            <Button
              icon={Terminal}
              title={`复制到剪贴板（不会执行）：\n${resume.command}`}
              onClick={() => {
                void navigator.clipboard.writeText(resume.command).then(() => setCopied(true))
              }}
            >
              {copied ? '已复制' : '复制命令'}
            </Button>
          ) : (
            /*
             * 拼不出来时用一句话而不是禁用按钮：ui.tsx 给禁用态加了
             * pointer-events-none，鼠标悬不上去，title 里的原因就永远看不到。
             * 一个说不出原因的灰按钮比一句话更差。
             */
            <span className="max-w-[13rem] text-right text-[11.5px] text-ink-faint" title={resume.detail}>
              {resume.reason}
            </span>
          )}
          <Button variant="primary" icon={Download} onClick={onExport}>
            导出报告
          </Button>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Badge className="bg-neutral-soft text-ink-soft">{detail.eventCount} 步</Badge>
        <Badge className="bg-user-soft text-user">你说 {detail.userMessageCount} 次</Badge>
        <Badge className="bg-assistant-soft text-assistant">
          Codex 回复 {detail.assistantMessageCount} 次
        </Badge>
        <Badge className="bg-shell-soft text-shell">命令 {detail.commandCount}</Badge>
        {detail.failedCommandCount > 0 ? (
          <Badge className="bg-error-soft text-error">
            <CircleAlert size={10} />
            失败命令 {detail.failedCommandCount}
          </Badge>
        ) : null}
        {detail.changedFileCount > 0 ? (
          <Badge className="bg-file-soft text-file">改动文件 {detail.changedFileCount}</Badge>
        ) : null}
        {detail.testsPassed + detail.testsFailed > 0 ? (
          <Badge className={detail.testsFailed > 0 ? 'bg-error-soft text-error' : 'bg-test-soft text-test'}>
            测试 {detail.testsPassed} 通过 / {detail.testsFailed} 失败
          </Badge>
        ) : null}
        {detail.errorCount > 0 ? (
          <Badge className="bg-error-soft text-error">错误 {detail.errorCount}</Badge>
        ) : null}
        <Badge
          className="bg-neutral-soft text-ink-faint"
          title={`识别可信度 ${Math.round(detail.confidenceScore * 100)}%，使用适配器：${detail.parserId}`}
        >
          可信度 {Math.round(detail.confidenceScore * 100)}%
        </Badge>
        {detail.usage ? (
          <Badge
            className="bg-neutral-soft text-ink-soft"
            title={usageTooltip(detail.usage, settings)}
          >
            {formatTokens(detail.usage.totalTokens)} token{cost !== null ? ` · ${cost}` : ''}
          </Badge>
        ) : (
          <Badge
            className="bg-neutral-soft text-ink-faint"
            title="这份日志里没有任何用量记录。显示 0 会是谎报，所以这里什么数字都不给。"
          >
            日志未记录用量
          </Badge>
        )}
      </div>

      {detail.warnings.length > 0 ? (
        <div className="mt-2 space-y-1">
          {detail.warnings.map((warning, index) => (
            <p
              key={index}
              className="flex items-start gap-1.5 rounded-md border border-tool/30 bg-tool-soft/25 px-2.5 py-1.5 text-[12px] leading-relaxed text-ink-soft"
            >
              <TriangleAlert size={12} className="mt-0.5 shrink-0 text-tool" />
              <span>
                {warning.reason}
                <span className="text-ink-faint"> {warning.suggestion}</span>
              </span>
            </p>
          ))}
        </div>
      ) : null}
    </header>
  )
}

/**
 * 用量详情。跟可信度徽标同一个套路：细节全塞进 title，不占版面。
 *
 * 每一行都只在"这条信息真的存在"时才出现 —— 日志只记了总数时，输入/输出
 * 会是 0，那种 0 读起来像"没花钱"，不能显示。
 */
function usageTooltip(usage: UsageSummary, settings: AppSettings): string {
  const lines: string[] = [`总计 ${formatNumber(usage.totalTokens)} token`]

  if (usage.inputTokens + usage.outputTokens > 0) {
    lines.push(`输入 ${formatNumber(usage.inputTokens)} · 输出 ${formatNumber(usage.outputTokens)}`)
  }
  if (usage.cachedInputTokens !== null) {
    lines.push(`其中命中缓存 ${formatNumber(usage.cachedInputTokens)}`)
  }

  lines.push(
    usage.basis === 'cumulative'
      ? '日志记的是累计值，取了最后一条'
      : '日志记的是每轮增量，已逐条相加'
  )

  if (usage.contextWindow !== null) {
    const ratio = Math.round((usage.totalTokens / usage.contextWindow) * 100)
    // 累计用量超过窗口是常态而不是异常：每一轮都会把上下文重发一遍。
    // 这时候写"占用 480%"纯属胡说，得把原因说出来。
    lines.push(
      ratio <= 100
        ? `模型上下文窗口 ${formatNumber(usage.contextWindow)}，这次用掉约 ${ratio}%`
        : `模型上下文窗口 ${formatNumber(usage.contextWindow)}；累计用量已经超过它 —— 每轮都会重发上下文，这是正常的`
    )
  }

  if (usage.byModel.length > 1 || (usage.byModel[0]?.model ?? 'unknown') !== 'unknown') {
    lines.push(...usage.byModel.map((entry) => `${entry.model}：${formatNumber(entry.totalTokens)}`))
  }

  if (settings.pricePerMillionInput === null && settings.pricePerMillionOutput === null) {
    lines.push('想看金额就在设置里填单价')
  } else if (settings.pricePerMillionInput === null || settings.pricePerMillionOutput === null) {
    lines.push('金额只算了你填过的那一半单价')
  }

  return lines.join('\n')
}
