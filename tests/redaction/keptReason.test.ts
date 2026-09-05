/**
 * 「为什么没打码」这两个函数与原有判定之间的蕴含关系。
 *
 * 这个文件的重点不是逐条对答案，而是钉住一件事：**说得出排除原因 ⇒ 确实没打码**。
 *
 * keyKeptReason / valueKeptReason 是 isSensitiveKey / shouldMaskValue 旁边的兄弟，
 * 不是它们的重写 —— 两边将来各自漂一点是必然的，而漂出来的症状是面板开始解释一件
 * 没发生的事：「author 被判为不是密钥」，而那个值其实被打掉了。那种错比不做这个
 * 面板更糟，所以它得先在 CI 上红。
 */
import { describe, expect, it } from 'vitest'
import {
  isSensitiveKey,
  keyKeptReason,
  shouldMaskValue,
  valueKeptReason
} from '../../src/main/redaction/patterns'

/**
 * 一张混着各类情况的表：真敏感的、沾了词的、计数的、完全无关的。
 *
 * 蕴含关系对**每一项**都必须成立，所以这里要的是覆盖面而不是精确答案 ——
 * 具体某一项该得什么原因，由下面「设计文档点名的例子」那组负责。
 */
const KEYS: readonly string[] = [
  'api_key',
  'apiKey',
  'access_token',
  'Authorization',
  'Set-Cookie',
  'private_key',
  'author',
  'authority',
  'keyboard',
  'keywords',
  'input_tokens',
  'total_tokens',
  'token_count',
  'monkey',
  'turkey',
  'content',
  'timestamp',
  'id',
  'projectName',
  ''
]

const VALUES: readonly string[] = [
  'sk-live-0OpQrStUvWxYz123456',
  'my secret phrase',
  'str',
  'a',
  '',
  '<your-key>',
  '{{TOKEN}}',
  '[REDACTED]',
  '(none)',
  'true',
  'false',
  'null',
  '0',
  '1280',
  'n/a',
  '---',
  '[已打码]',
  '[已打码',
  '  [已打码]  '
]

describe('排除原因与原有判定的蕴含关系', () => {
  it('说得出键名的排除原因，就一定没被判为敏感键名', () => {
    for (const key of KEYS) {
      const reason = keyKeptReason(key)
      if (reason !== null) {
        expect(isSensitiveKey(key), `${key} → ${reason}`).toBe(false)
      }
    }
  })

  it('说得出值的排除原因，就一定不会被打码', () => {
    for (const value of VALUES) {
      const reason = valueKeptReason(value)
      if (reason !== null) {
        expect(shouldMaskValue(value), `${value} → ${reason}`).toBe(false)
      }
    }
  })

  it('真敏感的键名不给原因 —— 那是命中，不是排除', () => {
    for (const key of ['api_key', 'apiKey', 'access_token', 'Authorization', 'private_key']) {
      expect(isSensitiveKey(key), key).toBe(true)
      expect(keyKeptReason(key), key).toBeNull()
    }
  })

  it('该打码的值不给原因', () => {
    for (const value of ['sk-live-0OpQrStUvWxYz123456', 'my secret phrase']) {
      expect(shouldMaskValue(value), value).toBe(true)
      expect(valueKeptReason(value), value).toBeNull()
    }
  })

  it('跟敏感词毫无关系的键名不进这份报告', () => {
    // 报出来会把面板灌满，而它们根本不是「被排除的敏感键名」。
    for (const key of ['content', 'timestamp', 'id', 'projectName', '']) {
      expect(keyKeptReason(key), key).toBeNull()
    }
  })

  it('已经打过码的值不算排除', () => {
    // 第 5 个阶段看到的 `Authorization: [已打码]` 是第 3 个阶段刚打的。
    // 把它报成「被判为不是密钥」是把事实说反 —— 哪怕截了一半也一样。
    for (const value of ['[已打码]', '[已打码', '  [已打码]  ']) {
      expect(valueKeptReason(value), value).toBeNull()
    }
  })
})

describe('设计文档点名的例子', () => {
  it('author 里的 auth 是词形不符', () => {
    expect(keyKeptReason('author')).toBe('name-not-matched')
  })

  it('keyboard 是配置项', () => {
    expect(keyKeptReason('keyboard')).toBe('metric-name')
  })

  it('input_tokens 是用量计数', () => {
    expect(keyKeptReason('input_tokens')).toBe('metric-name')
  })

  it('源码里的 password: str，str 是类型名不是密码', () => {
    expect(valueKeptReason('str')).toBe('value-too-short')
  })
})

describe('五种原因各有出处', () => {
  it('模板变量与占位符', () => {
    expect(valueKeptReason('<your-key>')).toBe('value-is-template')
    expect(valueKeptReason('{{TOKEN}}')).toBe('value-is-template')
  })

  it('开关与计数', () => {
    expect(valueKeptReason('true')).toBe('value-not-secret')
    expect(valueKeptReason('null')).toBe('value-not-secret')
    expect(valueKeptReason('1280')).toBe('value-not-secret')
  })

  it('短数字先撞上长度下限 —— 报的是真正生效的那一条', () => {
    // `128` 只有 3 个字符，shouldMaskValue 在看它是不是数字之前就已经返回 false 了。
    // 报 value-not-secret 会指向一条没跑到的判断，这份报告就不可反驳了。
    expect(valueKeptReason('128')).toBe('value-too-short')
  })

  it('短到不可能是密钥', () => {
    expect(valueKeptReason('a')).toBe('value-too-short')
    expect(valueKeptReason('')).toBe('value-too-short')
  })
})
