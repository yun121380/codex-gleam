import { describe, expect, it } from 'vitest'
import {
  ancestorDirs,
  loadThreadTitles,
  lookupThreadTitle,
  sessionIdsFromFileName,
  type ThreadTitles
} from '../../src/main/scanner/threadTitles'
import { createFakeFs } from '../support/fakeFs'

const INDEX = [
  '{"id":"01a04d76-bd47-7442-8c98-addbed920f33","thread_name":"构思 Codex 生态助力项目","updated_at":"2026-08-29T12:20:22Z"}',
  '{"id":"01a045c5-0fe8-7c40-a3a1-87b99e5bf57e","thread_name":"评价 github 项目","updated_at":"2026-08-28T00:28:57Z"}',
  // 名字为空的条目要跳过，否则会覆盖掉本可以猜出来的标题。
  '{"id":"01a00d26-c328-7ce3-a896-da0b1fe155d7","thread_name":"   "}',
  '这一行不是 JSON，必须被安静跳过',
  '{"没有 id 也没有名字":true}',
  ''
].join('\n')

const CODEX_HOME = 'C:\\Users\\demo\\.codex'

function fsWithIndex(): ReturnType<typeof createFakeFs> {
  return createFakeFs({ [`${CODEX_HOME}\\session_index.jsonl`]: INDEX })
}

describe('读取 Codex 的会话名索引', () => {
  it('把 id 映射到 Codex 自己起的名字', async () => {
    const titles = await loadThreadTitles({ fs: fsWithIndex(), roots: [CODEX_HOME] })

    expect(titles.get('01a04d76-bd47-7442-8c98-addbed920f33')).toBe('构思 Codex 生态助力项目')
    expect(titles.get('01a045c5-0fe8-7c40-a3a1-87b99e5bf57e')).toBe('评价 github 项目')
  })

  it('坏行、空名字、缺字段都跳过，不影响其余条目', async () => {
    const titles = await loadThreadTitles({ fs: fsWithIndex(), roots: [CODEX_HOME] })

    expect(titles.size).toBe(2)
    expect(titles.has('01a00d26-c328-7ce3-a896-da0b1fe155d7')).toBe(false)
  })

  it('目录里没有索引时返回空表，而不是抛错', async () => {
    const fs = createFakeFs({ 'C:\\somewhere\\else.txt': 'x' })
    const titles = await loadThreadTitles({ fs, roots: ['C:\\somewhere', ''] })

    expect(titles.size).toBe(0)
  })

  it('多个目录各有索引时合并', async () => {
    const fs = createFakeFs({
      [`${CODEX_HOME}\\session_index.jsonl`]: INDEX,
      'C:\\Users\\demo\\.config\\codex\\session_index.jsonl':
        '{"id":"aaaaaaaa-0000-0000-0000-000000000000","thread_name":"另一个目录里的会话"}'
    })
    const titles = await loadThreadTitles({
      fs,
      roots: [CODEX_HOME, 'C:\\Users\\demo\\.config\\codex']
    })

    expect(titles.size).toBe(3)
    expect(titles.get('aaaaaaaa-0000-0000-0000-000000000000')).toBe('另一个目录里的会话')
  })
})

describe('从文件名认出会话 id', () => {
  it('取出滚动日志文件名里的所有 uuid', () => {
    expect(
      sessionIdsFromFileName('rollout-2026-08-29T20-20-22-01a04d76-bd47-7442-8c98-addbed920f33.jsonl')
    ).toEqual(['01a04d76-bd47-7442-8c98-addbed920f33'])
  })

  it('续写日志带两个 uuid 时都返回，按出现顺序', () => {
    const ids = sessionIdsFromFileName(
      'rollout-2026-08-29T20-34-56-01a04d76-bd47-7442-8c98-addbed920f33_01a04d84-1289-75e3-b68b-c750f2baff57.jsonl'
    )
    expect(ids).toEqual([
      '01a04d76-bd47-7442-8c98-addbed920f33',
      '01a04d84-1289-75e3-b68b-c750f2baff57'
    ])
  })

  it('没有 uuid 的文件名返回空数组', () => {
    expect(sessionIdsFromFileName('session.jsonl')).toEqual([])
  })
})

describe('查会话名', () => {
  const titles: ThreadTitles = new Map([
    ['01a04d76-bd47-7442-8c98-addbed920f33', '构思 Codex 生态助力项目']
  ])

  it('优先用会话 id 查（大小写不敏感）', () => {
    expect(
      lookupThreadTitle(titles, { sessionId: '01A04D76-BD47-7442-8C98-ADDBED920F33' })
    ).toBe('构思 Codex 生态助力项目')
  })

  it('会话 id 查不到时退回文件名里的 uuid', () => {
    expect(
      lookupThreadTitle(titles, {
        sessionId: 'session-1',
        fileName: 'rollout-2026-08-29T20-34-56-01a04d76-bd47-7442-8c98-addbed920f33_01a04d84-1289-75e3-b68b-c750f2baff57.jsonl'
      })
    ).toBe('构思 Codex 生态助力项目')
  })

  it('都查不到时返回 null，让调用方去猜标题', () => {
    expect(lookupThreadTitle(titles, { sessionId: '未知', fileName: 'a.jsonl' })).toBeNull()
    expect(lookupThreadTitle(new Map(), { sessionId: '01a04d76-bd47-7442-8c98-addbed920f33' })).toBeNull()
  })
})

describe('往上找放着索引的目录', () => {
  it('从会话文件一路列出上级目录', () => {
    expect(
      ancestorDirs('C:\\Users\\demo\\.codex\\sessions\\2026\\08\\29\\rollout-x.jsonl')
    ).toEqual([
      'C:\\Users\\demo\\.codex\\sessions\\2026\\08\\29',
      'C:\\Users\\demo\\.codex\\sessions\\2026\\08',
      'C:\\Users\\demo\\.codex\\sessions\\2026',
      'C:\\Users\\demo\\.codex\\sessions',
      'C:\\Users\\demo\\.codex',
      'C:\\Users\\demo',
      'C:\\Users',
      // 盘符本身也会被试一次：多一次注定失败的 open 而已，比漏掉根目录安全。
      'C:'
    ])
  })

  it('posix 路径同样适用', () => {
    expect(ancestorDirs('/home/demo/.codex/sessions/a.jsonl')).toEqual([
      '/home/demo/.codex/sessions',
      '/home/demo/.codex',
      '/home/demo',
      '/home'
    ])
  })
})
