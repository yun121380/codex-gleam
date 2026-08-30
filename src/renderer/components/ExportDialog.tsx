import { useEffect, useState } from 'react'
import { FileCode, FileJson, FileText, X } from 'lucide-react'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/constants'
import type { ExportFormat, ExportOptions } from '@shared/types'
import { cx } from '../lib/format'
import { Button, Toggle } from './ui'

const FORMATS: Array<{
  value: ExportFormat
  label: string
  description: string
  icon: typeof FileText
}> = [
  {
    value: 'markdown',
    label: 'Markdown 报告',
    description: '纯文本格式，适合贴进笔记软件或代码仓库。',
    icon: FileText
  },
  {
    value: 'html',
    label: '网页报告',
    description: '双击就能用浏览器打开，样式内嵌，完全不联网。',
    icon: FileCode
  },
  {
    value: 'json',
    label: '标准 JSON',
    description: '结构化数据，方便你自己再加工。',
    icon: FileJson
  }
]

export function ExportDialog({
  sessionTitle,
  open,
  busy,
  onClose,
  onConfirm
}: {
  sessionTitle: string
  open: boolean
  busy: boolean
  onClose: () => void
  onConfirm: (format: ExportFormat, options: ExportOptions) => void
}): React.JSX.Element | null {
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    if (open) window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const update = (patch: Partial<ExportOptions>): void => {
    setOptions((current) => ({ ...current, ...patch }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="导出会话报告"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">导出这个会话</h2>
            <p className="mt-0.5 truncate text-[12px] text-ink-faint" title={sessionTitle}>
              {sessionTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="rounded-md p-1 text-ink-faint hover:bg-raised hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          <div className="space-y-2">
            {FORMATS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setFormat(item.value)}
                className={cx(
                  'flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                  format === item.value
                    ? 'border-accent/60 bg-accent-soft/40'
                    : 'border-line bg-canvas hover:border-line hover:bg-surface-2'
                )}
              >
                <span
                  className={cx(
                    'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                    format === item.value ? 'bg-accent text-canvas' : 'bg-raised text-ink-soft'
                  )}
                >
                  <item.icon size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium text-ink">{item.label}</span>
                  <span className="block text-[12px] leading-relaxed text-ink-soft">
                    {item.description}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="mt-4 border-t border-line pt-3">
            <p className="mb-1 text-[11px] font-semibold tracking-wider text-ink-faint uppercase">
              导出内容
            </p>
            <Toggle
              checked={options.redactSensitive}
              onChange={(value) => update({ redactSensitive: value })}
              label="对敏感信息打码"
              description="密钥、Token、密码、Cookie 等会被替换成 [已打码]。建议保持开启。"
            />
            <Toggle
              checked={options.includeCommandOutput}
              onChange={(value) => update({ includeCommandOutput: value })}
              label="包含命令输出"
              description="关掉可以让报告短很多，只保留命令本身和执行结果。"
            />
            <Toggle
              checked={options.showFullPaths}
              onChange={(value) => update({ showFullPaths: value })}
              label="显示完整路径"
              description="关闭时会把你的用户目录缩写成 ~，避免泄露电脑用户名。"
            />
            <Toggle
              checked={options.includeRawJson}
              onChange={(value) => update({ includeRawJson: value })}
              label="附带原始 JSON"
              description="把每一步的原始记录也写进报告，文件会大很多。"
            />
          </div>

          {!options.redactSensitive ? (
            <p className="mt-3 rounded-lg border border-error/35 bg-error-soft/30 px-3 py-2 text-[12px] leading-relaxed text-error">
              你关闭了打码。如果这个会话里出现过密钥或密码，它们会原样写进报告，请不要分享给别人。
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-5 py-3">
          <p className="text-[11px] text-ink-faint">保存位置由你在下一步选择，文件只写到本机。</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" loading={busy} onClick={() => onConfirm(format, options)}>
              选择保存位置
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
