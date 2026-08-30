import { useEffect, useState } from 'react'
import { Check, FolderOpen, Shield } from 'lucide-react'
import { PRIVACY_POINTS } from '@shared/constants'
import type { PrivacyNotice } from '@shared/types'
import { Button, Card } from '../components/ui'
import { useDisplayPath } from '../lib/displayPath'
import { useApp } from '../hooks/useAppStore'

export function PrivacyPage(): React.JSX.Element {
  const { actions } = useApp()
  const [notice, setNotice] = useState<PrivacyNotice | null>(null)
  const displayPath = useDisplayPath()

  useEffect(() => {
    void window.gleam
      .getPrivacyNotice()
      .then(setNotice)
      .catch(() => setNotice(null))
  }, [])

  const points = notice?.points ?? [...PRIVACY_POINTS]

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-file-soft text-file">
            <Shield size={18} />
          </span>
          <div>
            <h1 className="text-[22px] leading-tight font-semibold text-ink">数据只保存在本机</h1>
            <p className="text-[12.5px] text-ink-soft">这一页说明这个工具做什么、不做什么。</p>
          </div>
        </div>

        <Card className="mt-6">
          <ul className="space-y-2.5">
            {points.map((point) => (
              <li key={point} className="flex items-start gap-2.5">
                <Check size={15} className="mt-0.5 shrink-0 text-file" />
                <span className="text-[13.5px] leading-relaxed text-ink">{point}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="mt-3">
          <h2 className="text-[13.5px] font-semibold text-ink">本应用在你电脑上写了什么</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            只有两类文件：一份会话索引（只包含摘要，比如标题、时间、命令数量）和你的设置。
            事件正文不会被复制出来 —— 每次打开会话时都是重新读取你的原始文件。
          </p>
          {notice?.storageLocation ? (
            <div className="mt-3 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] text-ink-soft">
                {displayPath(notice.storageLocation)}
              </code>
              <Button
                size="sm"
                icon={FolderOpen}
                onClick={() => void actions.revealInFolder(notice.storageLocation)}
              >
                打开位置
              </Button>
            </div>
          ) : null}
          <p className="mt-2.5 text-[12px] leading-relaxed text-ink-faint">
            想彻底恢复出厂状态，删掉上面这个目录即可；你的 Codex 会话文件不受任何影响。
          </p>
        </Card>

        <Card className="mt-3">
          <h2 className="text-[13.5px] font-semibold text-ink">关于会话里的命令</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            会话日志里会有 Codex 当初执行过的命令（比如 npm test、git commit）。
            本应用<strong className="text-ink"> 只把它们当文字展示</strong>
            ，任何情况下都不会重新执行 —— 代码里根本没有引入执行命令的能力，
            并且有一条自动化测试专门检查这一点。
          </p>
        </Card>

        <div className="mt-6">
          <Button variant="primary" onClick={() => actions.setView('sessions')}>
            我知道了，返回
          </Button>
        </div>
      </div>
    </div>
  )
}
