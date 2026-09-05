/**
 * 这一期的关键断言：**往 fixture 里放一个 `sk-` 形态的伪造密钥，断言它在索引里
 * 搜不到。**
 *
 * 这是"索引只建在打码之后的文本上"那个设计决定的可执行形式。它值得单独一个文件：
 * 别的测试挂了是功能不对，这个挂了是把用户的密钥写进了磁盘上的一张表。
 */
import { describe, expect, it } from 'vitest'
import {
  collectTerms,
  emptyIndex,
  mergeIndex,
  queryIndex
} from '../../src/main/search/invertedIndex'
import { parseQuery } from '../../src/main/search/tokenize'
import type { SearchIndexFile } from '../../src/shared/types'
import { loadFixture, testFixturePath } from '../support/fixtures'

/**
 * fixture 里那个伪造密钥。
 *
 * 本体 19 字符，**刻意短于 `SEARCH_MAX_TERM_LENGTH`（48）**：如果拿一个 60 字符的
 * 假密钥来测，它会因为"词太长被分词丢掉"而让测试通过——那是错误的理由，改天
 * 有人把打码去掉，测试照样绿。
 */
const FAKE_KEY = 'sk-live-0OpQrStUvWxYz123456'
const KEY_BODY = '0opqrstuvwxyz123456'

async function buildIndex(): Promise<{ index: SearchIndexFile; sessionId: string }> {
  const { sessions } = await loadFixture(testFixturePath('search-secret.jsonl'))
  const session = sessions[0]
  if (!session) throw new Error('fixture 没有解析出会话')

  const index = mergeIndex({
    previous: emptyIndex(),
    removed: new Set<string>(),
    added: new Map([[session.id, collectTerms(session)]]),
    builtAt: '2026-09-01T08:30:00.000Z'
  })
  return { index, sessionId: session.id }
}

describe('密钥不进索引', () => {
  it('拿密钥本体去搜，搜不到任何会话', async () => {
    // 最锋利的一条：密钥本体是一串独一无二的字符，它在表里就是泄漏，不在就是没泄漏，
    // 跟这台机器上仓库放在哪个目录、路径里有什么词都无关。
    const { index } = await buildIndex()
    const result = queryIndex(index, parseQuery(KEY_BODY))
    expect(result.sessionIds).toEqual([])
    // 不是"命中了但结果为空"，是"这个词表里根本没有"——界面据此说清原因。
    expect(result.unmatched).toEqual([KEY_BODY])
  })

  it('拿整个密钥去搜，搜不到任何会话', async () => {
    // 用户真会做的事：把整串粘进搜索框。`sk-live-…` 会被切成 sk / live / 本体三个词，
    // 一个都不该在表里 —— 早先 `sk` 曾经子串命中过路径里的 `desktop`，
    // 那次误召回就是 SEARCH_MIN_SUBSTRING_LENGTH 的来由。
    const { index } = await buildIndex()
    expect(queryIndex(index, parseQuery(FAKE_KEY)).sessionIds).toEqual([])
  })

  it('表里没有任何词条包含密钥本体', async () => {
    const { index } = await buildIndex()
    const leaked = Object.keys(index.terms).filter((term) => term.includes(KEY_BODY))
    expect(leaked).toEqual([])
  })

  it('整份落盘 JSON 里也搜不到密钥本体', async () => {
    // 上一条只看了词条本身；这一条把会话 id、建成时间、所有 postings 一起兜住，
    // 免得哪天有人往表里加个"原文片段"字段又把密钥带回来。
    const { index } = await buildIndex()
    expect(JSON.stringify(index).toLowerCase()).not.toContain(KEY_BODY)
  })

  it('同一个会话里的普通词照样搜得到', async () => {
    // 反面对照：没有这一条，一个"什么都不进索引"的实现也能让上面三条全绿。
    const { index, sessionId } = await buildIndex()
    expect(queryIndex(index, parseQuery('部署')).sessionIds).toEqual([sessionId])
  })

  it('打码占位符进了表，说明文本是被打码而不是被整段丢掉', async () => {
    // `[已打码]` 切出 `已打` / `打码` 两个 bigram。它在表里，就证明这段文本确实
    // 走过 redactText —— 而不是因为某个字段压根没进索引才"看起来安全"。
    const { index } = await buildIndex()
    expect(index.terms).toHaveProperty('打码')
  })
})
