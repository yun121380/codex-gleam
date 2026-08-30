import { useMemo, useState } from 'react'
import {
  CircleAlert,
  Download,
  FolderOpen,
  FolderSearch,
  Import,
  Play,
  Sparkles,
  TriangleAlert
} from 'lucide-react'
import type { ExportFormat, ExportOptions } from '@shared/types'
import { DetailPanel } from '../components/DetailPanel'
import { ExportDialog } from '../components/ExportDialog'
import { SessionList } from '../components/SessionList'
import { Timeline } from '../components/Timeline'
import { Badge, Button, EmptyState, Spinner } from '../components/ui'
import { formatBytes, formatDateTime, formatDuration, truncateMiddle } from '../lib/format'
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
  const { detail, settings } = useApp()
  if (!detail) return null

  const path = settings.showFullPaths ? detail.sourceFile : detail.displaySourceFile

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

        <Button variant="primary" icon={Download} onClick={onExport}>
          导出报告
        </Button>
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
