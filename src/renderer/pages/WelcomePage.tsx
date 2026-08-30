import { FolderSearch, Import, Play, Shield, Sparkles } from 'lucide-react'
import { APP_NAME } from '@shared/constants'
import type { CandidateRoot } from '@shared/types'
import { Button } from '../components/ui'
import { useDisplayPath } from '../lib/displayPath'
import { useApp } from '../hooks/useAppStore'

/**
 * 首次启动的欢迎页。
 * 只有一个目标：让完全不懂 JSON 和目录的人，点一下就能开始。
 */
export function WelcomePage(): React.JSX.Element {
  const { bootstrap, actions } = useApp()
  const roots: CandidateRoot[] = bootstrap?.builtinRoots ?? []
  const displayPath = useDisplayPath()

  const beginScan = (): void => {
    void actions.completeFirstRun()
    void actions.startScan()
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-8 py-14">
        <div className="mb-1 inline-flex items-center gap-2 text-[12px] tracking-wide text-accent-ink">
          <Sparkles size={13} />
          {APP_NAME}
        </div>

        <h1 className="text-[30px] leading-tight font-semibold text-ink">
          你好，我来帮你找 Codex 会话
        </h1>

        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          我会在电脑上常见的 Codex 数据目录中查找会话文件，不会上传任何内容。
        </p>

        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-faint">
          找到之后，你可以像看聊天记录一样翻阅每一次和 Codex 的协作：你提了什么要求、它执行了哪些命令、
          改动了哪些文件、哪一步失败了。你不需要知道什么是 JSON，也不需要打开命令行。
        </p>

        <div className="mt-8 flex flex-wrap gap-2.5">
          <Button variant="primary" size="lg" icon={Play} onClick={beginScan}>
            开始自动扫描
          </Button>
          <Button
            size="lg"
            icon={FolderSearch}
            onClick={() => {
              void actions.completeFirstRun()
              void actions.pickFolderAndScan()
            }}
          >
            选择其他文件夹
          </Button>
          <Button size="lg" icon={Shield} onClick={() => actions.setView('privacy')}>
            查看隐私说明
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2.5">
          <Button
            variant="ghost"
            size="sm"
            icon={Import}
            onClick={() => {
              void actions.completeFirstRun()
              void actions.importFiles()
            }}
          >
            我知道文件在哪，直接导入
          </Button>
          {bootstrap?.sampleDataAvailable ? (
            <Button
              variant="ghost"
              size="sm"
              icon={Sparkles}
              onClick={() => {
                void actions.completeFirstRun()
                void actions.loadSampleData()
              }}
            >
              先用示例数据看看效果
            </Button>
          ) : null}
        </div>

        <div className="mt-10 rounded-xl border border-line bg-surface p-5">
          <h2 className="text-[13px] font-semibold text-ink">
            我会去这些地方找
            <span className="ml-1.5 font-normal text-ink-faint">（只读取，不修改）</span>
          </h2>
          {roots.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-soft">
              这台电脑上暂时没有检测到常见的 Codex 目录。你可以直接选择文件夹，或导入单个会话文件。
            </p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {roots.map((root) => (
                <li key={root.path} className="flex items-baseline gap-2 text-[12.5px]">
                  <span className="shrink-0 text-ink-faint">{root.label}</span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-ink-soft"
                    title={displayPath(root.path)}
                  >
                    {displayPath(root.path)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-faint">
            扫描时会跳过 node_modules、.git、dist、build、Cache、Temp、Logs 等目录，只查看 .json 和 .jsonl
            文件，默认最多向下 6 层，并跳过超过 100 MB 的文件。整个过程都在你的电脑上完成。
          </p>
        </div>
      </div>
    </div>
  )
}
