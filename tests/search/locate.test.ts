import { describe, expect, it } from 'vitest'
import { collectSummaryTerms, collectTerms } from '../../src/main/search/invertedIndex'
import { locateHits } from '../../src/main/search/locate'
import { parseQuery } from '../../src/main/search/tokenize'
import { SEARCH_MAX_HITS_PER_SESSION, SEARCH_SNIPPET_LENGTH } from '../../src/shared/constants'
import type { CodexEvent, CodexSession, SearchHit } from '../../src/shared/types'

/**
 * 第二层：在一个会话里定位命中。
 *
 * 这份文件里最要紧的一条是「切回来」：把 `ranges` 的下标拿到 `snippet` 上取子串，
 * 得到的必须正好是命中的那个词。高亮偏一位在界面上长得跟对的一模一样 —— 用户只会
 * 觉得"这高亮怎么怪怪的"，不会报 bug，而下标一旦错了就是整条都错。所以几乎每条
 * 断言都顺手把 `highlighted()` 带上一遍。
 *
 * 全部用手搓的会话，不读 fixture：这一层的输入就是 `CodexSession`，用真文件反而要
 * 先猜解析器会把那段 JSONL 变成什么样，断言就不再说明这一层的行为。
 */

/**
 * 一条事件。只有 `patch` 里给到的字段有值。
 *
 * 空字符串字段不会产生 TextField（`sessionText.ts` 的 `field()` 对空值返回 null），
 * 所以默认 `title: ''` 意味着"这条事件的第一个字段是内容"。要测字段顺序就补上标题。
 */
function event(at: number, patch: Partial<CodexEvent>): CodexEvent {
  return {
    id: `e-${at}`,
    timestamp: null,
    type: 'assistant_message',
    title: '',
    content: '',
    sourceFile: 'C:\\x\\s.jsonl',
    workingDirectory: null,
    relatedFiles: [],
    displayWorkingDirectory: null,
    displayRelatedFiles: [],
    success: null,
    raw: null,
    ...patch
  }
}

/**
 * 一个会话。摘要字段填成固定值，事件按参数顺序排。
 *
 * `projectName: 'demo'` 是故意的：它是个只出现在摘要里的词，用来钉住"摘要字段不参与
 * 第二层定位"这件事。
 */
function sessionOf(...events: CodexEvent[]): CodexSession {
  return {
    id: 's-1',
    title: '会话标题',
    projectName: 'demo',
    projectPath: null,
    sourceFile: 'C:\\x\\s.jsonl',
    displaySourceFile: '~\\x\\s.jsonl',
    fileSizeBytes: 1,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    eventCount: events.length,
    userMessageCount: 0,
    assistantMessageCount: 0,
    commandCount: 0,
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
    usage: null,
    events
  }
}

/** 按用户实际打的字搜 —— 走一遍 `parseQuery`，和界面上那条路完全一致。 */
function find(session: CodexSession, query: string): SearchHit[] {
  return locateHits(session, parseQuery(query))
}

/**
 * 把每一段 `ranges` 在 `snippet` 上切出来。
 *
 * 这是"高亮偏一位"唯一一眼能看出来的形式：偏了就会切出 `NOENT:` 或者 `ENOEN`，
 * 而不是 `ENOENT`。
 */
function highlighted(hit: SearchHit): string[] {
  return hit.ranges.map(([from, to]) => hit.snippet.slice(from, to))
}

/** 掐掉两端省略号，只留片段本身的字。 */
function body(hit: SearchHit): string {
  return hit.snippet.replace(/^…/, '').replace(/…$/, '')
}

describe('命中落在哪个字段上', () => {
  it('正文里的词', () => {
    const session = sessionOf(event(1, { content: '装依赖时 node_modules 又坏了一次' }))
    const [hit] = find(session, 'node_modules')

    expect(hit).toBeDefined()
    expect(hit!.field).toBe('内容')
    expect(hit!.eventId).toBe('e-1')
    expect(hit!.eventType).toBe('assistant_message')
    expect(highlighted(hit!)).toEqual(['node_modules'])
  })

  it('命令里的词', () => {
    const session = sessionOf(
      event(1, { type: 'shell_command', title: '跑一遍自检', command: 'pnpm run verify' })
    )
    const [hit] = find(session, 'verify')

    // 标题在前面且非空，但里面没有这个词 —— 不该被它挡住。
    expect(hit!.field).toBe('命令')
    expect(highlighted(hit!)).toEqual(['verify'])
  })

  it('命令输出的标签是「输出」，不是「内容」', () => {
    const session = sessionOf(
      event(1, { type: 'command_output', content: 'ENOENT: 找不到 tsconfig.node.json', success: false })
    )
    const [hit] = find(session, 'enoent')

    expect(hit!.field).toBe('输出')
  })

  it('代码差异里的词', () => {
    const session = sessionOf(
      event(1, {
        type: 'file_edit',
        title: '调整超时',
        fileChanges: [
          {
            path: 'C:\\Users\\demo\\proj\\src\\index.ts',
            displayPath: '~\\proj\\src\\index.ts',
            kind: 'edit',
            diff: '-const timeout = 1\n+const timeout = 30000',
            additions: 1,
            deletions: 1
          }
        ]
      })
    )
    const [hit] = find(session, 'timeout')

    expect(hit!.field).toBe('代码差异')
    // 一次 diff 里出现两遍，两段区间各自切回一个完整的词。
    expect(highlighted(hit!)).toEqual(['timeout', 'timeout'])
  })

  it('多个字段都命中时只出第一个字段', () => {
    const session = sessionOf(
      event(1, { type: 'shell_command', title: '跑 verify', command: 'pnpm run verify' })
    )
    const hits = find(session, 'verify')

    // 一个事件在界面上是一行，出两个 hit 会让"命中 N 处"跟用户数出来的行数对不上。
    expect(hits).toHaveLength(1)
    expect(hits[0]!.field).toBe('标题')
  })

  it('摘要字段不参与定位', () => {
    // `demo` 是项目名，第一层的表里有它。但一个"命中在项目名上"的 hit 在时间线上
    // 没有对应位置，界面点不过去 —— 所以这一层压根不看摘要那几个字段。
    const session = sessionOf(event(1, { content: '正文里没有那个词' }))

    expect(find(session, 'demo')).toEqual([])
  })
})

describe('区间切回来正好是命中的词', () => {
  it('大小写不一致时切出来是原文的写法', () => {
    const session = sessionOf(event(1, { content: '报错 ENOENT: no such file' }))
    const [hit] = find(session, 'enoent')

    expect(highlighted(hit!)).toEqual(['ENOENT'])
  })

  it('两端都被截断时，省略号的长度已经算进偏移里', () => {
    const filler = 'abc def '.repeat(60)
    const session = sessionOf(event(1, { content: `${filler}ENOENT ${filler}` }))
    const [hit] = find(session, 'enoent')

    expect(hit!.snippet.startsWith('…')).toBe(true)
    expect(hit!.snippet.endsWith('…')).toBe(true)
    expect(body(hit!).length).toBeLessThanOrEqual(SEARCH_SNIPPET_LENGTH)
    // 少算省略号那一位，这里就会切出 `ENOEN`。
    expect(highlighted(hit!)).toEqual(['ENOENT'])
  })

  it('一个事件里两处命中合成一个 hit、两段区间', () => {
    const session = sessionOf(event(1, { content: 'ENOENT 之后重跑，还是 ENOENT' }))
    const hits = find(session, 'enoent')

    expect(hits).toHaveLength(1)
    expect(hits[0]!.ranges).toHaveLength(2)
    expect(highlighted(hits[0]!)).toEqual(['ENOENT', 'ENOENT'])
  })

  it('中文 bigram 首尾相扣的几段合成一段，切回来是整个查询', () => {
    const session = sessionOf(event(1, { content: '这一步在部署构建产物' }))
    // `部署构建` 切出 部署 / 署构 / 构建 三个 bigram，在原文里互相重叠。
    // 不合并就是三段互相交叉的区间，界面上画不出来。
    const [hit] = find(session, '部署构建')

    expect(hit!.ranges).toHaveLength(1)
    expect(highlighted(hit!)).toEqual(['部署构建'])
  })

  it('恰好首尾相接的两处不合并', () => {
    const session = sessionOf(event(1, { content: '这一步在部署构建产物' }))
    // 空格分开打的两个词：部署 落在 [0,2)、构建 落在 [2,4)，中间没有重叠。合掉的话
    // 切回来是一串跨了两个词的字，而"切回来等于命中的词"是这一层最要紧的性质。
    const [hit] = find(session, '部署 构建')

    expect(hit!.ranges).toHaveLength(2)
    expect(highlighted(hit!)).toEqual(['部署', '构建'])
  })

  it('片段两端不会切在 ASCII 词的中间', () => {
    const filler = 'node_modules '.repeat(60)
    const session = sessionOf(event(1, { content: `${filler}ENOENT ${filler}` }))
    const [hit] = find(session, 'enoent')

    // 残片长这样：`de_modules`、`node_modu`。用户会以为自己搜到了另一个东西，
    // 所以宁可少显示一个词。
    expect(body(hit!).trim().startsWith('node_modules')).toBe(true)
    expect(body(hit!).trim().endsWith('node_modules')).toBe(true)
    // 对齐挪动了片段起点，偏移得跟着挪。
    expect(highlighted(hit!)).toEqual(['ENOENT'])
  })

  it('短语比片段还长时，区间截到片段边界为止', () => {
    const phrase = 'sourcemap '.repeat(18).trim()
    const session = sessionOf(event(1, { content: `产物里 ${phrase} 残留` }))
    const [hit] = find(session, `"${phrase}"`)

    // 看不见的那一截不该被算进高亮 —— 越界的下标会让界面 slice 出一串空。
    expect(hit!.ranges[0]![1]).toBeLessThanOrEqual(hit!.snippet.length)
    expect(highlighted(hit!)).toEqual([phrase.slice(0, SEARCH_SNIPPET_LENGTH)])
  })
})

describe('引号短语', () => {
  it('只匹配整串，不匹配拆开的词', () => {
    const session = sessionOf(
      event(1, { content: '先 pnpm run verify 一遍' }),
      event(2, { content: 'verify 之前先 pnpm install' })
    )
    const hits = find(session, '"pnpm run verify"')

    // 第二个事件里 pnpm 和 verify 都在，但没连在一起 —— 用户加引号要的就是这个。
    expect(hits.map((hit) => hit.eventIndex)).toEqual([0])
    expect(highlighted(hits[0]!)).toEqual(['pnpm run verify'])
  })

  it('引号里的大小写照样不敏感', () => {
    const session = sessionOf(event(1, { content: '跑了 PNPM Run Verify 一遍' }))
    const [hit] = find(session, '"pnpm run verify"')

    expect(highlighted(hit!)).toEqual(['PNPM Run Verify'])
  })

  it('中文输入法打出的引号也认', () => {
    const session = sessionOf(event(1, { content: '这一步在部署构建产物' }))
    const [hit] = find(session, '“部署构建”')

    expect(highlighted(hit!)).toEqual(['部署构建'])
  })
})

describe('顺序与下标', () => {
  it('eventIndex 就是 session.events 的下标，顺序就是事件顺序', () => {
    const session = sessionOf(
      event(1, { content: '这条无关' }),
      event(2, { content: '这里有 ENOENT' }),
      event(3, { content: '这条也无关' }),
      event(4, { content: '这里也有 ENOENT' })
    )
    const hits = find(session, 'enoent')

    // 界面靠这个下标把时间线的游标挪过去，对不上就是"跳到了别的一行"。
    expect(hits.map((hit) => hit.eventIndex)).toEqual([1, 3])
    for (const hit of hits) {
      expect(session.events[hit.eventIndex]!.id).toBe(hit.eventId)
    }
  })

  it('命中太多时截到上限为止', () => {
    const many = Array.from({ length: SEARCH_MAX_HITS_PER_SESSION + 50 }, (_unused, at) =>
      event(at, { content: '又一次 ENOENT' })
    )
    const hits = find(sessionOf(...many), 'enoent')

    expect(hits).toHaveLength(SEARCH_MAX_HITS_PER_SESSION)
  })

  it('一个词都没有时给空数组', () => {
    const session = sessionOf(event(1, { content: '这里什么都没有' }))

    expect(find(session, 'sourcemap')).toEqual([])
    // 只有标点的查询切不出任何词条，也不该崩。
    expect(find(session, '???')).toEqual([])
  })
})

/*
 * 两层共用 `eventTextFields` 的可执行形式。将来谁给一层加了字段忘了另一层，下面这条
 * 会红 —— 而在界面上，那种错长成"搜索把这个会话列出来了，点进去写着命中 0 处"。
 */
describe('两层认的字段是同一套', () => {
  const session = sessionOf(
    event(1, { type: 'shell_command', title: '执行 pnpm verify', command: 'pnpm run verify' }),
    event(2, {
      type: 'command_output',
      content: 'ENOENT: 找不到 tsconfig.node.json',
      success: false
    }),
    event(3, {
      type: 'file_edit',
      title: '调整超时',
      content: '把超时从 1 秒改成 30 秒',
      fileChanges: [
        {
          path: 'C:\\Users\\demo\\proj\\src\\index.ts',
          displayPath: '~\\proj\\src\\index.ts',
          kind: 'edit',
          diff: '-const timeout = 1\n+const timeout = 30000',
          additions: 1,
          deletions: 1
        }
      ]
    }),
    event(4, {
      type: 'test_result',
      title: '测试结果',
      test: {
        passed: 3,
        failed: 1,
        skipped: 0,
        failures: [{ name: '片段不切碎 ASCII 词', message: 'expected sourcemap' }]
      }
    }),
    event(5, {
      type: 'tool_call',
      title: '调用工具',
      toolName: 'apply_patch',
      relatedFiles: ['C:\\Users\\demo\\proj\\src\\main.ts'],
      displayRelatedFiles: ['~\\proj\\src\\main.ts']
    })
  )

  /**
   * 事件贡献的词条 —— 摘要那几个（项目名、文件路径、会话 id）第二层是**故意**不搜的，
   * 拿整个 `collectTerms` 去断言会按设计失败。
   */
  const summaryTerms = collectSummaryTerms(session)
  const eventTerms = [...collectTerms(session)].filter((term) => !summaryTerms.has(term))

  it('第一层收到的每个 ASCII 词条，第二层都定位得到', () => {
    const ascii = eventTerms.filter((term) => /^[a-z0-9_]+$/.test(term))

    // 先确认这条测试真的在测东西：词条集合空了的话下面那句永远是绿的。
    expect(ascii.length).toBeGreaterThan(15)
    expect(ascii.filter((term) => find(session, term).length === 0)).toEqual([])
  })

  it('中文词条同样定位得到', () => {
    const cjk = eventTerms.filter((term) => /^[\u4e00-\u9fff]+$/.test(term))

    expect(cjk.length).toBeGreaterThan(5)
    expect(cjk.filter((term) => find(session, term).length === 0)).toEqual([])
  })
})
