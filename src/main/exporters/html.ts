import {
  describeChangeKind,
  formatBytes,
  formatDateTime,
  formatDuration,
  type ReportModel
} from './reportModel'

/**
 * 生成完全离线的静态 HTML 报告。
 *
 * 硬性要求：没有任何 <script>、没有外链 CSS/字体/图片，双击即可用浏览器打开。
 * 所有样式内联在 <style> 里，字体使用系统字体栈。
 */

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderDiff(diff: string): string {
  return diff
    .split(/\r?\n/)
    .map((line) => {
      const escaped = escapeHtml(line)
      if (line.startsWith('+++') || line.startsWith('---')) return `<span class="d-meta">${escaped}</span>`
      if (line.startsWith('@@')) return `<span class="d-hunk">${escaped}</span>`
      if (line.startsWith('+')) return `<span class="d-add">${escaped}</span>`
      if (line.startsWith('-')) return `<span class="d-del">${escaped}</span>`
      return `<span class="d-ctx">${escaped}</span>`
    })
    .join('\n')
}

function statusBadge(success: boolean | null, exitCode: number | null): string {
  if (success === true) return '<span class="badge ok">成功</span>'
  if (success === false) {
    const suffix = exitCode === null ? '' : `（退出码 ${exitCode}）`
    return `<span class="badge fail">失败${escapeHtml(suffix)}</span>`
  }
  return '<span class="badge muted">未记录结果</span>'
}

const STYLES = `
:root {
  color-scheme: light;
  --bg: #f6f6f4;
  --surface: #ffffff;
  --ink: #1c1b19;
  --ink-soft: #5f5c56;
  --line: #e2ded6;
  --accent: #b45309;
  --ok: #15803d;
  --fail: #b91c1c;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 40px 24px 80px;
  background: var(--bg);
  color: var(--ink);
  font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.7;
}
.wrap { max-width: 940px; margin: 0 auto; }
header {
  border-bottom: 3px solid var(--accent);
  padding-bottom: 20px;
  margin-bottom: 32px;
}
h1 { font-size: 27px; margin: 0 0 8px; line-height: 1.35; }
h2 {
  font-size: 19px;
  margin: 44px 0 14px;
  padding-left: 11px;
  border-left: 4px solid var(--accent);
}
h3 { font-size: 15px; margin: 22px 0 8px; color: var(--ink-soft); font-weight: 600; }
.sub { color: var(--ink-soft); font-size: 13px; margin: 0; }
table { width: 100%; border-collapse: collapse; margin: 12px 0 20px; font-size: 14px; }
th, td { border: 1px solid var(--line); padding: 8px 11px; text-align: left; vertical-align: top; }
th { background: #efece5; font-weight: 600; width: 180px; }
table.grid th { width: auto; }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
pre {
  background: #1f1d1a;
  color: #ece8e1;
  padding: 14px 16px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
  font-family: Consolas, "Cascadia Mono", "Courier New", monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
pre.diff { background: #fbfaf8; color: #2a2724; border: 1px solid var(--line); }
pre.diff span { display: block; }
.d-add { background: #e5f4e9; color: #14532d; }
.d-del { background: #fceaea; color: #7f1d1d; }
.d-hunk { color: #7c5cbf; }
.d-meta { color: var(--ink-soft); }
blockquote {
  margin: 0 0 16px;
  padding: 12px 16px;
  background: var(--surface);
  border-left: 4px solid #cbd5e1;
  border-radius: 0 8px 8px 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.card-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0 8px; }
.card {
  flex: 1 1 132px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
}
.card .k { font-size: 12px; color: var(--ink-soft); }
.card .v { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
.card.warn .v { color: var(--fail); }
/* 用量是一句话而不是一个数字，塞进 22px 的卡片里会撑破版面，所以单独一行。 */
.usage { margin: 2px 0 8px; font-size: 13px; color: var(--ink-soft); }
.badge {
  display: inline-block;
  padding: 1px 9px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}
.badge.ok { background: #dcfce7; color: var(--ok); }
.badge.fail { background: #fee2e2; color: var(--fail); }
.badge.muted { background: #ececec; color: var(--ink-soft); }
.msg { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
.msg .when { font-size: 12px; color: var(--ink-soft); margin-bottom: 6px; }
.msg .text { white-space: pre-wrap; word-break: break-word; }
.empty { color: var(--ink-soft); font-style: italic; }
footer { margin-top: 56px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 13px; color: var(--ink-soft); }
code.inline { background: #efece5; padding: 1px 6px; border-radius: 4px; font-family: Consolas, "Courier New", monospace; font-size: 13px; word-break: break-all; }
@media print { body { background: #fff; padding: 0; } .card, .msg, blockquote { break-inside: avoid; } }
`

function section(title: string, body: string): string {
  return `<h2>${escapeHtml(title)}</h2>\n${body}`
}

function emptyNote(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`
}

export function exportHtml(report: ReportModel): string {
  const { session, counts, options } = report
  const parts: string[] = []

  parts.push(
    section(
      '一、会话基本信息',
      `<table>
<tr><th>项目名称</th><td>${escapeHtml(session.projectName)}</td></tr>
<tr><th>项目目录</th><td>${escapeHtml(session.projectPath ?? '未记录')}</td></tr>
<tr><th>会话文件</th><td>${escapeHtml(session.sourceFile)}</td></tr>
<tr><th>文件大小</th><td>${escapeHtml(formatBytes(session.fileSizeBytes))}</td></tr>
<tr><th>开始时间</th><td>${escapeHtml(formatDateTime(session.startedAt))}</td></tr>
<tr><th>结束时间</th><td>${escapeHtml(formatDateTime(session.endedAt))}</td></tr>
<tr><th>持续时长</th><td>${escapeHtml(formatDuration(session.durationMs))}</td></tr>
<tr><th>识别可信度</th><td>${escapeHtml(session.confidence)}（${Math.round(
        session.confidenceScore * 100
      )}%）</td></tr>
</table>`
    )
  )

  const cards = [
    { k: '事件总数', v: counts.events, warn: false },
    { k: '你的消息', v: counts.userMessages, warn: false },
    { k: 'Codex 回复', v: counts.assistantMessages, warn: false },
    { k: '执行命令', v: counts.commands, warn: false },
    { k: '失败命令', v: counts.failedCommands, warn: counts.failedCommands > 0 },
    { k: '修改文件', v: counts.changedFiles, warn: false },
    { k: '测试通过', v: counts.testsPassed, warn: false },
    { k: '测试失败', v: counts.testsFailed, warn: counts.testsFailed > 0 },
    { k: '错误记录', v: counts.errors, warn: counts.errors > 0 }
  ]
  parts.push(
    section(
      '二、总体情况',
      `<div class="card-row">${cards
        .map(
          (card) =>
            `<div class="card${card.warn ? ' warn' : ''}"><div class="k">${escapeHtml(
              card.k
            )}</div><div class="v">${card.v}</div></div>`
        )
        .join('')}</div>
<p class="usage">用量：${escapeHtml(report.usageLine)}</p>`
    )
  )

  parts.push(
    section(
      '三、你提出的需求',
      report.userMessages.length === 0
        ? emptyNote('这个会话里没有记录到你的消息。')
        : report.userMessages
            .map(
              (message, index) =>
                `<div class="msg"><div class="when">需求 ${index + 1} · ${escapeHtml(
                  formatDateTime(message.timestamp)
                )}</div><div class="text">${escapeHtml(message.text.trim())}</div></div>`
            )
            .join('\n')
    )
  )

  parts.push(
    section(
      '四、Codex 的关键回复',
      report.assistantMessages.length === 0
        ? emptyNote('这个会话里没有记录到 Codex 的文字回复。')
        : report.assistantMessages
            .map(
              (message, index) =>
                `<div class="msg"><div class="when">回复 ${index + 1} · ${escapeHtml(
                  formatDateTime(message.timestamp)
                )}</div><div class="text">${escapeHtml(message.text.trim())}</div></div>`
            )
            .join('\n')
    )
  )

  const commandRows = report.commands
    .map(
      (command, index) =>
        `<tr><td class="num">${index + 1}</td><td>${escapeHtml(
          formatDateTime(command.timestamp)
        )}</td><td><code class="inline">${escapeHtml(command.command)}</code></td><td>${statusBadge(
          command.success,
          command.exitCode
        )}</td></tr>`
    )
    .join('\n')

  const outputBlocks =
    options.includeCommandOutput
      ? report.commands
          .map((command, index) => {
            if (!command.output || command.output.trim() === '') return ''
            return `<h3>${index + 1}. ${escapeHtml(command.command.split('\n')[0] ?? '')}</h3>\n<pre>${escapeHtml(
              command.output
            )}</pre>`
          })
          .filter((block) => block !== '')
          .join('\n')
      : ''

  parts.push(
    section(
      '五、执行过的命令',
      report.commands.length === 0
        ? emptyNote('没有记录到命令执行。')
        : `<table class="grid"><thead><tr><th>#</th><th>时间</th><th>命令</th><th>结果</th></tr></thead><tbody>${commandRows}</tbody></table>${
            outputBlocks === '' ? '' : `<h3>命令输出</h3>${outputBlocks}`
          }`
    )
  )

  const fileRows = report.fileChanges
    .map(
      (change) =>
        `<tr><td>${escapeHtml(change.path)}</td><td>${escapeHtml(
          describeChangeKind(change.kind)
        )}</td><td class="num">+${change.additions}</td><td class="num">-${change.deletions}</td></tr>`
    )
    .join('\n')

  const diffBlocks = report.fileChanges
    .filter((change) => change.diff && change.diff.trim() !== '')
    .map(
      (change) =>
        `<h3>${escapeHtml(change.path)}</h3>\n<pre class="diff">${renderDiff(change.diff ?? '')}</pre>`
    )
    .join('\n')

  parts.push(
    section(
      '六、修改过的文件',
      report.fileChanges.length === 0
        ? emptyNote('这个会话没有修改任何文件。')
        : `<table class="grid"><thead><tr><th>文件</th><th>操作</th><th>新增行</th><th>删除行</th></tr></thead><tbody>${fileRows}</tbody></table>${
            diffBlocks === '' ? '' : `<h3>具体差异</h3>${diffBlocks}`
          }`
    )
  )

  parts.push(
    section(
      '七、测试结果',
      report.tests.length === 0
        ? emptyNote('没有记录到测试结果。')
        : `<table class="grid"><thead><tr><th>时间</th><th>框架</th><th>通过</th><th>失败</th><th>跳过</th></tr></thead><tbody>${report.tests
            .map(
              (test) =>
                `<tr><td>${escapeHtml(formatDateTime(test.timestamp))}</td><td>${escapeHtml(
                  test.summary.framework ?? '未知'
                )}</td><td class="num">${test.summary.passed}</td><td class="num">${
                  test.summary.failed
                }</td><td class="num">${test.summary.skipped}</td></tr>`
            )
            .join('\n')}</tbody></table>${
            report.tests.some((test) => test.summary.failures.length > 0)
              ? `<h3>失败用例</h3><ul>${report.tests
                  .flatMap((test) => test.summary.failures)
                  .map(
                    (failure) =>
                      `<li>${escapeHtml(failure.name)}${
                        failure.message ? ` —— ${escapeHtml(failure.message)}` : ''
                      }</li>`
                  )
                  .join('')}</ul>`
              : ''
          }`
    )
  )

  parts.push(
    section(
      '八、错误记录',
      report.errors.length === 0
        ? emptyNote('这个会话没有记录到错误。')
        : report.errors
            .map(
              (error) =>
                `<h3>${escapeHtml(error.title)}</h3><p class="sub">${escapeHtml(
                  formatDateTime(error.timestamp)
                )}</p><pre>${escapeHtml(error.content)}</pre>`
            )
            .join('\n')
    )
  )

  parts.push(
    section(
      '九、完整时间线',
      `<table class="grid"><thead><tr><th>#</th><th>时间</th><th>类型</th><th>摘要</th></tr></thead><tbody>${report.timeline
        .map(
          (entry) =>
            `<tr><td class="num">${entry.index + 1}</td><td>${escapeHtml(
              formatDateTime(entry.timestamp)
            )}</td><td>${escapeHtml(entry.typeLabel)}</td><td>${escapeHtml(entry.title)}</td></tr>`
        )
        .join('\n')}</tbody></table>`
    )
  )

  if (report.warnings.length > 0) {
    parts.push(
      section(
        '十、解析提示',
        `<ul>${report.warnings
          .map(
            (warning) =>
              `<li>${escapeHtml(warning.reason)} <span class="sub">建议：${escapeHtml(
                warning.suggestion
              )}</span></li>`
          )
          .join('')}</ul>`
      )
    )
  }

  if (options.includeRawJson && report.raw !== null) {
    parts.push(
      section('附录、原始数据', `<pre>${escapeHtml(JSON.stringify(report.raw, null, 2))}</pre>`)
    )
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:" />
<title>${escapeHtml(session.title)} —— ${escapeHtml(report.appName)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
<header>
<h1>${escapeHtml(session.title)}</h1>
<p class="sub">项目：${escapeHtml(session.projectName)}&nbsp;&nbsp;·&nbsp;&nbsp;由 ${escapeHtml(
    report.appName
  )} 于 ${escapeHtml(formatDateTime(report.generatedAt))} 在本机离线生成</p>
</header>
${parts.join('\n')}
<footer>
本报告完全在你的电脑上生成，未连接任何网络服务，也未上传任何内容。${
    options.redactSensitive ? '敏感信息（密钥、Token、密码等）已自动打码。' : '注意：本次导出未启用敏感信息打码，请谨慎分享。'
  }
</footer>
</div>
</body>
</html>
`
}
