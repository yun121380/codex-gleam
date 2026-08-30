import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'
import {
  coerceTimestamp,
  confidenceFromScore,
  flattenTextContent,
  hasAllowedExtension,
  isIgnoredDirName,
  normalizeSettings,
  safeJsonParse
} from '../../src/shared/validators'

describe('时间戳归一化', () => {
  it('ISO 字符串原样转成 ISO', () => {
    expect(coerceTimestamp('2026-08-24T09:12:03.120Z')).toBe('2026-08-24T09:12:03.120Z')
  })

  it('毫秒与秒级时间戳都能识别', () => {
    const ms = Date.UTC(2026, 7, 24, 9, 12, 3)
    expect(coerceTimestamp(ms)).toBe(new Date(ms).toISOString())
    expect(coerceTimestamp(Math.floor(ms / 1000))).toBe(new Date(ms).toISOString())
  })

  it('数字字符串也能识别', () => {
    expect(coerceTimestamp('1787000000')).toBe(new Date(1787000000 * 1000).toISOString())
  })

  it('Date 对象可以直接传入', () => {
    const date = new Date('2026-08-24T09:00:00.000Z')
    expect(coerceTimestamp(date)).toBe('2026-08-24T09:00:00.000Z')
  })

  it('无法识别的值返回 null，而不是 1970 年', () => {
    expect(coerceTimestamp(null)).toBeNull()
    expect(coerceTimestamp(undefined)).toBeNull()
    expect(coerceTimestamp('')).toBeNull()
    expect(coerceTimestamp('   ')).toBeNull()
    expect(coerceTimestamp('明天下午')).toBeNull()
    expect(coerceTimestamp(0)).toBeNull()
    expect(coerceTimestamp(Number.NaN)).toBeNull()
    expect(coerceTimestamp({})).toBeNull()
  })
})

describe('文本内容压平', () => {
  it('字符串原样返回', () => {
    expect(flattenTextContent('hello')).toBe('hello')
  })

  it('OpenAI 风格的内容数组被拼起来', () => {
    expect(
      flattenTextContent([
        { type: 'input_text', text: '第一段' },
        { type: 'input_text', text: '第二段' }
      ])
    ).toBe('第一段\n第二段')
  })

  it('嵌套的 content 字段会被递归取出', () => {
    expect(flattenTextContent({ content: [{ text: '深处的文字' }] })).toBe('深处的文字')
  })

  it('多种字段名都能命中', () => {
    expect(flattenTextContent({ message: '消息' })).toBe('消息')
    expect(flattenTextContent({ stdout: '输出' })).toBe('输出')
    expect(flattenTextContent({ summary: [{ type: 'summary_text', text: '摘要' }] })).toBe('摘要')
  })

  it('找不到文本时返回空字符串而不是抛错', () => {
    expect(flattenTextContent({ unrelated: 1 })).toBe('')
    expect(flattenTextContent(null)).toBe('')
    expect(flattenTextContent(undefined)).toBe('')
  })

  it('自引用结构不会导致死循环', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.content = cyclic
    expect(() => flattenTextContent(cyclic)).not.toThrow()
  })
})

describe('扫描规则辅助函数', () => {
  it('忽略目录判断不区分大小写', () => {
    for (const name of ['node_modules', 'NODE_MODULES', '.git', 'dist', 'Build', 'cache', 'Temp', 'LOGS']) {
      expect(isIgnoredDirName(name), name).toBe(true)
    }
    expect(isIgnoredDirName('sessions')).toBe(false)
    expect(isIgnoredDirName('my-logs-folder')).toBe(false)
  })

  it('只接受 .json 与 .jsonl', () => {
    expect(hasAllowedExtension('a.json')).toBe(true)
    expect(hasAllowedExtension('a.JSONL')).toBe(true)
    expect(hasAllowedExtension('a.txt')).toBe(false)
    expect(hasAllowedExtension('a.json.gz')).toBe(false)
    expect(hasAllowedExtension('json')).toBe(false)
  })

  it('可信度分级', () => {
    expect(confidenceFromScore(0.95)).toBe('high')
    expect(confidenceFromScore(0.7)).toBe('high')
    expect(confidenceFromScore(0.5)).toBe('medium')
    expect(confidenceFromScore(0.2)).toBe('low')
  })
})

describe('设置修正', () => {
  it('完全无效的输入退回默认设置', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('坏数据')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(123)).toEqual(DEFAULT_SETTINGS)
  })

  it('数值被夹在合理范围内', () => {
    const settings = normalizeSettings({
      maxDepth: 999,
      maxFileSizeMb: -5,
      confidenceThreshold: 4,
      playbackIntervalMs: 1
    })

    expect(settings.maxDepth).toBe(20)
    expect(settings.maxFileSizeMb).toBe(1)
    expect(settings.confidenceThreshold).toBe(1)
    expect(settings.playbackIntervalMs).toBe(200)
  })

  it('目录列表去重并丢掉空值', () => {
    const settings = normalizeSettings({
      extraScanDirs: ['D:\\a', 'D:\\a', '', '   ', null, 42, 'D:\\b']
    })

    expect(settings.extraScanDirs).toEqual(['D:\\a', '42', 'D:\\b'])
  })

  it('主题只接受 dark 与 light', () => {
    expect(normalizeSettings({ theme: 'light' }).theme).toBe('light')
    expect(normalizeSettings({ theme: 'rainbow' }).theme).toBe('dark')
  })

  it('布尔开关缺失时使用默认值', () => {
    const settings = normalizeSettings({ redactSensitive: undefined })
    expect(settings.redactSensitive).toBe(true)
    expect(normalizeSettings({ redactSensitive: false }).redactSensitive).toBe(false)
  })

  it('旧版本缺少的字段会被补上', () => {
    const settings = normalizeSettings({ maxDepth: 4 })
    expect(settings).toHaveProperty('hiddenSessionIds')
    expect(settings.hiddenSessionIds).toEqual([])
  })
})

describe('安全 JSON 解析', () => {
  it('成功时返回值', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('失败时返回错误说明而不是抛异常', () => {
    const result = safeJsonParse('{oops')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toBe('')
  })
})
