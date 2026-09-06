/**
 * 打分模块的行为契约。
 *
 * 这个文件里的每个数字都是钉死的。理由不是「测试要精确」，而是这一段的验收条件
 * 写着「排序稳定且可复现」—— 一份允许分数漂移的测试证明不了这句话。
 *
 * 四组：分词的边界（什么进不来）、熵、形态判定、打分的单调性与基准值。
 */
import { describe, expect, it } from 'vitest'
import {
  charClasses,
  detectShape,
  lookBehind,
  scoreResidual,
  shannonEntropy,
  shapePenalty,
  tokenize
} from '../../src/main/redaction/residual'
import { REDACTION_PLACEHOLDER, REDACTION_RESIDUAL_MIN_LENGTH } from '../../src/shared/constants'
import type { ResidualShape } from '../../src/shared/types'

/** 一段真实的 PNG data URI 载荷，96 字符。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/**
 * 十种形态各一个样例。
 *
 * 写成 `Record<ResidualShape, …>` 而不是数组：将来联合类型加了第十一种形态，这里
 * 立刻在 typecheck 里红，不用靠谁记得回来补一条。
 */
const SHAPE_SAMPLES: Record<ResidualShape, { token: string; before: string }> = {
  'git-sha': { token: 'a3f5c9e1b7d24086fa1c5e93b028d7461f5a9c2e', before: 'commit ' },
  'integrity-hash': { token: `sha512-${PNG_BASE64}`, before: '"integrity": "' },
  uuid: { token: '9f8e7d6c-5b4a-3928-1706-fedcba987654', before: 'request ' },
  path: { token: '/home/demo/project/src/main/redaction/residual.ts', before: 'read ' },
  numeric: { token: '1757030400000.1757030401234', before: 'at ' },
  'lower-words': { token: 'eslint-plugin-react-hooks-extra-rules', before: 'require ' },
  'dotted-name': { token: 'document.documentElement.dataset.theme', before: 'const t = ' },
  'call-id': { token: 'call_7Kq2mZr9vT4wPbN8sXyLd3', before: '"call_id": "' },
  'data-uri': { token: PNG_BASE64, before: 'data:image/png;base64,' },
  'long-blob': { token: PNG_BASE64.repeat(6), before: 'blob=' }
}

/** 十个系数，全部严格落在 (0, 1) 开区间。乘 0 就等于删除，那不是降权。 */
const SHAPE_PENALTIES: Record<ResidualShape, number> = {
  'data-uri': 0.05,
  numeric: 0.05,
  'call-id': 0.05,
  'integrity-hash': 0.1,
  'lower-words': 0.1,
  'dotted-name': 0.1,
  'long-blob': 0.1,
  uuid: 0.15,
  'git-sha': 0.2,
  path: 0.2
}

const ALL_SHAPES = Object.keys(SHAPE_SAMPLES) as ResidualShape[]

/** 20 个互不相同的字符、大小写数字混排，不落任何已知形态。 */
const SHAPELESS_20 = 'Kq7mZr2vT9wPbN4sXyLd'

describe('tokenize', () => {
  it(`少一个字符就落榜，正好 ${REDACTION_RESIDUAL_MIN_LENGTH} 个就入选`, () => {
    const short = 'abcdefghijklmnopqrs'
    expect(short).toHaveLength(REDACTION_RESIDUAL_MIN_LENGTH - 1)
    expect(tokenize(short)).toEqual([])

    const exact = `${short}t`
    expect(exact).toHaveLength(REDACTION_RESIDUAL_MIN_LENGTH)
    expect(tokenize(exact)).toEqual([{ text: exact, at: 0 }])
  })

  it('中日韩文字永远不会成词，多长都不会', () => {
    const cjk = '这是一段足够长的中文正文，按字节算它的熵很高，但它一个候选片段都产生不了。'
    expect(cjk.length).toBeGreaterThan(REDACTION_RESIDUAL_MIN_LENGTH)
    expect(tokenize(cjk)).toEqual([])
  })

  it('占位符自己不成词，也不会把它两边的文本粘成一个词', () => {
    const left = 'AAAAAAAAAAAAAAAAAAAA'
    const right = 'BBBBBBBBBBBBBBBBBBBB'
    const tokens = tokenize(`${left}${REDACTION_PLACEHOLDER}${right}`)

    expect(tokens.map((token) => token.text)).toEqual([left, right])
    for (const token of tokens) {
      expect(token.text).not.toContain(REDACTION_PLACEHOLDER)
    }
  })

  it('Windows 路径被反斜杠切碎，一个片段都不剩', () => {
    expect(tokenize('C:\\Users\\demo\\project\\src\\main.ts')).toEqual([])
  })

  it('POSIX 路径作为一个整词进来，随后吃 path 的降权', () => {
    const posix = '/home/demo/project/src/main.ts'
    expect(tokenize(posix)).toEqual([{ text: posix, at: 0 }])
    expect(detectShape(posix, '')).toBe('path')
  })

  it('at 是原文里的下标，lookBehind 靠它取到前面那一小段', () => {
    const text = `data:image/png;base64,${PNG_BASE64}`
    const tokens = tokenize(text)
    const payload = tokens.find((token) => token.text === PNG_BASE64)

    expect(payload).toBeDefined()
    expect(lookBehind(text, payload?.at ?? 0).endsWith('base64,')).toBe(true)
  })
})

describe('shannonEntropy', () => {
  it('空串和全同字符都是 0', () => {
    expect(shannonEntropy('')).toBe(0)
    expect(shannonEntropy('aaaaaaaaaaaaaaaaaaaa')).toBe(0)
  })

  it('十六个字符各出现一次，正好 4 比特/字符', () => {
    expect(shannonEntropy('0123456789abcdef')).toBeCloseTo(4, 10)
  })

  it('纯十六进制远低于混排密钥 —— 这就是它们分数差五倍的来源', () => {
    const hex = shannonEntropy('a3f5c9e1b7d24086fa1c5e93b028d7461f5a9c2e')
    const mixed = shannonEntropy(SHAPELESS_20)
    expect(hex).toBeLessThan(mixed)
  })
})

describe('charClasses', () => {
  it('四类各自数得出来', () => {
    expect(charClasses('abcdefghij')).toBe(1)
    expect(charClasses('abcdEFGHij')).toBe(2)
    expect(charClasses('abcdEFGH12')).toBe(3)
    expect(charClasses('abcdEFGH12-')).toBe(4)
  })
})

describe('detectShape', () => {
  it.each(ALL_SHAPES)('认得出 %s', (shape) => {
    const sample = SHAPE_SAMPLES[shape]
    expect(detectShape(sample.token, sample.before)).toBe(shape)
  })

  it('前面紧挨着 base64, 时优先认成 data-uri，压过它本来的形态', () => {
    const hex = SHAPE_SAMPLES['git-sha'].token
    expect(detectShape(hex, 'commit ')).toBe('git-sha')
    expect(detectShape(hex, 'data:image/png;base64,')).toBe('data-uri')
  })

  it('带 + 或 = 的 base64 不会被当成路径，哪怕它凑出了几个斜杠', () => {
    const blob = 'ab+cd/ef=gh/ij+kl/mn=op/qr'
    expect(detectShape(blob, '')).toBeNull()
  })

  it('不落任何形态时返回 null，也就是不降权', () => {
    expect(detectShape(SHAPELESS_20, '')).toBeNull()
  })
})

describe('shapePenalty', () => {
  it('null 是 1：没认出形态就不降权', () => {
    expect(shapePenalty(null)).toBe(1)
  })

  it.each(ALL_SHAPES)('%s 的系数严格落在 (0, 1) 里', (shape) => {
    const penalty = shapePenalty(shape)
    expect(penalty).toBe(SHAPE_PENALTIES[shape])
    expect(penalty).toBeGreaterThan(0)
    expect(penalty).toBeLessThan(1)
  })
})

describe('scoreResidual', () => {
  /**
   * 钉死的基准值。
   *
   * 这一组是这个模块的全部价值：真密钥 63—79 分，十类噪音 2—13 分，中间隔着五倍。
   * 哪天有人调了权重或系数，这里会整片红，那时该做的是重新人工确认前 20 条可读，
   * 而不是把期望值改成新算出来的数。
   */
  const BENCHMARKS: ReadonlyArray<{ name: string; token: string; before: string; score: number }> =
    [
      { name: '20 字符混排密钥', token: SHAPELESS_20, before: '', score: 63 },
      {
        name: '44 字符混排密钥',
        token: `${SHAPELESS_20}A1b2C3d4E5f6G7h8I9j0K1l2`,
        before: '',
        score: 79
      },
      { name: 'POSIX 路径', ...SHAPE_SAMPLES.path, score: 13 },
      { name: '40 位提交号', ...SHAPE_SAMPLES['git-sha'], score: 12 },
      { name: 'UUID', ...SHAPE_SAMPLES.uuid, score: 10 },
      { name: '锁文件完整性串', ...SHAPE_SAMPLES['integrity-hash'], score: 10 },
      { name: '超长数据块', ...SHAPE_SAMPLES['long-blob'], score: 10 },
      { name: '点分的代码名字', ...SHAPE_SAMPLES['dotted-name'], score: 7 },
      { name: '长小写包名', ...SHAPE_SAMPLES['lower-words'], score: 6 },
      { name: 'data URI 里的 base64', ...SHAPE_SAMPLES['data-uri'], score: 5 },
      { name: '工具调用 id', ...SHAPE_SAMPLES['call-id'], score: 4 },
      { name: '毫秒时间戳', ...SHAPE_SAMPLES.numeric, score: 2 }
    ]

  it.each(BENCHMARKS)('$name 得 $score 分', ({ token, before, score }) => {
    expect(scoreResidual(token, before).score).toBe(score)
  })

  it('每一类噪音都还有正分 —— 降权只是压下去，不是删掉', () => {
    for (const shape of ALL_SHAPES) {
      const sample = SHAPE_SAMPLES[shape]
      expect(scoreResidual(sample.token, sample.before).score).toBeGreaterThan(0)
    }
  })

  it('一个既高熵又长得像 UUID 的串依然有分，只是排在后面', () => {
    const uuidLike = SHAPE_SAMPLES.uuid
    const result = scoreResidual(uuidLike.token, uuidLike.before)

    expect(result.shape).toBe('uuid')
    expect(result.score).toBeGreaterThan(0)
    expect(result.score).toBeLessThan(scoreResidual(SHAPELESS_20, '').score)
  })

  it('同一串加长，分数只会不降', () => {
    const alphabet = 'aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV'
    let previous = -1

    for (let length = REDACTION_RESIDUAL_MIN_LENGTH; length <= 64; length += 1) {
      const token = Array.from({ length }, (_, i) => alphabet[i % alphabet.length]).join('')
      const { score, shape } = scoreResidual(token, '')

      expect(shape).toBeNull()
      expect(score).toBeGreaterThanOrEqual(previous)
      previous = score
    }
  })

  it('多用一个字符类，分数只会不降', () => {
    const twoClasses = '1a2b3c4d5e6f7g8h9i0j'
    const threeClasses = '1A2b3c4d5e6f7g8h9i0j'

    expect(charClasses(twoClasses)).toBe(2)
    expect(charClasses(threeClasses)).toBe(3)
    expect(detectShape(twoClasses, '')).toBeNull()
    expect(detectShape(threeClasses, '')).toBeNull()
    expect(shannonEntropy(twoClasses)).toBeCloseTo(shannonEntropy(threeClasses), 10)

    expect(scoreResidual(threeClasses, '').score).toBeGreaterThan(
      scoreResidual(twoClasses, '').score
    )
  })

  it('分数是整数，且同一个输入跑两次一模一样', () => {
    for (const shape of ALL_SHAPES) {
      const sample = SHAPE_SAMPLES[shape]
      const first = scoreResidual(sample.token, sample.before)
      const second = scoreResidual(sample.token, sample.before)

      expect(Number.isInteger(first.score)).toBe(true)
      expect(first).toEqual(second)
    }
  })
})
