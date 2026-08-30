import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_OPTIONS } from '../../src/shared/constants'
import type { CodexEvent, CodexSession, ExportOptions } from '../../src/shared/types'
import { renderExport, toSafeFileName } from '../../src/main/exporters'
import { buildReportModel } from '../../src/main/exporters/reportModel'
import { escapeHtml } from '../../src/main/exporters/html'
import { fixturePath, loadFixture, testFixturePath } from '../support/fixtures'

const NOW = new Date('2026-08-29T12:00:00.000Z')

async function session(): Promise<CodexSession> {
  const { sessions } = await loadFixture(fixturePath('sample-codex-session.jsonl'))
  return sessions[0]!
}

function render(target: CodexSession, format: 'markdown' | 'html' | 'json', options?: Partial<ExportOptions>) {
  return renderExport({
    session: target,
    format,
    options: { ...DEFAULT_EXPORT_OPTIONS, ...options },
    homeDir: 'C:\\Users\\demo',
    platform: 'win32',
    now: NOW
  })
}

describe('报告模型', () => {
  it('把会话拆成需求、回复、命令、文件、测试、错误几部分', async () => {
    const model = buildReportModel(await session(), DEFAULT_EXPORT_OPTIONS, {
      homeDir: 'C:\\Users\\demo',
      platform: 'win32',
      appName: '拾光',
      now: NOW
    })

    expect(model.userMessages.length).toBeGreaterThanOrEqual(1)
    expect(model.assistantMessages.length).toBeGreaterThanOrEqual(4)
    // 示例会话里正好 7 条命令（含两次 npm test），一条不多一条不少。
    expect(model.commands.map((command) => command.command)).toEqual([
      "rg -n 'coupon|discount' src/ --type ts",
      'cat src/cart/price.ts',
      'npm run lint',
      'npm test',
      'npm test',
      'cat .env.local',
      'git diff --stat'
    ])
    expect(model.fileChanges.map((change) => change.path)).toEqual(['src/cart/price.ts'])
    expect(model.tests).toHaveLength(2)
    expect(model.timeline).toHaveLength(model.counts.events)
  })

  /**
   * 补丁应用的结果会被配到那次「文件改动」上，它不是一条命令。
   * 原来的实现拿"最后一条命令"来接输出，于是这种结果会在命令表里
   * 冒出一条空洞的「（未记录命令）」，甚至顶掉真命令的输出。
   */
  it('补丁结果不会在命令表里冒出一条「未记录命令」', async () => {
    const model = buildReportModel(await session(), DEFAULT_EXPORT_OPTIONS, {
      homeDir: 'C:\\Users\\demo',
      platform: 'win32',
      appName: '拾光',
      now: NOW
    })

    expect(model.commands.every((command) => command.command !== '（未记录命令）')).toBe(true)
  })

  /**
   * 并发命令的事件顺序是「命令 A、命令 B、输出 A、输出 B」。
   *
   * 原来的实现拿"最后一条命令"来接输出，于是输出 A 被挂到命令 B 上，
   * 输出 B 又变成另一条记录 —— 导出的报告把两条命令的结果整个错位。
   * 该配给谁，解析阶段已经按 call_id 判断好了，照着 linkedCommandId 查就对了。
   */
  it('并发命令的输出各归各主，不会错位', async () => {
    const { sessions } = await loadFixture(testFixturePath('concurrent-commands.jsonl'))
    const model = buildReportModel(sessions[0]!, DEFAULT_EXPORT_OPTIONS, {
      homeDir: 'C:\\Users\\demo',
      platform: 'win32',
      appName: '拾光',
      now: NOW
    })

    expect(model.commands.map((command) => command.command)).toEqual([
      'npm run lint',
      'node scripts/build.mjs'
    ])

    const lint = model.commands[0]!
    const build = model.commands[1]!

    expect(lint.output).toContain('AAA-lint-output')
    expect(lint.output).not.toContain('BBB-build-output')
    expect(lint.exitCode).toBe(1)
    expect(lint.success).toBe(false)

    expect(build.output).toContain('BBB-build-output')
    expect(build.output).not.toContain('AAA-lint-output')
    expect(build.exitCode).toBe(0)
    expect(build.success).toBe(true)
  })

  it('并发命令的耗时也各归各主', async () => {
    const { sessions } = await loadFixture(testFixturePath('concurrent-commands.jsonl'))
    const model = buildReportModel(sessions[0]!, DEFAULT_EXPORT_OPTIONS, {
      homeDir: 'C:\\Users\\demo',
      platform: 'win32',
      appName: '拾光',
      now: NOW
    })

    expect(model.commands[0]?.durationMs).toBe(6000)
    expect(model.commands[1]?.durationMs).toBe(9000)
  })

  it('测试命令带上自己的结果，不写「结果未记录」', async () => {
    const model = buildReportModel(await session(), DEFAULT_EXPORT_OPTIONS, {
      homeDir: 'C:\\Users\\demo',
      platform: 'win32',
      appName: '拾光',
      now: NOW
    })

    const runs = model.commands.filter((command) => command.command === 'npm test')
    expect(runs).toHaveLength(2)
    // 先失败、后通过 —— 命令表里要能看出来。
    expect(runs.map((command) => command.success)).toEqual([false, true])
  })

  it('命令与它的输出被配到一起，退出码保留', async () => {
    const model = buildReportModel(await session(), DEFAULT_EXPORT_OPTIONS, {
      homeDir: 'C:\\Users\\demo',
      platform: 'win32',
      appName: '拾光'
    })

    const lint = model.commands.find((command) => command.command === 'npm run lint')
    expect(lint?.exitCode).toBe(1)
    expect(lint?.success).toBe(false)
    expect(lint?.output).toContain('1 problem')
  })

  it('关闭"包含命令输出"后输出为空', async () => {
    const model = buildReportModel(
      await session(),
      { ...DEFAULT_EXPORT_OPTIONS, includeCommandOutput: false },
      { homeDir: 'C:\\Users\\demo', platform: 'win32', appName: '拾光' }
    )

    expect(model.commands.every((command) => command.output === null)).toBe(true)
  })

  it('关闭"显示完整路径"时用 ~ 代替用户目录', async () => {
    const context = {
      homeDir: 'C:\\Users\\demo',
      platform: 'win32' as const,
      appName: '拾光'
    }

    // 项目目录在示例数据里位于 C:\Users\demo 下，应该被缩写。
    expect(buildReportModel(await session(), DEFAULT_EXPORT_OPTIONS, context).session.projectPath).toBe(
      '~\\projects\\demo-shop'
    )

    expect(
      buildReportModel(await session(), { ...DEFAULT_EXPORT_OPTIONS, showFullPaths: true }, context)
        .session.projectPath
    ).toBe('C:\\Users\\demo\\projects\\demo-shop')
  })

  /*
   * 报告是要发出去的文件。路径缩写了、可标题没缩写的话，用户名照旧
   * 明明白白写在时间线那一节里 —— 标题是我们自己拼的，路径就长在句子中间。
   */
  /*
   * 报告是要发出去的文件。路径字段缩写了、正文没缩写的话，用户名照样明明白白
   * 写在时间线、命令、错误那几节里。
   */
  describe('关闭"显示完整路径"时报告正文也不留用户目录', () => {
    const HOME = 'C:\\Users\\demo'
    const context = { homeDir: HOME, platform: 'win32' as const, appName: '拾光' }

    async function withLeakyEvents(): Promise<CodexSession> {
      const target = await session()
      const template = target.events[0]!
      const extra: CodexEvent[] = [
        {
          ...template,
          id: 'evt-cmd',
          type: 'shell_command',
          title: `cat ${HOME}\\.ssh\\config`,
          command: `cat ${HOME}\\.ssh\\config`,
          content: `cat ${HOME}\\.ssh\\config`
        },
        {
          ...template,
          id: 'evt-out',
          type: 'command_output',
          title: '命令输出（失败，退出码 1）',
          command: 'npm ci',
          content: `npm ERR! path ${HOME}\\projects\\demo-shop\\package.json`,
          exitCode: 1,
          success: false
        },
        {
          ...template,
          id: 'evt-err',
          type: 'error',
          title: `打不开 ${HOME}\\projects\\demo-shop\\src\\a.ts`,
          content: `ENOENT: ${HOME}\\projects\\demo-shop\\src\\a.ts`
        }
      ]
      return { ...target, events: [...target.events, ...extra] }
    }

    it('时间线标题、命令、命令输出、错误正文全部换成 ~', async () => {
      const model = buildReportModel(await withLeakyEvents(), DEFAULT_EXPORT_OPTIONS, context)
      const everything = JSON.stringify(model)

      expect(everything).not.toContain('Users\\\\demo')
      expect(everything).not.toContain('Users/demo')
      expect(model.timeline.some((entry) => entry.title.includes('~\\.ssh\\config'))).toBe(true)
      expect(model.commands.some((entry) => entry.command === 'cat ~\\.ssh\\config')).toBe(true)
      expect(model.commands.some((entry) => entry.output?.includes('~\\projects'))).toBe(true)
      expect(model.errors.some((entry) => entry.content.includes('~\\projects'))).toBe(true)
    })

    it('开启时原样保留，一个字都不改', async () => {
      const model = buildReportModel(
        await withLeakyEvents(),
        { ...DEFAULT_EXPORT_OPTIONS, showFullPaths: true },
        context
      )

      expect(model.commands.some((entry) => entry.command === `cat ${HOME}\\.ssh\\config`)).toBe(true)
      expect(model.errors.some((entry) => entry.content.includes(HOME))).toBe(true)
    })

    it('渲染出来的 Markdown 里也没有用户名', async () => {
      const rendered = renderExport({
        session: await withLeakyEvents(),
        format: 'markdown',
        options: DEFAULT_EXPORT_OPTIONS,
        homeDir: HOME,
        platform: 'win32',
        now: NOW
      })

      expect(rendered.content).not.toContain('Users\\demo')
      expect(rendered.content).toContain('~\\.ssh\\config')
    })
  })

  it('只有开启"附带原始 JSON"时才带 raw', async () => {
    const target = await session()
    const context = { homeDir: null, platform: 'win32' as const, appName: '拾光' }

    expect(buildReportModel(target, DEFAULT_EXPORT_OPTIONS, context).raw).toBeNull()
    expect(
      buildReportModel(target, { ...DEFAULT_EXPORT_OPTIONS, includeRawJson: true }, context).raw
    ).not.toBeNull()
  })
})

describe('Markdown 导出', () => {
  it('包含规格要求的全部章节', async () => {
    const { content, fileName, extension } = render(await session(), 'markdown')

    expect(extension).toBe('md')
    expect(fileName.endsWith('.md')).toBe(true)
    for (const heading of [
      '## 一、会话基本信息',
      '## 二、总体情况',
      '## 三、你提出的需求',
      '## 四、Codex 的关键回复',
      '## 五、执行过的命令',
      '## 六、修改过的文件',
      '## 七、测试结果',
      '## 八、错误记录',
      '## 九、完整时间线'
    ]) {
      expect(content, heading).toContain(heading)
    }
  })

  it('命令表格里带出失败的退出码', async () => {
    const content = render(await session(), 'markdown').content

    expect(content).toContain('npm run lint')
    expect(content).toContain('失败（退出码 1）')
  })

  it('文件差异用 diff 代码块呈现', async () => {
    const content = render(await session(), 'markdown').content

    expect(content).toContain('```diff')
    expect(content).toContain('src/cart/price.ts')
    expect(content).toContain('subtotal >= coupon.threshold')
  })

  it('默认打码，并在结尾说明这一点', async () => {
    const content = render(await session(), 'markdown').content

    expect(content).not.toContain('sk-demo-FAKE')
    expect(content).toContain('[已打码]')
    expect(content).toContain('敏感信息已自动打码')
  })

  it('关闭打码时给出警告文字', async () => {
    const content = render(await session(), 'markdown', { redactSensitive: false }).content
    expect(content).toContain('未启用敏感信息打码')
  })

  it('表格单元格里的竖线被转义，不会破坏表格', async () => {
    const content = render(await session(), 'markdown').content
    const tableLines = content.split('\n').filter((line) => line.startsWith('| '))

    for (const line of tableLines) {
      const cells = line.split(/(?<!\\)\|/).length
      expect(cells).toBeGreaterThanOrEqual(3)
    }
  })

  it("包含原始 JSON 时追加附录", async () => {
    const content = render(await session(), 'markdown', { includeRawJson: true }).content
    expect(content).toContain('## 附录、原始数据')
    expect(content).toContain('```json')
  })
})

describe('HTML 导出', () => {
  it('是一份完整的、可离线打开的 HTML', async () => {
    const { content, extension } = render(await session(), 'html')

    expect(extension).toBe('html')
    expect(content.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(content).toContain('<html lang="zh-CN">')
    expect(content).toContain('</html>')
    expect(content).toContain('<style>')
  })

  it('不引用任何外部资源，也没有脚本', async () => {
    const content = render(await session(), 'html').content

    expect(content).not.toContain('<script')
    expect(content).not.toContain('http://')
    expect(content).not.toMatch(/<link[^>]+href/i)
    expect(content).not.toMatch(/@import\s+url/i)
    expect(content).not.toMatch(/src\s*=\s*"https?:/i)
  })

  it('自带一条限制外部资源的 CSP', async () => {
    const content = render(await session(), 'html').content
    expect(content).toContain('Content-Security-Policy')
    expect(content).toContain("default-src 'none'")
  })

  it('差异按增删着色', async () => {
    const content = render(await session(), 'html').content

    expect(content).toContain('class="d-add"')
    expect(content).toContain('class="d-del"')
  })

  it('转义 HTML 特殊字符，防止内容破坏页面结构', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    )
    expect(escapeHtml("it's & that")).toBe('it&#39;s &amp; that')
  })

  it('会话内容里的尖括号不会变成真的标签', async () => {
    const target = await session()
    const withHtml: CodexSession = {
      ...target,
      events: [
        {
          ...target.events[0]!,
          type: 'user_message',
          title: '注入测试',
          content: '<script>window.x=1</script><b>粗体</b>'
        }
      ]
    }

    const content = render(withHtml, 'html').content
    expect(content).not.toContain('<script>window.x=1</script>')
    expect(content).toContain('&lt;script&gt;')
  })

  it('默认打码', async () => {
    const content = render(await session(), 'html').content
    expect(content).not.toContain('sk-demo-FAKE')
    expect(content).toContain('[已打码]')
  })
})

describe('JSON 导出', () => {
  it('输出结构稳定、带版本号，且可以被重新解析', async () => {
    const { content, extension } = render(await session(), 'json')

    expect(extension).toBe('json')
    const parsed = JSON.parse(content) as Record<string, unknown>

    expect(parsed.schema).toBe('gleam.session-export')
    expect(parsed.schemaVersion).toBe('1.0')
    expect(parsed.offline).toBe(true)
    expect(parsed.redacted).toBe(true)
    expect(parsed).toHaveProperty('session')
    expect(parsed).toHaveProperty('counts')
    expect(parsed).toHaveProperty('commands')
    expect(parsed).toHaveProperty('fileChanges')
    expect(parsed).toHaveProperty('tests')
    expect(parsed).toHaveProperty('errors')
    expect(parsed).toHaveProperty('timeline')
  })

  it('默认不带 raw，开启后才有', async () => {
    const target = await session()

    expect(JSON.parse(render(target, 'json').content)).not.toHaveProperty('raw')
    expect(JSON.parse(render(target, 'json', { includeRawJson: true }).content)).toHaveProperty('raw')
  })

  it('打码后的 JSON 里没有密钥', async () => {
    const content = render(await session(), 'json', { includeRawJson: true }).content

    expect(content).not.toContain('sk-demo-FAKE')
    expect(content).not.toContain('demoPassw0rd')
  })
})

describe('导出文件名', () => {
  it('去掉文件系统不允许的字符', () => {
    expect(toSafeFileName('修好 a/b:c*d?e"f<g>h|i')).toBe('修好 a b c d e f g h i')
  })

  it('空标题时退回默认名', () => {
    expect(toSafeFileName('   ')).toBe('codex-session')
  })

  it('过长标题被截断', () => {
    expect(toSafeFileName('长'.repeat(200)).length).toBeLessThanOrEqual(60)
  })

  it('文件名带上导出日期', async () => {
    expect(render(await session(), 'markdown').fileName).toContain('2026-08-29')
  })
})
