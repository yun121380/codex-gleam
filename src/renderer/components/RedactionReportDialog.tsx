import { useEffect } from 'react'
import { ArrowRight, Shield, ShieldOff, X } from 'lucide-react'
import {
  REDACTION_PLACEHOLDER,
  REDACTION_REPORT_MAX_KEPT,
  REDACTION_RESIDUAL_MIN_LENGTH,
  REDACTION_RESIDUAL_TOP
} from '@shared/constants'
import type {
  RedactionHit,
  RedactionReport,
  RedactionResidual,
  RedactionRuleGroup
} from '@shared/types'
import { keptReasonLabel, residualShapeLabel, ruleHint, ruleLabel } from '../lib/redactionLabels'
import { Button, Spinner } from './ui'

/** 定位与跳转这一对，三层组件都要用，单独拎出来省得一路往下抄参数。 */
interface JumpProps {
  /** `eventId` 在时间线上的下标；那条事件已经不在了就给 `null`。 */
  locateEvent: (eventId: string) => number | null
  onJump: (index: number) => void
  onClose: () => void
}

/**
 * 「这次分享会打掉什么」这张面板。
 *
 * 它只回答一件事，所以整块是只读的：没有开关、没有导出，点样例也只是跳到那一步。
 * §4.2 那条约束在这一层的样子是 —— 面板上出现的每一段上下文都是**打码之后**的文本，
 * 一个原值都不回显。一个为打码而生的审计面板如果把它找到的密钥显示出来，它自己
 * 就是泄露口。
 *
 * 骨架照着 `ExportDialog` 抄：同一层遮罩、同一个 `aria-modal`、同一个 Escape 关闭、
 * 同样的 `max-h-[60vh]` 正文。两个对话框长得不一样会让人以为它们的行为规则也不一样。
 */
export function RedactionReportDialog({
  open,
  busy,
  sessionTitle,
  report,
  locateEvent,
  onJump,
  onClose
}: {
  open: boolean
  busy: boolean
  sessionTitle: string
  report: RedactionReport | null
} & JumpProps): React.JSX.Element | null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    if (open) window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="打码报告"
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">这次分享会打掉什么</h2>
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
          {report !== null ? (
            <ReportBody
              report={report}
              locateEvent={locateEvent}
              onJump={onJump}
              onClose={onClose}
            />
          ) : busy ? (
            <div className="py-8">
              <Spinner label="正在审计这个会话…" />
            </div>
          ) : (
            /*
             * 没拿到报告时**不能**显示成「很干净」——「审计没跑通」和「这个会话里
             * 没有密钥」在这里是两句完全不同的话，说错了正好把该看的东西藏起来。
             */
            <p className="py-8 text-center text-[12.5px] text-ink-faint">
              没有拿到这个会话的报告。
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-5 py-3">
          <p className="text-[11px] text-ink-faint">
            这份报告只在这儿显示：不写进文件，也不进导出产物。
          </p>
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  )
}

/**
 * 三段：打掉了什么、可能漏了什么、什么被判为不是密钥。
 *
 * 中间那一段是 B2 补上的：前后两段说的都是规则**跑到过**的地方，而规则压根没匹配上
 * 的那些高熵长串，恰恰是唯一有可能带着真密钥进到分享产物里的东西。
 */
function ReportBody({
  report,
  locateEvent,
  onJump,
  onClose
}: { report: RedactionReport } & JumpProps): React.JSX.Element {
  return (
    <>
      {report.redactEnabled ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] leading-relaxed text-ink-soft">
          <Shield size={13} className="mt-0.5 shrink-0 text-accent" />
          <span>分享出去的内容里，这些地方已经被替换成 {REDACTION_PLACEHOLDER}。</span>
        </p>
      ) : (
        /*
         * 这是这个面板最该说的话，所以它在最上面，而且是红的：开关关着的时候，
         * 下面列出来的每一段都会原样进到分享出去的文件里。
         */
        <p className="flex items-start gap-1.5 rounded-lg border border-error/35 bg-error-soft/30 px-3 py-2 text-[12.5px] leading-relaxed text-error">
          <ShieldOff size={13} className="mt-0.5 shrink-0" />
          <span>打码开关现在是关着的 —— 下面这些内容会原样出现在分享出去的文件里。</span>
        </p>
      )}

      <section className="mt-4">
        <SectionHead title="打掉了什么" count={`${report.totalHits} 处`} />
        {report.totalHits === 0 ? (
          <div className="mt-1.5 rounded-lg border border-line bg-canvas px-3 py-2.5">
            <p className="text-[12.5px] text-ink">这个会话里没有认出任何密钥。</p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">
              这不等于它一定干净 —— 认得出的只有已知格式和敏感键名这两类。
            </p>
          </div>
        ) : (
          <div className="mt-1.5 space-y-2.5">
            {report.groups.map((group) => (
              <RuleGroup
                key={group.rule}
                group={group}
                locateEvent={locateEvent}
                onJump={onJump}
                onClose={onClose}
              />
            ))}
          </div>
        )}
      </section>

      <ResidualSection
        report={report}
        locateEvent={locateEvent}
        onJump={onJump}
        onClose={onClose}
      />

      <KeptSection report={report} />
    </>
  )
}

/**
 * 中间那一段：**可能漏了什么**。
 *
 * 语气是这一段最要紧的东西，所以它不是告警 —— 没有红色、没有感叹号、没有「发现 N 个
 * 风险」。高熵检测的天然结局是淹没在噪音里，一个「检出 400 条可疑」的面板等于没有
 * 面板；所以这里没有阈值、没有告警色，只有一个按可疑度降序的定长列表：从最上面看
 * 起，看到不像了就停。
 *
 * 空的时候也不能说「很干净」。这个列表空只说明没有够长的高熵片段，不说明没漏东西，
 * 把它读成体检合格是这一段最坏的用法。
 */
function ResidualSection({
  report,
  locateEvent,
  onJump,
  onClose
}: { report: RedactionReport } & JumpProps): React.JSX.Element {
  return (
    <section className="mt-4 border-t border-line pt-3">
      <SectionHead title="可能漏了什么" count={`${report.residualsTotal} 个片段`} />
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
        这些是打码规则没有匹配上的高熵长串。它不是告警，只是一个排序：按可疑度从高到低
        最多列 {REDACTION_RESIDUAL_TOP} 条，看到不像了就可以停。
      </p>
      {report.residualsPruned ? (
        /*
         * 撞上限之后，「一共有多少个不同片段」就不再是可知的了 —— 要精确回答它得把见
         * 过的每一个都记住，而那正是上限想避免的事。所以这里换一句话说，而不是把一个
         * 算不准的总数说得像准的。
         */
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">
          片段太多，只拿最可疑的一批参与了排名 —— 上面那个数是参与排名的条数，不是会话
          里的全部。
        </p>
      ) : null}
      {report.residuals.length === 0 ? (
        <div className="mt-1.5 rounded-lg border border-line bg-canvas px-3 py-2.5">
          <p className="text-[12.5px] text-ink">
            没有找到 {REDACTION_RESIDUAL_MIN_LENGTH} 字符以上的高熵片段。
          </p>
          {/*
           * 这一句是这一段的诚实底线，不许省：列表空只说明这一种形状的东西没找到，
           * 不说明这个会话没漏东西。
           */}
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">
            这不等于没漏东西 —— 短的、或者混在正常文字里的，这一段看不见。
          </p>
        </div>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {report.residuals.map((residual) => (
            <li key={residual.text}>
              <ResidualRow
                residual={residual}
                locateEvent={locateEvent}
                onJump={onJump}
                onClose={onClose}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * 一条残留。这里显示的是**原文** —— 这一点和上面那一段正好相反。
 *
 * 理由不同：命中报告里的东西已经被打掉了，回显原值等于把打掉的东西又端出来；残留本来
 * 就没被打码，此刻已经明明白白躺在时间线上，面板把它遮起来是自欺。唯一被改写过的是
 * 用户主目录 —— 那件事在 `auditSession` 里做完了，这一层拿到的 `text` 已经是能显示的
 * 样子。
 *
 * 分数徽标只是个数，不上颜色深浅：一上色它就又变成告警了。
 */
function ResidualRow({
  residual,
  locateEvent,
  onJump,
  onClose
}: { residual: RedactionResidual } & JumpProps): React.JSX.Element {
  const at = residual.eventId === null ? null : locateEvent(residual.eventId)
  // 形态说明只在被降权时出现 —— `shape` 为 null 就是「没落在任何已知噪音形态里」，
  // 那正是没有话要补的情况。
  const notes = [
    residual.shape !== null ? `看起来像${residualShapeLabel(residual.shape)}（已降权）` : null,
    residual.length > residual.text.length ? `共 ${residual.length} 字符，只显示开头` : null
  ].filter((note): note is string => note !== null)

  const body = (
    <>
      <span className="shrink-0 rounded bg-raised px-1 py-0.5 font-mono text-[11px] text-ink-soft tabular-nums">
        {residual.score}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-[11.5px] leading-relaxed break-all text-ink-soft">
          {residual.text}
        </span>
        {notes.length > 0 ? (
          <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-faint">
            {notes.join(' · ')}
          </span>
        ) : null}
      </span>
      {/* 出现次数只在大于 1 时说 —— 「1 处」是一句不带信息的话。 */}
      {residual.count > 1 ? (
        <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums">
          {residual.count} 处
        </span>
      ) : null}
    </>
  )

  if (at === null) return <div className={SAMPLE_SHELL}>{body}</div>

  return (
    <button
      type="button"
      title="跳到这一步"
      onClick={() => {
        onJump(at)
        onClose()
      }}
      className={`${SAMPLE_SHELL} transition-colors hover:bg-raised`}
    >
      {body}
      <ArrowRight size={11} className="mt-1 shrink-0 text-ink-faint" />
    </button>
  )
}

/** 下半段。`kept` 往往非空，而且它正是「为什么一个都没打」的答案，所以照常显示。 */
function KeptSection({ report }: { report: RedactionReport }): React.JSX.Element {
  return (
    <section className="mt-4 border-t border-line pt-3">
      <SectionHead title="什么被判为不是密钥" count={`${report.kept.length} 个键名`} />
      {report.kept.length === 0 ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">
          没有任何键名走到这一步 —— 也就没有「判过之后放行」这回事。
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {report.kept.map((entry) => (
            <li
              key={`${entry.keyName}|${entry.reason}`}
              className="flex items-start gap-2 rounded-md bg-surface-2 px-2 py-1.5"
            >
              <code className="shrink-0 rounded bg-raised px-1 py-0.5 font-mono text-[11px] text-ink-soft">
                {entry.keyName}
              </code>
              <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-ink-soft">
                {keptReasonLabel(entry.reason)}
              </span>
              <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums">
                {entry.count} 处
              </span>
            </li>
          ))}
        </ul>
      )}
      {report.keptTruncated ? (
        // 截断了必须说出来。这里给不出"还有几条"——上限是按条数截的，被丢掉的那些
        // 压根没进过报告，编一个数字出来才是真的错。
        <p className="mt-1.5 text-[11.5px] text-ink-faint">
          还有更多键名没有列出 —— 这里最多列 {REDACTION_REPORT_MAX_KEPT} 条。
        </p>
      ) : null}
    </section>
  )
}

/** 段标题：左边一句话，右边一个数。 */
function SectionHead({ title, count }: { title: string; count: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="text-[11px] font-semibold tracking-wider text-ink-faint uppercase">{title}</h3>
      <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">{count}</span>
    </div>
  )
}

/** 一条规则一块：名字、精确计数、一句解释，然后最多 5 条样例。 */
function RuleGroup({
  group,
  locateEvent,
  onJump,
  onClose
}: { group: RedactionRuleGroup } & JumpProps): React.JSX.Element {
  // 别拿 samples.length 当命中数：count 是精确的，样例是截过的。
  const hidden = group.count - group.samples.length

  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-[13px] font-medium text-ink">{ruleLabel(group.rule)}</h4>
        <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums">
          {group.count} 处
        </span>
      </div>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">{ruleHint(group.rule)}</p>
      <ul className="mt-1.5 space-y-1">
        {group.samples.map((sample, at) => (
          <li key={`${sample.eventId ?? ''}|${at}`}>
            <SampleRow
              sample={sample}
              locateEvent={locateEvent}
              onJump={onJump}
              onClose={onClose}
            />
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="mt-1.5 text-[11.5px] text-ink-faint">另有 {hidden} 处未列出。</p>
      ) : null}
    </div>
  )
}

const SAMPLE_SHELL = 'flex w-full items-start gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-left'

/**
 * 一条样例。`maskedContext` 是打码之后的文本 —— 这里显示的东西没有一个是原值。
 *
 * 能定位到那一步时整条做成按钮，点了跳过去并关掉面板（跳过去了还挡着就看不见）。
 * 定位不到时**不做成按钮**：`eventId` 为 `null`（会话标题、摘要里的告警不属于任何
 * 一步），或者那条事件已经不在时间线上了（会话可能被重新解析过）。一个点了没反应
 * 的按钮比一段不能点的文字更差。
 */
function SampleRow({
  sample,
  locateEvent,
  onJump,
  onClose
}: { sample: RedactionHit } & JumpProps): React.JSX.Element {
  const at = sample.eventId === null ? null : locateEvent(sample.eventId)

  const body = (
    <>
      {sample.keyName !== null ? (
        <code className="shrink-0 rounded bg-raised px-1 py-0.5 font-mono text-[11px] text-ink-soft">
          {sample.keyName}
        </code>
      ) : null}
      <span className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-all text-ink-soft">
        {sample.maskedContext}
      </span>
    </>
  )

  if (at === null) return <div className={SAMPLE_SHELL}>{body}</div>

  return (
    <button
      type="button"
      title="跳到这一步"
      onClick={() => {
        onJump(at)
        onClose()
      }}
      className={`${SAMPLE_SHELL} transition-colors hover:bg-raised`}
    >
      {body}
      <ArrowRight size={11} className="mt-1 shrink-0 text-ink-faint" />
    </button>
  )
}
