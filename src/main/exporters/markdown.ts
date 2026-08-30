import {
  describeChangeKind,
  formatBytes,
  formatDateTime,
  formatDuration,
  type ReportModel
} from './reportModel'

/** 把内容放进代码块，并保证内部的反引号不会破坏围栏。 */
function codeBlock(content: string, language = ''): string {
  const text = content.replace(/\s+$/, '')
  if (text === '') return ''
  const longestFence = /(`{3,})/g.exec(text)
  const fence = longestFence?.[1] && longestFence[1].length >= 3 ? '`'.repeat(longestFence[1].length + 1) : '```'
  return `${fence}${language}\n${text}\n${fence}`
}

function statusText(success: boolean | null, exitCode: number | null): string {
  if (success === true) return '成功'
  if (success === false) return exitCode === null ? '失败' : `失败（退出码 ${exitCode}）`
  return '未记录结果'
}

export function exportMarkdown(report: ReportModel): string {
  const lines: string[] = []
  const { session, counts, options } = report

  lines.push(`# ${session.title}`)
  lines.push('')
  lines.push(`> 由 ${report.appName} 于 ${formatDateTime(report.generatedAt)} 导出。本报告完全在本机生成。`)
  lines.push('')

  lines.push('## 一、会话基本信息')
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('| --- | --- |')
  lines.push(`| 项目名称 | ${escapeCell(session.projectName)} |`)
  lines.push(`| 项目目录 | ${escapeCell(session.projectPath ?? '未记录')} |`)
  lines.push(`| 会话文件 | ${escapeCell(session.sourceFile)} |`)
  lines.push(`| 文件大小 | ${formatBytes(session.fileSizeBytes)} |`)
  lines.push(`| 开始时间 | ${formatDateTime(session.startedAt)} |`)
  lines.push(`| 结束时间 | ${formatDateTime(session.endedAt)} |`)
  lines.push(`| 持续时长 | ${formatDuration(session.durationMs)} |`)
  lines.push(`| 识别可信度 | ${session.confidence}（${Math.round(session.confidenceScore * 100)}%） |`)
  lines.push(`| 使用的解析器 | ${escapeCell(session.parserId)} |`)
  lines.push('')

  lines.push('## 二、总体情况')
  lines.push('')
  lines.push('| 指标 | 数值 |')
  lines.push('| --- | --- |')
  lines.push(`| 事件总数 | ${counts.events} |`)
  lines.push(`| 你的消息 | ${counts.userMessages} |`)
  lines.push(`| Codex 回复 | ${counts.assistantMessages} |`)
  lines.push(`| 执行命令 | ${counts.commands} |`)
  lines.push(`| 失败命令 | ${counts.failedCommands} |`)
  lines.push(`| 修改文件 | ${counts.changedFiles} |`)
  lines.push(`| 测试通过 | ${counts.testsPassed} |`)
  lines.push(`| 测试失败 | ${counts.testsFailed} |`)
  lines.push(`| 错误记录 | ${counts.errors} |`)
  lines.push('')

  lines.push('## 三、你提出的需求')
  lines.push('')
  if (report.userMessages.length === 0) {
    lines.push('（这个会话里没有记录到你的消息。）')
  } else {
    report.userMessages.forEach((message, index) => {
      lines.push(`### 需求 ${index + 1} · ${formatDateTime(message.timestamp)}`)
      lines.push('')
      lines.push(quote(message.text))
      lines.push('')
    })
  }

  lines.push('## 四、Codex 的关键回复')
  lines.push('')
  if (report.assistantMessages.length === 0) {
    lines.push('（这个会话里没有记录到 Codex 的文字回复。）')
  } else {
    report.assistantMessages.forEach((message, index) => {
      lines.push(`### 回复 ${index + 1} · ${formatDateTime(message.timestamp)}`)
      lines.push('')
      lines.push(message.text.trim())
      lines.push('')
    })
  }

  lines.push('## 五、执行过的命令')
  lines.push('')
  if (report.commands.length === 0) {
    lines.push('（没有记录到命令执行。）')
  } else {
    lines.push('| # | 时间 | 命令 | 结果 |')
    lines.push('| --- | --- | --- | --- |')
    report.commands.forEach((command, index) => {
      lines.push(
        `| ${index + 1} | ${formatDateTime(command.timestamp)} | \`${escapeCell(
          command.command.replace(/\n/g, ' ⏎ ')
        )}\` | ${statusText(command.success, command.exitCode)} |`
      )
    })
    lines.push('')

    if (options.includeCommandOutput) {
      lines.push('### 命令输出')
      lines.push('')
      report.commands.forEach((command, index) => {
        if (!command.output || command.output.trim() === '') return
        lines.push(`**${index + 1}. ${command.command.split('\n')[0] ?? ''}**`)
        lines.push('')
        lines.push(codeBlock(command.output, 'text'))
        lines.push('')
      })
    }
  }

  lines.push('## 六、修改过的文件')
  lines.push('')
  if (report.fileChanges.length === 0) {
    lines.push('（这个会话没有修改任何文件。）')
  } else {
    lines.push('| 文件 | 操作 | 新增行 | 删除行 |')
    lines.push('| --- | --- | --- | --- |')
    for (const change of report.fileChanges) {
      lines.push(
        `| ${escapeCell(change.path)} | ${describeChangeKind(change.kind)} | +${change.additions} | -${
          change.deletions
        } |`
      )
    }
    lines.push('')

    const withDiff = report.fileChanges.filter((change) => change.diff && change.diff.trim() !== '')
    if (withDiff.length > 0) {
      lines.push('### 具体差异')
      lines.push('')
      for (const change of withDiff) {
        lines.push(`**${change.path}**`)
        lines.push('')
        lines.push(codeBlock(change.diff ?? '', 'diff'))
        lines.push('')
      }
    }
  }

  lines.push('## 七、测试结果')
  lines.push('')
  if (report.tests.length === 0) {
    lines.push('（没有记录到测试结果。）')
  } else {
    for (const test of report.tests) {
      const { summary } = test
      lines.push(
        `- ${formatDateTime(test.timestamp)}｜${summary.framework ?? '测试'}：通过 ${
          summary.passed
        }、失败 ${summary.failed}、跳过 ${summary.skipped}`
      )
      for (const failure of summary.failures) {
        lines.push(`  - 失败用例：${failure.name}${failure.message ? ` —— ${failure.message}` : ''}`)
      }
    }
    lines.push('')
  }

  lines.push('## 八、错误记录')
  lines.push('')
  if (report.errors.length === 0) {
    lines.push('（这个会话没有记录到错误。）')
  } else {
    for (const error of report.errors) {
      lines.push(`### ${error.title}`)
      lines.push('')
      lines.push(`时间：${formatDateTime(error.timestamp)}`)
      lines.push('')
      lines.push(codeBlock(error.content, 'text'))
      lines.push('')
    }
  }

  lines.push('## 九、完整时间线')
  lines.push('')
  lines.push('| # | 时间 | 类型 | 摘要 |')
  lines.push('| --- | --- | --- | --- |')
  for (const entry of report.timeline) {
    lines.push(
      `| ${entry.index + 1} | ${formatDateTime(entry.timestamp)} | ${entry.typeLabel} | ${escapeCell(
        entry.title
      )} |`
    )
  }
  lines.push('')

  if (report.warnings.length > 0) {
    lines.push('## 十、解析提示')
    lines.push('')
    for (const warning of report.warnings) {
      lines.push(`- ${warning.reason} 建议：${warning.suggestion}`)
    }
    lines.push('')
  }

  if (options.includeRawJson && report.raw !== null) {
    lines.push('## 附录、原始数据')
    lines.push('')
    lines.push(codeBlock(JSON.stringify(report.raw, null, 2), 'json'))
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(
    `本报告由 ${report.appName} 在本机离线生成，未上传任何内容。${
      options.redactSensitive ? '敏感信息已自动打码。' : '注意：本次导出未启用敏感信息打码。'
    }`
  )
  lines.push('')

  return lines.join('\n')
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
