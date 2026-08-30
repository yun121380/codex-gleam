import { useMemo } from 'react'
import { parseAnsi } from '../lib/ansi'
import { cx } from '../lib/format'

/**
 * 终端风格的输出展示：保留换行、空格与 ANSI 颜色。
 * 颜色通过内联 style 应用（CSP 里 style-src 允许 'unsafe-inline'，脚本仍然是禁止的）。
 */
export function TerminalOutput({
  text,
  className,
  maxHeight = '100%'
}: {
  text: string
  className?: string
  maxHeight?: string
}): React.JSX.Element {
  const spans = useMemo(() => parseAnsi(text), [text])

  return (
    <pre
      className={cx(
        'overflow-auto rounded-lg border border-line bg-[#0f0e0c] px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] break-words whitespace-pre-wrap text-[#d7d2c8]',
        className
      )}
      style={{ maxHeight }}
    >
      {spans.length === 0 ? (
        <span className="text-ink-faint">（没有输出内容）</span>
      ) : (
        spans.map((span, index) => (
          <span
            key={index}
            style={{
              ...(span.color ? { color: span.color } : {}),
              ...(span.background ? { backgroundColor: span.background } : {}),
              ...(span.bold ? { fontWeight: 700 } : {}),
              ...(span.dim ? { opacity: 0.65 } : {}),
              ...(span.italic ? { fontStyle: 'italic' } : {}),
              ...(span.underline ? { textDecoration: 'underline' } : {})
            }}
          >
            {span.text}
          </span>
        ))
      )}
    </pre>
  )
}
