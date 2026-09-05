import { useState } from 'react'
import { FolderPlus, Moon, RefreshCw, Sun, Trash2, X } from 'lucide-react'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { Button, Card, Field, SectionTitle, TextInput, Toggle } from '../components/ui'
import { useDisplayPath } from '../lib/displayPath'
import { useApp } from '../hooks/useAppStore'

export function SettingsPage(): React.JSX.Element {
  const { settings, bootstrap, actions } = useApp()
  const [newDir, setNewDir] = useState('')
  const displayPath = useDisplayPath()

  const addDir = (): void => {
    const trimmed = newDir.trim()
    if (trimmed === '') return
    if (settings.extraScanDirs.includes(trimmed)) {
      actions.showNotice('info', '这个目录已经在列表里了。')
      return
    }
    void actions.updateSettings({ extraScanDirs: [...settings.extraScanDirs, trimmed] })
    setNewDir('')
  }

  const removeDir = (dir: string): void => {
    void actions.updateSettings({
      extraScanDirs: settings.extraScanDirs.filter((entry) => entry !== dir)
    })
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <h1 className="text-[22px] font-semibold text-ink">设置</h1>
        <p className="mt-0.5 text-[12.5px] text-ink-soft">
          所有设置都保存在你本机的应用数据目录里，不会同步到任何地方。
        </p>

        <Card className="mt-6">
          <SectionTitle hint="改完记得重新扫描">扫描范围</SectionTitle>

          <Toggle
            checked={settings.useBuiltinDirs}
            onChange={(value) => void actions.updateSettings({ useBuiltinDirs: value })}
            label="扫描内置的 Codex 候选目录"
            description="关闭后只扫描你自己添加的目录。"
          />

          {bootstrap && bootstrap.builtinRoots.length > 0 ? (
            <ul className="mt-1 mb-3 space-y-1 rounded-lg border border-line bg-canvas px-3 py-2">
              {bootstrap.builtinRoots.map((root) => (
                <li key={root.path} className="flex items-baseline gap-2 text-[12px]">
                  <span className="shrink-0 text-ink-faint">{root.label}</span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-ink-soft"
                    title={displayPath(root.path)}
                  >
                    {displayPath(root.path)}
                  </span>
                  {root.basedOn ? (
                    <span className="shrink-0 text-[10.5px] text-ink-faint">{root.basedOn}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          <Field
            label="自定义扫描目录"
            hint="把 Codex 的数据目录或项目目录粘贴进来。只会读取，不会修改里面的任何文件。"
          >
            <div className="flex gap-2">
              <TextInput
                value={newDir}
                onChange={setNewDir}
                placeholder="例如 D:\backup\codex"
              />
              <Button icon={FolderPlus} onClick={addDir}>
                添加
              </Button>
            </div>
            {settings.extraScanDirs.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {settings.extraScanDirs.map((dir) => (
                  <li
                    key={dir}
                    className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-1.5"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-soft"
                      title={displayPath(dir)}
                    >
                      {displayPath(dir)}
                    </span>
                    <button
                      type="button"
                      title="移除这个目录"
                      onClick={() => removeDir(dir)}
                      className="rounded p-1 text-ink-faint hover:bg-error-soft hover:text-error"
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[12px] text-ink-faint">还没有自定义目录。</p>
            )}
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="最大搜索深度" hint="从每个目录往下最多找几层。默认 6 层。">
              <TextInput
                type="number"
                min={1}
                max={20}
                value={settings.maxDepth}
                onChange={(value) => {
                  const parsed = Number.parseInt(value, 10)
                  if (Number.isFinite(parsed)) void actions.updateSettings({ maxDepth: parsed })
                }}
              />
            </Field>
            <Field label="单个文件大小上限（MB）" hint="超过这个大小的文件会被跳过。默认 100 MB。">
              <TextInput
                type="number"
                min={1}
                max={2048}
                value={settings.maxFileSizeMb}
                onChange={(value) => {
                  const parsed = Number.parseInt(value, 10)
                  if (Number.isFinite(parsed)) void actions.updateSettings({ maxFileSizeMb: parsed })
                }}
              />
            </Field>
          </div>

          <Field
            label={`识别门槛：${Math.round(settings.confidenceThreshold * 100)}%`}
            hint="低于这个可信度的文件不会被当成会话。调低能找到更多文件，但可能混入无关的 JSON。"
          >
            <input
              type="range"
              min={0}
              max={90}
              step={5}
              value={Math.round(settings.confidenceThreshold * 100)}
              onChange={(event) =>
                void actions.updateSettings({
                  confidenceThreshold: Number(event.target.value) / 100
                })
              }
              className="w-full accent-[var(--color-accent)]"
            />
          </Field>
        </Card>

        <Card className="mt-3">
          <SectionTitle>隐私与显示</SectionTitle>
          <Toggle
            checked={settings.redactSensitive}
            onChange={(value) => void actions.updateSettings({ redactSensitive: value })}
            label="自动给敏感信息打码"
            description="密钥、Token、密码、Authorization、Cookie 等会显示成 [已打码]。强烈建议保持开启。"
          />
          <Toggle
            checked={settings.showFullPaths}
            onChange={(value) => void actions.updateSettings({ showFullPaths: value })}
            label="显示完整文件路径"
            description="关闭时把你的用户目录显示成 ~，截图时不会暴露电脑用户名。"
          />

          <Field label="时间线播放速度" hint="点「播放」后每一步停留的时间。">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={300}
                max={4000}
                step={100}
                value={settings.playbackIntervalMs}
                onChange={(event) =>
                  void actions.updateSettings({ playbackIntervalMs: Number(event.target.value) })
                }
                className="flex-1 accent-[var(--color-accent)]"
              />
              <span className="w-20 shrink-0 text-right text-[12px] tabular-nums text-ink-soft">
                {(settings.playbackIntervalMs / 1000).toFixed(1)} 秒 / 步
              </span>
            </div>
          </Field>

          <Field label="界面主题">
            <div className="flex gap-2">
              <Button
                icon={Moon}
                active={settings.theme === 'dark'}
                onClick={() => void actions.updateSettings({ theme: 'dark' })}
              >
                深色
              </Button>
              <Button
                icon={Sun}
                active={settings.theme === 'light'}
                onClick={() => void actions.updateSettings({ theme: 'light' })}
              >
                浅色
              </Button>
            </div>
          </Field>
        </Card>

        <Card className="mt-3">
          <SectionTitle hint="留空就只显示 token 数">用量单价</SectionTitle>
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            本应用不预置任何价格表 —— 写死的价格会过期，而过期的价格比没有价格更糟。想看金额就把你
            自己那份单价填进来，只存在本机，也不会跟着导出的报告走出去。
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="输入 · 每百万 token">
              <TextInput
                type="number"
                min={0}
                value={settings.pricePerMillionInput ?? ''}
                placeholder="留空"
                onChange={(value) =>
                  void actions.updateSettings({ pricePerMillionInput: parsePrice(value) })
                }
              />
            </Field>
            <Field label="输出 · 每百万 token">
              <TextInput
                type="number"
                min={0}
                value={settings.pricePerMillionOutput ?? ''}
                placeholder="留空"
                onChange={(value) =>
                  void actions.updateSettings({ pricePerMillionOutput: parsePrice(value) })
                }
              />
            </Field>
            <Field label="货币符号">
              <TextInput
                value={settings.priceCurrency}
                placeholder="例如 $ 或 ¥"
                onChange={(value) => void actions.updateSettings({ priceCurrency: value })}
              />
            </Field>
          </div>
        </Card>

        <Card className="mt-3">
          <SectionTitle>本地数据</SectionTitle>
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            本应用只保存一份"索引"（会话摘要）和这些设置。清空索引不会删除、修改或移动你的任何 Codex
            原始文件 —— 重新扫描就能再找回来。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button icon={RefreshCw} onClick={() => void actions.startScan()}>
              立即重新扫描
            </Button>
            <Button variant="danger" icon={Trash2} onClick={() => void actions.clearIndex()}>
              清空本地索引
            </Button>
            <Button
              variant="ghost"
              onClick={() => void actions.updateSettings({ ...DEFAULT_SETTINGS })}
            >
              恢复默认设置
            </Button>
          </div>
        </Card>

        {bootstrap ? (
          <p className="mt-5 text-[11.5px] text-ink-faint">
            版本 {bootstrap.appVersion} · Electron {bootstrap.electronVersion} · 平台{' '}
            {bootstrap.platform} · {bootstrap.isPackaged ? '已打包' : '开发模式'}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 单价输入。空串与非数字都当"没填"，而不是当 0。
 *
 * 0 是一个有意义的单价（免费额度内），跟"没填"必须分得开：没填时界面根本不显示
 * 金额，填 0 时显示的是 0。
 */
function parsePrice(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
