import { useCallback, useEffect, useState } from 'react'
import {
  Boxes,
  Cable,
  FileCheck2,
  FlaskConical,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldCheck,
  WifiOff
} from 'lucide-react'
import type { SelfCheckReport } from '@shared/types'
import { Badge, Button, Card, TextInput } from '../components/ui'
import { formatDateTime, formatNumber, formatTimeOnly } from '../lib/format'
import { useApp } from '../hooks/useAppStore'

/**
 * 离线自检页 —— 把 README 里的那些承诺换成这次运行的真实数字。
 *
 * 这一页只有一条规矩：**任何一格都不许比它检查的那个东西乐观。**
 * 拿不到就说拿不到，没装就说没装，一次演示失败就红字写失败。
 * 一个自检页只要在任何一处替实现圆了场，它报的所有数就都不值钱了。
 */

/** 「你自己试」那一段的当前状态。 */
type ProbeState =
  | { phase: 'idle' }
  | { phase: 'running' }
  /** 地址没被受理 —— 连 Image 都没造。 */
  | { phase: 'rejected'; reason: string }
  /** 三种结局之一，`tone` 决定文案的颜色。 */
  | { phase: 'done'; tone: 'ok' | 'bad'; title: string; detail: string }

/** 读 meta 里那份 CSP —— 从 DOM 里的**真实对象**读，不从构建配置里抄一份常量过来。 */
function readMetaCsp(): string | null {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
  const content = meta?.getAttribute('content')
  return content === undefined || content === null || content === '' ? null : content
}

/** 数一条 CSP 里有几个指令。分号分隔，空段不算。 */
function countDirectives(policy: string): number {
  return policy.split(';').filter((part) => part.trim() !== '').length
}

export function SelfCheckPage(): React.JSX.Element {
  const { actions } = useApp()
  const [report, setReport] = useState<SelfCheckReport | null>(null)
  const [probe, setProbe] = useState<ProbeState>({ phase: 'idle' })
  const [probeUrl, setProbeUrl] = useState('')

  // meta 那份只在挂载时读一次：它是文档解析时就位的，此后不会变。
  const [metaCsp] = useState(readMetaCsp)

  const load = useCallback((): void => {
    void window.gleam
      .readSelfCheck()
      .then(setReport)
      .catch(() => setReport(null))
  }, [])

  useEffect(load, [load])

  /**
   * 「你自己试」。三种结局，三种都照实说 —— 见下面每个分支的注释。
   *
   * 用 `Image` 而不是 `fetch`：`fetch` 在这个仓库里是被禁的 API，
   * `offline.test.ts` 盯着它。而且 `Image` 更贴近「一次真实的资源加载」，
   * 它走的正是 `onBeforeRequest` 要拦的那条路。
   */
  const runProbe = useCallback((): void => {
    setProbe({ phase: 'running' })

    void window.gleam
      .readSelfCheck({ armProbe: probeUrl })
      .then((armedReport) => {
        setReport(armedReport)
        const arm = armedReport.probeArm

        // 没受理就到此为止，连 Image 都不造 —— 省得让人看一次注定演示不了拦截的加载。
        if (arm === null || !arm.ok || arm.url === null) {
          setProbe({
            phase: 'rejected',
            reason: arm?.reason ?? '这个地址没有被受理。'
          })
          return
        }

        const before = armedReport.intercept.probeBlocked
        const image = new Image()
        let settled = false

        const finish = (loaded: boolean): void => {
          if (settled) return
          settled = true

          void window.gleam
            .readSelfCheck()
            .then((after) => {
              setReport(after)
              const delta = after.intercept.probeBlocked - before

              if (loaded) {
                // 结局三：它真的加载成功了。这不该发生 —— 发生了就原样报出来，
                // 而不是把一次失败的演示说成成功。
                setProbe({
                  phase: 'done',
                  tone: 'bad',
                  title: '这次没有被拦住。',
                  detail:
                    '这个地址真的加载成功了，说明护栏在这条路径上没起作用。请把它连同这个地址一起报告给项目。'
                })
                return
              }

              if (delta > 0) {
                // 结局一：最完整的一次演示 —— 请求成型了、被主进程那行代码挡住了，
                // 而且记在 probe 那一栏而不是「应为 0」那一栏。
                setProbe({
                  phase: 'done',
                  tone: 'ok',
                  title: '主进程把它拦下来了。',
                  detail:
                    '请求确实成型了，然后在 Electron 的请求层被取消 —— 上面「你自己试触发的」那个数刚刚涨了 1，而「应为 0」那个数没有动。'
                })
                return
              }

              // 结局二：CSP 在渲染进程就挡掉了，请求压根没离开这个窗口。
              // 这不是失败，是第二道防线先动手 —— 要说清是哪一道，不能含糊地说「被拦了」。
              setProbe({
                phase: 'done',
                tone: 'ok',
                title: '页面策略先动手了，请求没离开这个窗口。',
                detail:
                  '加载失败了，但拦截计数没有变化 —— 说明这次加载被上面那份内容安全策略在渲染进程里直接挡掉，压根没走到主进程的请求层。两道防线是独立的，这次是靠外面那道。'
              })
            })
            .catch(() => {
              setProbe({
                phase: 'done',
                tone: 'bad',
                title: '读不到这次的报告。',
                detail: '演示跑完了，但再读一次报告时出了岔子，所以判不出是哪一道防线动的手。'
              })
            })
        }

        image.onerror = () => finish(false)
        image.onload = () => finish(true)
        image.src = arm.url
      })
      .catch(() => {
        setProbe({
          phase: 'rejected',
          reason: '主进程没有回应这次请求，演示没有开始。'
        })
      })
  }, [probeUrl])

  if (report === null) {
    return (
      <div className="h-full overflow-y-auto bg-canvas">
        <div className="mx-auto max-w-3xl px-8 py-10">
          <Header />
          <Card className="mt-6">
            <p className="text-[13px] leading-relaxed text-ink-soft">
              读不到这次运行的自检报告。这本身就是一件该说出来的事 —— 页面没有拿到任何数据，
              所以下面什么都不显示，而不是显示一堆零。
            </p>
            <div className="mt-3">
              <Button size="sm" icon={RefreshCw} onClick={load}>
                再读一次
              </Button>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  const metaCount = metaCsp === null ? 0 : countDirectives(metaCsp)
  const headerCsp = report.csp.responseHeader
  const headerCount = headerCsp === null ? 0 : countDirectives(headerCsp)

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <Header />

        <div className="mt-4 flex items-center gap-2">
          <Badge className={report.mode === 'dev' ? 'bg-neutral-soft text-ink-soft' : 'bg-file-soft text-file'}>
            {report.mode === 'dev' ? '开发模式' : '打包后运行'}
          </Badge>
          <Button size="sm" icon={RefreshCw} onClick={load}>
            再读一次
          </Button>
        </div>

        {report.evidenceIssues.length > 0 ? (
          <Card className="mt-3 border-error/40 bg-error-soft">
            <h2 className="text-[13.5px] font-semibold text-ink">读证据时出的岔子</h2>
            <ul className="mt-1.5 space-y-1">
              {report.evidenceIssues.map((issue) => (
                <li key={issue} className="text-[12.5px] leading-relaxed text-ink-soft">
                  · {issue}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {/* ① 拦截计数：两栏分开，谁也别把它们加起来。 */}
        <Card className="mt-3">
          <CardTitle icon={WifiOff}>网络请求拦截</CardTitle>
          <div className="mt-3 flex gap-3">
            <div className="flex-1 rounded-xl border border-line bg-canvas px-4 py-3">
              <div
                className={
                  report.intercept.appBlocked === 0
                    ? 'text-[26px] leading-none font-semibold text-file'
                    : 'text-[26px] leading-none font-semibold text-error'
                }
              >
                {formatNumber(report.intercept.appBlocked)}
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink">本应用自己发起的</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">
                这个数应该是 0。不是 0 就说明它真的在往外发请求，清单里有地址。
              </div>
            </div>
            <div className="flex-1 rounded-xl border border-line bg-canvas px-4 py-3">
              <div className="text-[26px] leading-none font-semibold text-ink-soft">
                {formatNumber(report.intercept.probeBlocked)}
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink">你自己试触发的</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">
                下面那个演示产生的次数单独记在这里，好让左边那个数一直干净。
              </div>
            </div>
          </div>

          {report.intercept.recent.length > 0 ? (
            <div className="mt-3">
              <div className="text-[12.5px] text-ink-soft">最近被拦下来的：</div>
              <ul className="mt-1.5 space-y-1">
                {[...report.intercept.recent].reverse().map((item, index) => (
                  <li
                    key={`${item.at}-${index}`}
                    className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 py-1.5"
                  >
                    <Badge
                      className={
                        item.origin === 'app'
                          ? 'bg-error-soft text-error'
                          : 'bg-neutral-soft text-ink-soft'
                      }
                    >
                      {item.origin === 'app' ? '应用自己' : '你自己试'}
                    </Badge>
                    <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-soft">
                      {item.url}
                    </code>
                    {/* 精确到秒：一次演示可能在同一分钟里打出好几条，只到分钟就分不出先后。 */}
                    <span className="shrink-0 text-[11px] text-ink-faint">
                      {formatTimeOnly(item.at)}
                    </span>
                  </li>
                ))}
              </ul>
              {report.intercept.recentTruncated ? (
                <p className="mt-1.5 text-[11.5px] text-ink-faint">
                  清单只留了最近 {report.intercept.recent.length} 条；上面那两个数不受这个上限影响，它们是精确的。
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-[12.5px] text-ink-faint">
              这次运行还没有任何请求被拦下来 —— 空的才是正常的。
            </p>
          )}
        </Card>

        {/* ② 两份 CSP 并列，不合并：内容不同、生效层次不同、开发模式下的命运也不同。 */}
        <Card className="mt-3">
          <CardTitle icon={Lock}>内容安全策略</CardTitle>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            有两份，各自在不同的层次上生效，所以分开列而不合成一条。
          </p>

          <div className="mt-3 space-y-2.5">
            <PolicyBlock
              label="页面里的 meta 标签"
              hint="文档解析时就位，管这个窗口里的一切加载"
              policy={metaCsp}
              count={metaCount}
              emptyText="开发模式下未注入 —— 注入它的那个构建插件只在打包时跑。"
            />
            <PolicyBlock
              label="每个响应上带的头"
              hint={`这次运行真的加过 ${formatNumber(report.csp.appliedCount)} 次`}
              policy={headerCsp}
              count={headerCount}
              emptyText="开发模式下没有装这道头 —— 装它的那段代码被开发模式判断挡着。这里不填常量，因为常量说的是「打算加什么」，不是「当前生效」。"
            />
          </div>

          {metaCsp !== null && headerCsp !== null && metaCount !== headerCount ? (
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
              两份指令数不一样（{metaCount} 与 {headerCount}）是有意的：meta 那份多几条限制 worker、
              media 和 manifest 的指令，响应头那份没有。多的那几条只在 meta 上生效，
              合成一行显示会把这件事抹掉。
            </p>
          ) : null}
        </Card>

        {/* ③ 枚举运行时那个真实对象，而不是从文档里抄一份清单。 */}
        <Card className="mt-3">
          <CardTitle icon={KeyRound}>渲染进程能调用的全部能力</CardTitle>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            下面这些是<strong className="text-ink">此刻</strong>从那个桥接对象上枚举出来的，
            不是从文档里抄的清单。除了它们，这个界面碰不到你电脑上的任何东西 ——
            没有文件读写，没有执行命令，也没有发请求的能力。
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {Object.keys(window.gleam)
              .sort()
              .map((key) => (
                <code
                  key={key}
                  className="rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[11.5px] text-ink-soft"
                >
                  {key}
                </code>
              ))}
          </div>
        </Card>

        {/* ④ TLS 验证器：0 是预期，不是「没接上线」。 */}
        <Card className="mt-3">
          <CardTitle icon={Cable}>TLS 证书验证器</CardTitle>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            {report.tls.installed
              ? '已装上，并且对任何证书都恒定返回同一个判决：直接判为不可信。'
              : '没有装上 —— 这与本应用的设计不符，请报告给项目。'}
          </p>
          <div className="mt-2.5 flex gap-2">
            <Badge className="bg-neutral-soft text-ink-soft">判决值 {report.tls.verdict}</Badge>
            <Badge className="bg-neutral-soft text-ink-soft">
              被问过 {formatNumber(report.tls.calls)} 次
            </Badge>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
            被问过 0 次是预期的结果，不是「没接上线」：本应用本来就不发起 TLS 连接，
            所以验证器一直没有被问到。它装在那里是最后一道保险。
          </p>
        </Card>

        {/* ⑤⑥ 构建期证据。拿不到就说拿不到。 */}
        <Card className="mt-3">
          <CardTitle icon={FileCheck2}>构建期校验</CardTitle>
          {report.build === null ? (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
              这次拿不到构建期证据。开发模式下这是常态；跑一次生成证据的脚本之后，这一格会照实显示。
            </p>
          ) : (
            <dl className="mt-2.5 space-y-1.5">
              <EvidenceRow label="构建时的提交号" value={report.build.gitSha} mono />
              <EvidenceRow
                label="构建时跑过的测试条数"
                value={report.build.testCount === null ? null : formatNumber(report.build.testCount)}
              />
              <EvidenceRow label="构建平台" value={report.build.platform} />
              <EvidenceRow
                label="构建时刻"
                value={report.build.builtAt === null ? null : formatDateTime(report.build.builtAt)}
              />
            </dl>
          )}
        </Card>

        <Card className="mt-3">
          <CardTitle icon={Boxes}>完整依赖清单</CardTitle>
          {report.dependencies === null ? (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
              这次拿不到依赖树证据。开发模式下这是常态；跑一次生成证据的脚本之后，这一格会照实显示。
            </p>
          ) : (
            <>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
                去重之后一共 <strong className="text-ink">{formatNumber(report.dependencies.packageCount)}</strong> 个包
                {report.dependencies.generatedAt === null
                  ? '。'
                  : `，清单生成于 ${formatDateTime(report.dependencies.generatedAt)}。`}
              </p>
              {report.dependencies.packagesTruncated ? (
                <p className="mt-1 text-[11.5px] text-ink-faint">
                  列表只显示前 {formatNumber(report.dependencies.packages.length)} 个；
                  上面那个总数是精确的，完整的原始文件随包一起发出。
                </p>
              ) : null}
              <div className="mt-2.5 max-h-64 overflow-y-auto rounded-lg border border-line bg-canvas p-2">
                <div className="flex flex-wrap gap-1">
                  {report.dependencies.packages.map((pkg) => (
                    <code
                      key={`${pkg.name}@${pkg.version}`}
                      className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-faint"
                    >
                      {pkg.name}@{pkg.version}
                    </code>
                  ))}
                </div>
              </div>
            </>
          )}
        </Card>

        {/* 「你自己试」。 */}
        <Card className="mt-3">
          <CardTitle icon={FlaskConical}>你自己试</CardTitle>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            填一个地址，本应用会真的去加载一次，然后把结果照实报出来。
            这次演示产生的拦截记在上面「你自己试触发的」那一栏，不会污染「本应用自己发起的」那个数。
          </p>

          <div className="mt-3 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <TextInput
                value={probeUrl}
                onChange={setProbeUrl}
                placeholder="要带协议，比如 http 或 https"
              />
            </div>
            <Button
              variant="primary"
              onClick={runProbe}
              disabled={probe.phase === 'running' || probeUrl.trim() === ''}
            >
              {probe.phase === 'running' ? '试着加载…' : '试一下'}
            </Button>
          </div>

          {probe.phase === 'rejected' ? (
            <p className="mt-2.5 rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] leading-relaxed text-ink-soft">
              {probe.reason}
            </p>
          ) : null}

          {probe.phase === 'done' ? (
            <div
              className={
                probe.tone === 'ok'
                  ? 'mt-2.5 rounded-lg border border-file/40 bg-file-soft px-3 py-2'
                  : 'mt-2.5 rounded-lg border border-error/40 bg-error-soft px-3 py-2'
              }
            >
              <div
                className={
                  probe.tone === 'ok'
                    ? 'text-[13px] font-semibold text-ink'
                    : 'text-[13px] font-semibold text-error'
                }
              >
                {probe.title}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{probe.detail}</p>
            </div>
          ) : null}
        </Card>

        <div className="mt-6">
          <Button onClick={() => actions.setView('privacy')}>返回隐私说明</Button>
        </div>
      </div>
    </div>
  )
}

function Header(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-file-soft text-file">
        <ShieldCheck size={18} />
      </span>
      <div>
        <h1 className="text-[22px] leading-tight font-semibold text-ink">离线自检</h1>
        <p className="text-[12.5px] text-ink-soft">
          这一页上的每个数都来自这次运行本身，你不用相信任何一句承诺。
        </p>
      </div>
    </div>
  )
}

function CardTitle({
  icon: Icon,
  children
}: {
  icon: typeof ShieldCheck
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <h2 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
      <Icon size={15} className="shrink-0 text-ink-faint" />
      {children}
    </h2>
  )
}

function PolicyBlock({
  label,
  hint,
  policy,
  count,
  emptyText
}: {
  label: string
  hint: string
  policy: string | null
  count: number
  emptyText: string
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-ink">{label}</span>
        {policy === null ? null : (
          <Badge className="bg-neutral-soft text-ink-soft">{count} 条指令</Badge>
        )}
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-faint">{hint}</div>
      {policy === null ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{emptyText}</p>
      ) : (
        <code className="mt-1.5 block font-mono text-[11.5px] leading-relaxed break-all text-ink-soft">
          {policy}
        </code>
      )}
    </div>
  )
}

function EvidenceRow({
  label,
  value,
  mono = false
}: {
  label: string
  value: string | null
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-40 shrink-0 text-[12.5px] text-ink-soft">{label}</dt>
      {value === null ? (
        // 「不可用」和一个看起来正常的空值长得不能一样。
        <dd className="text-[12.5px] text-ink-faint">不可用</dd>
      ) : (
        <dd
          className={
            mono
              ? 'min-w-0 flex-1 font-mono text-[11.5px] break-all text-ink'
              : 'min-w-0 flex-1 text-[12.5px] text-ink'
          }
        >
          {value}
        </dd>
      )}
    </div>
  )
}
