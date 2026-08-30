import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheckBig,
  CircleSlash,
  Clock,
  Copy,
  FolderOpen,
  Hash,
  MousePointerClick
} from 'lucide-react'
import type { CodexEvent, TestSummary } from '@shared/types'
import { cx, formatDateTime, formatDuration } from '../lib/format'
import { EventIcon, metaFor, tonesFor } from '../lib/eventMeta'
import { DiffViewer } from './DiffViewer'
import { MarkdownView } from './MarkdownView'
import { TerminalOutput } from './TerminalOutput'
import { Badge, EmptyState } from './ui'

export function DetailPanel({
  event,
  showFullPaths,
  onRevealFile
}: {
  event: CodexEvent | null
  showFullPaths: boolean
  onRevealFile: (path: string, baseDir: string | null) => void
}): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /*
   * 换了一步就把详情滚回顶部。
   *
   * 和时间线是同一个毛病：这块滚动容器不随内容重建。看完一段很长的命令输出之后
   * 点下一步，新内容会从上一步停下的位置开始显示。
   */
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [event?.id])

  if (!event) {
    return (
      <div className="h-full bg-surface">
        <EmptyState
          icon={MousePointerClick}
          title="点左边的任意一步"
          description="这里会显示那一步的完整内容：你说了什么、Codex 做了什么、命令输出、文件差异或错误信息。"
        />
      </div>
    )
  }

  const meta = metaFor(event.type)
  const tones = tonesFor(event.type)

  /*
   * 路径一律走展示字段，除非用户明确打开了「显示完整路径」。
   * 直接显示 event.workingDirectory / relatedFiles 会把 C:\Users\用户名\… 摆出来 ——
   * 默认设置下不该出现，截图和录屏里尤其不该。
   */
  const workingDirectory = showFullPaths
    ? event.workingDirectory
    : (event.displayWorkingDirectory ?? event.workingDirectory)
  const relatedFiles =
    showFullPaths || event.displayRelatedFiles.length !== event.relatedFiles.length
      ? event.relatedFiles
      : event.displayRelatedFiles

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={cx('flex h-7 w-7 items-center justify-center rounded-lg', tones.chip)}>
            <EventIcon type={event.type} size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cx('text-[13px] font-semibold', tones.text)}>{meta.label}</span>
              <StatusBadge event={event} />
            </div>
            <p className="text-[11px] text-ink-faint">{meta.hint}</p>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
          <span className="inline-flex items-center gap-1">
            <Clock size={11} />
            {formatDateTime(event.timestamp)}
          </span>
          {event.durationMs !== null && event.durationMs !== undefined ? (
            <span>耗时 {formatDuration(event.durationMs)}</span>
          ) : null}
          {workingDirectory ? (
            <span className="inline-flex min-w-0 items-center gap-1" title={workingDirectory}>
              <FolderOpen size={11} />
              <span className="max-w-[280px] truncate">{workingDirectory}</span>
            </span>
          ) : null}
          {event.sourceLine !== undefined ? (
            <span className="inline-flex items-center gap-1" title="在原始文件中的位置">
              <Hash size={11} />第 {event.sourceLine} 条
            </span>
          ) : null}
        </div>
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <EventBody event={event} showFullPaths={showFullPaths} />

        {event.relatedFiles.length > 0 ? (
          <section>
            <SectionHeading>相关文件</SectionHeading>
            <ul className="space-y-1">
              {event.relatedFiles.slice(0, 40).map((file, index) => (
                <li key={file}>
                  <button
                    type="button"
                    /*
                     * 定位用真实路径，显示用展示路径 —— 两者不能混。
                     * 真实路径还可能是相对的（apply_patch 记的就是 `src/app.ts`），
                     * 所以得把这一步的工作目录一起交出去当参照。
                     */
                    onClick={() => onRevealFile(file, event.workingDirectory)}
                    title="在文件管理器中定位"
                    className="w-full truncate rounded-md border border-line bg-canvas px-2.5 py-1.5 text-left font-mono text-[12px] text-ink-soft hover:border-accent/40 hover:text-ink"
                  >
                    {relatedFiles[index] ?? file}
                  </button>
                </li>
              ))}
            </ul>
            {event.relatedFiles.length > 40 ? (
              <p className="mt-1 text-[11px] text-ink-faint">
                还有 {event.relatedFiles.length - 40} 个文件未显示。
              </p>
            ) : null}
          </section>
        ) : null}

        <RawDataSection raw={event.raw} />
      </div>
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h4 className="mb-1.5 text-[11px] font-semibold tracking-wider text-ink-faint uppercase">
      {children}
    </h4>
  )
}

function StatusBadge({ event }: { event: CodexEvent }): React.JSX.Element | null {
  if (event.success === true) {
    return (
      <Badge className="bg-file-soft text-file">
        <CircleCheckBig size={10} />
        成功
      </Badge>
    )
  }
  if (event.success === false) {
    return (
      <Badge className="bg-error-soft text-error">
        <CircleAlert size={10} />
        {event.exitCode !== null && event.exitCode !== undefined ? `失败（退出码 ${event.exitCode}）` : '失败'}
      </Badge>
    )
  }
  return null
}

function EventBody({
  event,
  showFullPaths
}: {
  event: CodexEvent
  showFullPaths: boolean
}): React.JSX.Element {
  switch (event.type) {
    case 'user_message':
    case 'assistant_message':
    case 'session_start':
      return (
        <section>
          <SectionHeading>{event.type === 'user_message' ? '你说的话' : '内容'}</SectionHeading>
          <div className="rounded-lg border border-line bg-canvas px-4 py-3">
            <MarkdownView content={event.content} />
          </div>
        </section>
      )

    case 'reasoning':
      return (
        <section>
          <SectionHeading>Codex 的内部推演</SectionHeading>
          <div className="rounded-lg border border-line bg-canvas px-4 py-3 opacity-80">
            <MarkdownView content={event.content} />
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
            这是 Codex 动手之前的思考，不是给你看的正式回答，看不懂可以直接跳过。
          </p>
        </section>
      )

    case 'shell_command':
    case 'test_start': {
      const command = event.command ?? event.title

      return (
        <section>
          <SectionHeading>执行的命令（本应用只展示，不会运行它）</SectionHeading>
          <CommandBlock command={command} />
          {event.content.trim() !== '' && event.content.trim() !== command.trim() ? (
            <div className="mt-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] text-ink-soft">
              {event.content}
            </div>
          ) : null}
        </section>
      )
    }

    case 'command_output':
      return (
        <section>
          <SectionHeading>命令输出</SectionHeading>
          {event.command ? <CommandBlock command={event.command} muted /> : null}
          <div className="mt-2">
            <TerminalOutput text={event.content} maxHeight="560px" />
          </div>
        </section>
      )

    case 'test_result':
      return (
        <section className="space-y-3">
          {event.test ? <TestSummaryView summary={event.test} /> : null}
          <div>
            <SectionHeading>完整输出</SectionHeading>
            <TerminalOutput text={event.content} maxHeight="420px" />
          </div>
        </section>
      )

    case 'file_write':
    case 'file_edit':
    case 'git_diff':
      return (
        <section>
          <SectionHeading>文件改动</SectionHeading>
          <DiffViewer changes={event.fileChanges ?? []} showFullPaths={showFullPaths} />
        </section>
      )

    case 'error':
      return (
        <section>
          <SectionHeading>错误信息</SectionHeading>
          <div className="rounded-lg border border-error/35 bg-error-soft/35 px-3.5 py-3">
            <p className="mb-2 text-[13px] font-medium text-error">{event.title}</p>
            <TerminalOutput text={event.content} maxHeight="420px" className="border-error/25" />
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">
            这一步没有成功。可以往上翻，看看失败之前 Codex 执行了什么命令。
          </p>
        </section>
      )

    case 'file_read':
      return (
        <section>
          <SectionHeading>读取到的内容</SectionHeading>
          <TerminalOutput text={event.content} maxHeight="480px" />
        </section>
      )

    default:
      return (
        <section>
          <SectionHeading>内容</SectionHeading>
          <TerminalOutput text={event.content} maxHeight="480px" />
        </section>
      )
  }
}

function CommandBlock({ command, muted = false }: { command: string; muted?: boolean }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <div
      className={cx(
        'group relative rounded-lg border px-3.5 py-2.5 font-mono text-[12.5px] break-words whitespace-pre-wrap',
        muted
          ? 'border-line bg-canvas text-ink-soft'
          : 'border-shell/35 bg-[#0f0e0c] text-[#f0c884]'
      )}
    >
      <span className="mr-2 select-none text-ink-faint">$</span>
      {command}
      <button
        type="button"
        title={copied ? '已复制' : '复制命令'}
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => setCopied(true))
        }}
        className="absolute top-1.5 right-1.5 rounded p-1 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-raised hover:text-ink"
      >
        <Copy size={12} />
      </button>
      {copied ? (
        <span className="absolute top-2 right-8 text-[10px] text-file">已复制</span>
      ) : null}
    </div>
  )
}

function TestSummaryView({ summary }: { summary: TestSummary }): React.JSX.Element {
  const cards = [
    { label: '通过', value: summary.passed, className: 'text-file', icon: CircleCheckBig },
    { label: '失败', value: summary.failed, className: 'text-error', icon: CircleAlert },
    { label: '跳过', value: summary.skipped, className: 'text-ink-faint', icon: CircleSlash }
  ]

  return (
    <div>
      <SectionHeading>测试结果{summary.framework ? `（${summary.framework}）` : ''}</SectionHeading>
      <div className="grid grid-cols-3 gap-2">
        {cards.map((card) => (
          <div key={card.label} className="rounded-lg border border-line bg-canvas px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
              <card.icon size={11} />
              {card.label}
            </div>
            <div className={cx('text-[22px] leading-tight font-semibold tabular-nums', card.className)}>
              {card.value}
            </div>
          </div>
        ))}
      </div>
      {summary.durationMs !== undefined ? (
        <p className="mt-1.5 text-[11px] text-ink-faint">耗时 {formatDuration(summary.durationMs)}</p>
      ) : null}
      {summary.failures.length > 0 ? (
        <div className="mt-3">
          <SectionHeading>失败的用例</SectionHeading>
          <ul className="space-y-1">
            {summary.failures.map((failure, index) => (
              <li
                key={`${failure.name}-${index}`}
                className="rounded-md border border-error/30 bg-error-soft/25 px-2.5 py-1.5"
              >
                <div className="font-mono text-[12px] text-error">{failure.name}</div>
                {failure.message ? (
                  <div className="mt-0.5 text-[11.5px] text-ink-soft">{failure.message}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function RawDataSection({ raw }: { raw: unknown }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (raw === null || raw === undefined) return null

  let text: string
  try {
    text = JSON.stringify(raw, null, 2) ?? String(raw)
  } catch {
    text = String(raw)
  }

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 rounded-md py-1 text-[11px] font-semibold tracking-wider text-ink-faint uppercase hover:text-ink-soft"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        原始数据
        <span className="ml-1 font-normal tracking-normal normal-case">
          （这一步在文件里的本来样子）
        </span>
      </button>
      {open ? (
        <pre className="mt-1.5 max-h-[420px] overflow-auto rounded-lg border border-line bg-canvas px-3 py-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-ink-soft">
          {text}
        </pre>
      ) : null}
    </section>
  )
}
