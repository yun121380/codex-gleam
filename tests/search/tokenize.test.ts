import { describe, expect, it } from 'vitest'
import { SEARCH_MAX_NUMERIC_LENGTH, SEARCH_MAX_TERM_LENGTH } from '../../src/shared/constants'
import { parseQuery, tokenize } from '../../src/main/search/tokenize'

describe('分词', () => {
  it('整词保留标识符与错误码', () => {
    expect(tokenize('rm 之后报 ENOENT')).toContain('enoent')
    expect(tokenize('error TS2345: 类型不匹配')).toContain('ts2345')
    expect(tokenize('删掉 node_modules 重装')).toContain('node_modules')
    // 反面：不能被下划线和数字切碎，否则搜 node 会把每一个装过依赖的会话都翻出来
    expect(tokenize('node_modules')).not.toContain('node')
    expect(tokenize('TS2345')).not.toContain('2345')
  })

  it('中文切成相邻 bigram', () => {
    expect(tokenize('离线自检')).toEqual(['离线', '线自', '自检'])
  })

  it('单字中文自己成词', () => {
    // 夹在英文里的一个字，不给它成词就彻底搜不到
    expect(tokenize('build 的 输出')).toContain('的')
  })

  it('中英混排在类别边界断词', () => {
    const terms = tokenize('修复ENOENT错误')
    expect(terms).toContain('enoent')
    expect(terms).toContain('修复')
    expect(terms).toContain('错误')
  })

  it('ASCII 统一小写，中文原样', () => {
    expect(tokenize('ENOENT')).toEqual(['enoent'])
    expect(tokenize('Café')).toEqual(['café'])
  })

  it('丢掉超长词条与超长纯数字，但留下短数字', () => {
    const hash = 'a'.repeat(SEARCH_MAX_TERM_LENGTH + 1)
    expect(tokenize(hash)).toEqual([])
    expect(tokenize('a'.repeat(SEARCH_MAX_TERM_LENGTH))).toHaveLength(1)

    expect(tokenize('1756382400000')).toEqual([])
    expect(tokenize('9'.repeat(SEARCH_MAX_NUMERIC_LENGTH))).toHaveLength(1)
    // 端口号与错误码得留着
    expect(tokenize('4004')).toEqual(['4004'])
  })

  it('长度规则只看长度，不看长得像不像密钥', () => {
    // 这条钉住"长度是体积规则不是安全规则"：一个短的密钥照样会进词条。
    // 它进不了索引靠的是 sessionText 里的无条件打码，而不是这里。
    expect(tokenize('sk-live-0OpQrStUvWxYz123456')).toContain('sk')
  })

  it('空串与纯标点返回空数组', () => {
    // 不能返回 ['']：空词条会成为一个匹配所有会话的条目
    expect(tokenize('')).toEqual([])
    expect(tokenize('  ，。！ ---  ')).toEqual([])
  })

  it('去重且保持出现顺序', () => {
    expect(tokenize('build build test')).toEqual(['build', 'test'])
  })
})

describe('查询解析', () => {
  it('没有引号时短语为 null', () => {
    expect(parseQuery('离线 自检')).toEqual({ terms: ['离线', '自检'], phrase: null })
  })

  it('直角引号与中文引号都认', () => {
    expect(parseQuery('"离线自检"').phrase).toBe('离线自检')
    expect(parseQuery('“离线自检”').phrase).toBe('离线自检')
  })

  it('引号里的词照样参与第一层求交集', () => {
    // 引号只是额外给第二层一个精确匹配的目标，不能让第一层少筛
    expect(parseQuery('"离线自检"').terms).toEqual(['离线', '线自', '自检'])
  })

  it('空引号当没打引号', () => {
    expect(parseQuery('""').phrase).toBeNull()
    expect(parseQuery('"   "').phrase).toBeNull()
  })
})
