import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cx } from '../lib/format'

/**
 * Markdown 渲染。
 *
 * 两点刻意的取舍：
 *   - 不开启 rehype-raw，会话里的原始 HTML 一律当纯文本，避免注入；
 *   - 链接不可点击，只显示地址 —— 这是个完全离线的应用，不该把人送出去。
 */
export function MarkdownView({
  content,
  className
}: {
  content: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cx('prose-cn text-[13.5px] leading-relaxed text-ink', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <span
              title={`离线应用不会打开外部链接：${href ?? ''}`}
              className="text-accent-ink underline decoration-dotted underline-offset-2"
            >
              {children}
            </span>
          ),
          img: ({ alt }) => (
            <span className="rounded border border-line bg-raised px-2 py-1 text-xs text-ink-faint">
              [图片：{alt || '无描述'}]
            </span>
          )
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}
