import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  FolderOpen,
  FolderSearch,
  Import,
  Play,
  Shield,
  Sparkles,
  Terminal,
  TriangleAlert
} from 'lucide-react'
import type { AppSettings, ExportFormat, ExportOptions, UsageSummary } from '@shared/types'
import { SEARCH_MAX_HITS_PER_SESSION } from '@shared/constants'
import { DetailPanel } from '../components/DetailPanel'
import { ExportDialog } from '../components/ExportDialog'
import { RedactionReportDialog } from '../components/RedactionReportDialog'
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
import { useApp, type SessionHits } from '../hooks/useAppStore'

export function SessionsPage(): React.JSX.Element {
  const {
    sessions,
    selectedId,
    detail,
    detailLoading,
    settings,
    bootstrap,
    searchQuery,
    searchResult,
    sessionHits,
    redactionReport,
    auditing,
    actions
  } = useApp()
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)

  /**
   * 当前看到第几步。游标记住它属于哪个会话，
   * 于是切换会话时自然回到第一步，不需要用 effect 去重置。
   */
  const [cursor, setCursor] = useState<{ sessionId: string | null; index: number }>({
    sessionId: null,
    index: 0
  })
  const eventIndex = cursor.sessionId === selectedId ? cursor.index : 0
  const setEventIndex = useCallback(
    (index: number): void => setCursor({ sessionId: selectedId, index }),
    [selectedId]
  )

  /**
   * 搜过之后点进来，自动停在第一处命中 —— 这一期"点进去能跳到命中的那一步"落在这里。
   *
   * 每个「会话 + 查询串」只跳一次。跳完之后用户在时间线上翻到哪儿就留在哪儿：一次重渲染、
   * 或者同一份命中因为别的状态变化又回来一次，都不该把他拽回第一处。
   */
  const jumped = useRef<string | null>(null)
  useEffect(() => {
    if (sessionHits === null || sessionHits.sessionId !== selectedId) return
    const first = sessionHits.hits[0]
    if (first === undefined) return

    const key = `${sessionHits.sessionId}|${sessionHits.query}`
    if (jumped.current === key) return
    jumped.current = key
    setEventIndex(first.eventIndex)
  }, [selectedId, sessionHits, setEventIndex])

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

  /**
   * 点盾牌：先开面板（里面转圈），再去审计。
   *
   * 每次都重新审计，不复用上一次的结果 —— 这个面板全部的用处就是回答"**现在**分享
   * 会打掉什么"，而磁盘上那份文件、以及打码开关，都可能在两次打开之间变过。
   */
  const onAudit = (): void => {
    if (!selectedId) return
    setReportOpen(true)
    void actions.auditRedaction(selectedId)
  }

  /** 报告里的 `eventId` 落在时间线第几步。那条事件已经不在了就给 `null`。 */
  const locateEvent = useCallback(
    (eventId: string): number | null => {
      const at = detail?.events.findIndex((event) => event.id === eventId) ?? -1
      return at === -1 ? null : at
    },
    [detail]
  )

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
          searchQuery={searchQuery}
          searchResult={searchResult}
          onSearchQueryChange={actions.setSearchQuery}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {detail ? (
          <SessionHeader
            onExport={() => setExportOpen(true)}
            onAudit={onAudit}
            onReveal={() => void actions.revealInFolder(detail.sourceFile)}
            eventIndex={eventIndex}
            onSelectIndex={setEventIndex}
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

      <RedactionReportDialog
        open={reportOpen}
        busy={auditing}
        sessionTitle={detail?.title ?? ''}
        report={redactionReport}
        locateEvent={locateEvent}
        onJump={setEventIndex}
        onClose={() => setReportOpen(false)}
      />
    </div>
  )
}

function SessionHeader({
  onExport,
  onAudit,
  onReveal,
  eventIndex,
  onSelectIndex
}: {
  onExport: () => void
  onAudit: () => void
  onReveal: () => void
  /** 当前停在第几步。步进器要靠它算出"现在是第几处命中"。 */
  eventIndex: number
  onSelectIndex: (index: number) => void
}): React.JSX.Element | null {
  const { detail, settings, bootstrap, sessionHits, auditing } = useApp()
  const [copied, setCopied] = useState(false)

  // 复制反馈 1500 ms 后自己消失，与 DetailPanel 里的命令块同一套。
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  if (!detail) return null

  // store 已经按"当前选中 + 当前查询"过滤过了；这里再对一次 detail.id，是因为 detail 比
  // selectedId 慢一拍 —— 切会话时新会话还在读，头部显示的仍是上一个会话的信息。
  const hits =
    sessionHits !== null && sessionHits.sessionId === detail.id ? sessionHits : null

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
          {hits !== null ? (
            <HitStepper hits={hits} eventIndex={eventIndex} onSelectIndex={onSelectIndex} />
          ) : null}
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
          {/*
           * 紧挨着导出按钮，因为这两件事是同一个动作的两面：一个把会话交出去，
           * 一个说清交出去之前拿掉了什么。要顺手点一下，位置就得在这儿。
           */}
          <Button
            icon={Shield}
            loading={auditing}
            title="看看这个会话分享出去时，哪些地方会被打掉"
            onClick={onAudit}
          >
            打码报告
          </Button>
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
 * 头部那个紧凑的命中步进器：`命中 N 处 ‹ ›`。
 *
 * 命中 0 处时给一句话，而不是一个禁用的按钮 —— 与上面「复制命令」那处同一个理由：
 * 禁用态带 `pointer-events-none`，鼠标悬不上去，`title` 里的原因就永远看不到。
 * 而这两句话恰恰是这一期最需要说出口的：第一层列出来了、第二层找不到，得说清为什么。
 */
function HitStepper({
  hits,
  eventIndex,
  onSelectIndex
}: {
  hits: SessionHits
  eventIndex: number
  onSelectIndex: (index: number) => void
}): React.JSX.Element {
  const total = hits.hits.length

  if (total === 0) {
    /*
     * 第一层给了候选、第二层却找不到，是真的会发生的（Task 7 那条一致性测试盯的是
     * 字段范围，不是这个），所以不能写"命中 0 处"了事 —— 那读起来像程序坏了。
     */
    return hits.candidate ? (
      <span
        className="max-w-[15rem] text-right text-[11.5px] leading-snug text-ink-faint"
        title={
          '两种情况会这样：索引把中文按两字一组切开，「离线」和「自检」各自出现过就够让这个会话进候选；' +
          '或者命中的那一段正好是被换成 ~ 的用户目录 —— 索引里有，界面上没有。'
        }
      >
        这个会话里没找到完整匹配（索引按两字一组检索，可能多给了候选）
      </span>
    ) : (
      <span
        className="max-w-[15rem] text-right text-[11.5px] leading-snug text-ink-faint"
        title="它出现在列表里是因为标题、项目名或文件名匹配上了，也可能是搜索之前就打开着的。"
      >
        这个会话的正文里没有这个词
      </span>
    )
  }

  // 光标正停在第几处命中上；不在任何命中上时是 -1。
  const position = hits.hits.findIndex((hit) => hit.eventIndex === eventIndex)
  const count = `${total}${hits.capped ? '+' : ''}`

  const step = (delta: number): void => {
    // 不在命中上时：「下一处」从第一处开始，「上一处」从最后一处开始。
    const from = position !== -1 ? position : delta > 0 ? -1 : 0
    const target = hits.hits[(from + delta + total) % total]
    if (target !== undefined) onSelectIndex(target.eventIndex)
  }

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-raised px-1 py-0.5"
      title={
        `‹ › 在这 ${total} 处命中之间循环，顺序就是时间线的顺序。` +
        (hits.capped
          ? `\n已经到了每个会话 ${SEARCH_MAX_HITS_PER_SESSION} 处的上限，实际还有更多。`
          : '')
      }
    >
      <span className="px-1 text-[11.5px] whitespace-nowrap text-ink-soft tabular-nums">
        命中 {count} 处{position !== -1 ? ` · 第 ${position + 1} 处` : ''}
      </span>
      <button
        type="button"
        onClick={() => step(-1)}
        title="上一处命中"
        aria-label="上一处命中"
        className="rounded p-0.5 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <ChevronLeft size={14} />
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        title="下一处命中"
        aria-label="下一处命中"
        className="rounded p-0.5 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <ChevronRight size={14} />
      </button>
    </div>
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
