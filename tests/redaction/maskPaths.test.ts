import { describe, expect, it } from 'vitest'
import { maskSessionPaths, maskSummaryPaths } from '../../src/main/redaction/maskPaths'
import type { CodexEvent, CodexSession } from '../../src/shared/types'

/**
 * 关闭「显示完整路径」时，送往界面与报告的**文字**里不能留下用户主目录。
 *
 * 这件事原来是给每个字段各配一份 display 副本来做的，连着漏了三轮：
 * 先漏事件标题，再漏命令，再漏命令输出和会话标题 —— 每加一个要显示的文本字段
 * 就得有人记得同步加副本，记不住是必然的。现在改成在送出去那一刻统一处理。
 *
 * 这里最要紧的两组断言是**反向**的那些：路径字段必须原样保留。
 * 把 relatedFiles 也换成 `~`，「在文件管理器中定位」就再也定位不到了。
 */

const HOME = 'C:\\Users\\alice'
const OPTIONS = { homeDir: HOME, platform: 'win32' as const }

function event(overrides: Partial<CodexEvent>): CodexEvent {
  return {
    id: 'e1',
    timestamp: '2026-08-28T10:00:00.000Z',
    type: 'shell_command',
    title: `cat ${HOME}\\.ssh\\config`,
    content: `cat ${HOME}\\.ssh\\config`,
    sourceFile: `${HOME}\\.codex\\a.jsonl`,
    workingDirectory: `${HOME}\\proj`,
    relatedFiles: [`${HOME}\\proj\\src\\a.ts`],
    displayWorkingDirectory: '~\\proj',
    displayRelatedFiles: ['~\\proj\\src\\a.ts'],
    success: null,
    raw: null,
    ...overrides
  }
}

function session(overrides: Partial<CodexSession> = {}): CodexSession {
  return {
    id: 's1',
    title: `帮我改一下 ${HOME}\\proj\\src\\a.ts`,
    projectName: 'proj',
    projectPath: `${HOME}\\proj`,
    sourceFile: `${HOME}\\.codex\\a.jsonl`,
    displaySourceFile: '~\\.codex\\a.jsonl',
    fileSizeBytes: 10,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    eventCount: 1,
    userMessageCount: 0,
    assistantMessageCount: 0,
    commandCount: 1,
    failedCommandCount: 0,
    changedFileCount: 0,
    changedFiles: [],
    testsPassed: 0,
    testsFailed: 0,
    errorCount: 0,
    hasFailures: false,
    hasCodeChanges: false,
    confidence: 'high',
    confidenceScore: 1,
    parserId: 'test',
    eventTypeCounts: {},
    warnings: [],
    indexedAt: '2026-08-30T00:00:00.000Z',
    fileModifiedAt: null,
    agent: { threadId: null, parentThreadId: null, nickname: null, role: null, taskPath: null },
    events: [event({})],
    ...overrides
  }
}

describe('会话标题', () => {
  it('标题里的主目录换成 ~', () => {
    // 标题多半就是用户说的第一句话，而那句话里带路径极其常见。
    const masked = maskSummaryPaths(session(), OPTIONS)
    expect(masked.title).toBe('帮我改一下 ~\\proj\\src\\a.ts')
  })

  it('会话自己的路径字段不动（列表要靠它们定位文件）', () => {
    const masked = maskSummaryPaths(session(), OPTIONS)
    expect(masked.sourceFile).toBe(`${HOME}\\.codex\\a.jsonl`)
    expect(masked.displaySourceFile).toBe('~\\.codex\\a.jsonl')
  })
})

describe('事件文字', () => {
  it('标题、正文、命令都处理', () => {
    const masked = maskSessionPaths(session(), OPTIONS)
    const first = masked.events[0]!

    expect(first.title).toBe('cat ~\\.ssh\\config')
    expect(first.content).toBe('cat ~\\.ssh\\config')
  })

  it('命令输出这种大段正文同样处理（原来正是这里在漏）', () => {
    const masked = maskSessionPaths(
      session({
        events: [
          event({
            type: 'command_output',
            title: '命令输出（失败，退出码 1）',
            command: 'npm ci',
            content: `npm ERR! path ${HOME}\\proj\\package.json\nnpm ERR! errno -4058`
          })
        ]
      }),
      OPTIONS
    )

    const first = masked.events[0]!
    expect(first.content).toContain('~\\proj\\package.json')
    expect(first.content).not.toContain('alice')
  })

  it('差异文本、测试失败详情、原始数据一并处理', () => {
    const masked = maskSessionPaths(
      session({
        events: [
          event({
            type: 'file_edit',
            fileChanges: [
              {
                path: `${HOME}\\proj\\src\\a.ts`,
                displayPath: '~\\proj\\src\\a.ts',
                kind: 'edit',
                additions: 1,
                deletions: 0,
                diff: `--- ${HOME}\\proj\\src\\a.ts\n+++ ${HOME}\\proj\\src\\a.ts`
              }
            ],
            test: {
              passed: 0,
              failed: 1,
              skipped: 0,
              failures: [{ name: `${HOME}\\proj\\a.test.ts`, message: `在 ${HOME}\\proj 下失败` }]
            },
            raw: { cwd: `${HOME}\\proj`, nested: { file: `${HOME}\\proj\\src\\a.ts` } }
          })
        ]
      }),
      OPTIONS
    )

    const first = masked.events[0]!
    expect(first.fileChanges?.[0]?.diff).not.toContain('alice')
    expect(first.test?.failures[0]?.name).toBe('~\\proj\\a.test.ts')
    expect(first.test?.failures[0]?.message).toBe('在 ~\\proj 下失败')
    expect(JSON.stringify(first.raw)).not.toContain('alice')
  })
})

/*
 * 这一组是这个模块和 redact 的分界线：redact 挡的是密钥，密钥没人需要拿去
 * 定位文件，所以它连路径带内容一起打；这里只管"显示出来会暴露用户名"的文字，
 * 路径字段必须原封不动地送到界面。
 */
describe('路径字段绝不能动', () => {
  it('事件上用来定位文件的那几个字段保持原样', () => {
    const masked = maskSessionPaths(session(), OPTIONS)
    const first = masked.events[0]!

    expect(first.sourceFile).toBe(`${HOME}\\.codex\\a.jsonl`)
    expect(first.workingDirectory).toBe(`${HOME}\\proj`)
    expect(first.relatedFiles).toEqual([`${HOME}\\proj\\src\\a.ts`])
  })

  it('文件改动的 path 保持原样（差异文本已经处理过了）', () => {
    const masked = maskSessionPaths(
      session({
        events: [
          event({
            type: 'file_edit',
            fileChanges: [
              {
                path: `${HOME}\\proj\\src\\a.ts`,
                displayPath: '~\\proj\\src\\a.ts',
                kind: 'edit',
                additions: 1,
                deletions: 0
              }
            ]
          })
        ]
      }),
      OPTIONS
    )

    expect(masked.events[0]?.fileChanges?.[0]?.path).toBe(`${HOME}\\proj\\src\\a.ts`)
  })
})

describe('没有主目录信息时', () => {
  it('一个字都不改', () => {
    const original = session()
    const masked = maskSessionPaths(original, { homeDir: null, platform: 'win32' })

    expect(masked.title).toBe(original.title)
    expect(masked.events[0]?.content).toBe(original.events[0]?.content)
  })
})
