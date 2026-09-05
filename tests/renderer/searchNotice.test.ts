import { describe, expect, it } from 'vitest'
import { describeSearch, echoableTerms, shouldSearchFullText } from '../../src/renderer/lib/searchNotice'
import type { SearchResponse } from '../../src/shared/types'

/**
 * 搜索框下面那一行字。
 *
 * 这一行是整期"没有数据就说没有"的落点：降级时它必须让人知道**这次没搜全文**，
 * 而不是"库里没有这个词"——两种情况下用户该做的事完全不同（重新扫描 vs 换个词）。
 * 所以这里的断言盯的是措辞里那几个关键的字，不是"有没有返回字符串"。
 */
function response(patch: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: 'enoent',
    terms: ['enoent'],
    unmatched: [],
    sessionIds: ['a', 'b', 'c'],
    hits: [],
    degraded: false,
    notice: null,
    ...patch
  }
}

describe('要不要发这次全文查询', () => {
  it('空串与纯空白不发', () => {
    expect(shouldSearchFullText('')).toBe(false)
    expect(shouldSearchFullText('   ')).toBe(false)
  })

  it('一个 ASCII 字符不发，两个就发', () => {
    // 一个字母会前缀扩展出成百上千个词条，返回几乎整个库。
    expect(shouldSearchFullText('a')).toBe(false)
    expect(shouldSearchFullText('ab')).toBe(true)
  })

  it('一个汉字就发', () => {
    expect(shouldSearchFullText('的')).toBe(true)
    // 两端的空白不算长度。
    expect(shouldSearchFullText(' 部 ')).toBe(true)
  })

  it('中英混着打时按中文那条线算', () => {
    expect(shouldSearchFullText('a的')).toBe(true)
  })
})

describe('哪些没命中的词能念给用户听', () => {
  it('中文连写的一整串里，一个 bigram 都不念', () => {
    // `部署构建` 切出 部署 / 署构 / 构建。用户眼里这是一个词，念其中任何两个字
    // 都会让人以为自己打错了——`署构` 尤其明显，那两个字压根不挨着。
    expect(echoableTerms('部署构建', ['署构'])).toEqual([])
    expect(echoableTerms('部署构建', ['部署', '署构'])).toEqual([])
  })

  it('用户自己用空格分开的那个词要念', () => {
    // 分开打就说明用户认得这两个词，此时词条与用户打的那一段一模一样。
    expect(echoableTerms('部署 构建', ['构建'])).toEqual(['构建'])
  })

  it('标点也算分隔符', () => {
    expect(echoableTerms('报错：sourcemap', ['sourcemap'])).toEqual(['sourcemap'])
  })

  it('大小写不一致照样算打过', () => {
    // 词条已经折成小写，用户打的可能是 ENOENT。
    expect(echoableTerms('报错 ENOENT', ['enoent'])).toEqual(['enoent'])
  })
})

describe('那一行话', () => {
  it('还没搜过时这一行不显示', () => {
    expect(describeSearch(null)).toBeNull()
  })

  it('正常情况报候选会话数', () => {
    expect(describeSearch(response())).toBe('全文命中 3 个会话')
  })

  it('降级时只说降级，绝不报数字', () => {
    // 只搜了标题的"命中 N 个会话"会被当成全文结果——那是这一行最该避免的误解。
    const line = describeSearch(
      response({ degraded: true, notice: '全文索引已关闭，这次只搜了标题。', sessionIds: ['a'] })
    )

    expect(line).toBe('全文索引已关闭，这次只搜了标题。')
    expect(line).not.toContain('全文命中')
  })

  it('丢过词时把主进程那句话接在后面', () => {
    // 丢了多少个词只有主进程知道，界面不重算。
    expect(describeSearch(response({ notice: '索引超出体积上限，丢掉了 7 个高频词，结果可能不全。' }))).toBe(
      '全文命中 3 个会话；索引超出体积上限，丢掉了 7 个高频词，结果可能不全。'
    )
  })

  it('有词没进索引时补一句', () => {
    expect(describeSearch(response({ query: 'enoent sourcemap', unmatched: ['sourcemap'] }))).toBe(
      '全文命中 3 个会话；「sourcemap」没有出现在索引里'
    )
  })

  it('降级时也照样念没进索引的词', () => {
    const line = describeSearch(
      response({
        query: 'enoent sourcemap',
        unmatched: ['sourcemap'],
        degraded: true,
        notice: '还没有全文索引（或索引已损坏），这次只搜了标题。重新扫描一次就能建好。'
      })
    )

    expect(line).toContain('只搜了标题')
    expect(line).toContain('「sourcemap」没有出现在索引里')
  })
})
