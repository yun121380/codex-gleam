/**
 * B2 的验收测试：残留排名表在一份真实会话上到底管不管用。
 *
 * fixture `redaction-residual.jsonl` 里埋了一个**六条规则全都认不出来**的密钥
 * （44 字符、混排、没有键名、不属于任何已知格式），旁边摆着十类噪音各一份。
 * 这一期要的就是这一件事：打码规则漏掉的那个东西，得排在噪音前面。
 *
 * 五组：
 *   一，排序 —— 密钥的分数高于十类噪音里的每一个，十条各自带标签，挂的时候直接
 *       看出是哪一类噪音冒了头；
 *   二，降权不删除 —— 十类噪音一条都没消失，只是排在后面（Global Constraints
 *       第二条在测试里的样子）；
 *   三，剪枝后仍然精确 —— 灌爆上限之后，最高分那条依然是第一名；
 *   四，可复现 —— 同一个会话审两次，两份残留深度相等；
 *   五，路径 —— 残留是整份报告里唯一显示原文的一段，主目录仍然得洗掉。
 *
 * 这里用 `SessionLibrary` + 假文件系统而不是 `loadFixture()`：后者把 `homeDir` 钉在
 * `C:\Users\demo`，而 Windows 路径会被分词器按 `\` 切碎，第五组于是变成空验。
 * fixture 的 `cwd` 与这里的 `homeDir` 都是 POSIX 的，路径才能整条成为一个片段。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionLibrary } from '../../src/main/library'
import { LocalStore } from '../../src/main/storage/store'
import { createCollector, type ResidualInput } from '../../src/main/redaction/report'
import {
  REDACTION_RESIDUAL_MAX_KEYS,
  REDACTION_RESIDUAL_MAX_TEXT,
  REDACTION_RESIDUAL_TOP
} from '../../src/shared/constants'
import type { RedactionReport, RedactionResidual, ResidualShape } from '../../src/shared/types'
import type { FileSystemAccess } from '../../src/main/scanner/fsAccess'
import { createFakeFs } from '../support/fakeFs'
import { testFixturePath } from '../support/fixtures'

const HOME = '/home/demo'
const ROOT = `${HOME}/.codex`
const SESSION_FILE = `${ROOT}/residual.jsonl`

/** fixture 里那个谁都没认出来的密钥。整条 44 字符，`shape` 是 null。 */
const PLANTED_SECRET = 'Qk7vRm2ZpLxT9wNbHsY4gJdF6cVe3AuQ8iKwTz5Y1oPd'

/**
 * 十类噪音，每类一条「在排名表里怎么找到它」的前缀。
 *
 * 用前缀而不是全等：超长的两条（data URI 与 base64 数据块）在报告里只存开头，
 * 路径那条又被洗过主目录 —— 全等断言会挂在这两件**正确**的事情上。
 *
 * `call-id` 那条在 fixture 里是真的 `call_id` 字段，不是正文里抄的一串：这一族
 * 之所以要有自己的形态，正因为它是这个工具的管线自己写进去的，摆在字段里才算
 * 复现了它挤占前 20 的那条路。
 */
const NOISE: ReadonlyArray<readonly [ResidualShape, string]> = [
  ['git-sha', 'a3f5c9e1d7b204836af1c95e0d82b6473fe0a19c'],
  ['integrity-hash', 'sha512-3sXq7Zk2PvRt9wLmNbYh4J'],
  ['uuid', '7f3d2a91-4c6b-4e18-9a52-0bd6c7e18f34'],
  ['numeric', '20260906.113045.000123456'],
  ['lower-words', 'eslint-plugin-react-hooks-extra-rules'],
  ['dotted-name', 'window.performance.timeOrigin'],
  ['call-id', 'call_9tKq7mZr2vT9wPbN4sXy'],
  ['data-uri', 'iVBORw0KGgoAAAANSUhEUg'],
  ['long-blob', 'RUcEZzTvbXj/r0yYGc6AOEQog4wIAYQog49HJj1fB7tF'],
  ['path', '~/projects/gleam-residual/src/main.ts']
]

let storeDir: string
let fixture: string

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'gleam-residual-rank-'))
  fixture = await readFile(testFixturePath('redaction-residual.jsonl'), 'utf8')
})

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true })
})

/** 扫一遍只装着这份 fixture 的假文件系统。`platform` 与 `homeDir` 都是 POSIX 的。 */
async function openFixture(): Promise<{ library: SessionLibrary; sessionId: string }> {
  const fs: FileSystemAccess = createFakeFs({ [SESSION_FILE]: fixture })
  const library = new SessionLibrary({
    store: new LocalStore(storeDir),
    fs,
    platform: 'linux',
    env: { HOME },
    homeDir: HOME,
    sampleDir: null
  })
  await library.init()
  await library.updateSettings({ useBuiltinDirs: false, extraScanDirs: [ROOT] })
  await library.scan(undefined, () => {})

  const [summary] = await library.listSessions()
  if (!summary) throw new Error('残留 fixture 没有解析出会话')
  return { library, sessionId: summary.id }
}

async function auditFixture(): Promise<RedactionReport> {
  const { library, sessionId } = await openFixture()
  const report = await library.auditSession(sessionId)
  if (!report) throw new Error('审计没有产出报告')
  return report
}

/** 按开头找一条残留。找不到就抛 —— 空验比挂掉更糟。 */
function residualOf(report: RedactionReport, prefix: string): RedactionResidual {
  const entry = report.residuals.find((item) => item.text.startsWith(prefix))
  if (!entry) throw new Error(`排名表里没有以「${prefix}」开头的片段`)
  return entry
}

describe('那个没人认出来的密钥排在噪音前面', () => {
  it('fixture 里确实有这个密钥，而且六条规则一条都没打掉它', async () => {
    // 没有这一条，下面全是空验：密钥要是被某条规则打掉了，它压根不会出现在残留里，
    // 「分数更高」也就无从谈起。
    expect(fixture).toContain(PLANTED_SECRET)
    const report = await auditFixture()
    expect(residualOf(report, PLANTED_SECRET).text).toBe(PLANTED_SECRET)
  })

  it('分数高于十类噪音里的每一个', async () => {
    const report = await auditFixture()
    const secret = residualOf(report, PLANTED_SECRET)

    // 十条各自带标签，而不是一条 `every`：挂的时候要一眼看出是哪一类冒了头。
    // 断的是相对高低而不是具体分数 —— 系数调一次不该让验收测试全红。
    for (const [shape, prefix] of NOISE) {
      expect(secret.score, shape).toBeGreaterThan(residualOf(report, prefix).score)
    }
  })

  it('就是排名表的第一名', async () => {
    const report = await auditFixture()
    expect(report.residuals[0]?.text).toBe(PLANTED_SECRET)
  })
})

describe('排除只降权，不删除', () => {
  it('十类噪音全都还在表里，形态也认对了', async () => {
    const report = await auditFixture()

    for (const [shape, prefix] of NOISE) {
      const entry = residualOf(report, prefix)
      // 形态认错的话，它挨的是另一档折扣 —— 分数还是低，但低的理由是错的。
      expect(entry.shape, prefix).toBe(shape)
    }
  })

  it('没有任何一条被判为「不是残留」而消失', async () => {
    const report = await auditFixture()
    // 十类噪音 + 密钥 + 另外两条路径都在同一张表里，一条都没被门槛筛掉。
    expect(report.residualsTotal).toBeGreaterThan(NOISE.length)
    expect(report.residualsPruned).toBe(false)
  })
})

describe('剪枝之后前 20 仍然精确', () => {
  /** 分数由打分模块给，这一组只验收集器的剪枝，所以直接喂分数。 */
  function input(text: string, score: number): ResidualInput {
    return { text, length: text.length, score, shape: null }
  }

  it('灌爆上限之后，最高分那条还是第一名', () => {
    const collector = createCollector()
    // 上限是 2000，多灌 100 条把剪枝逼出来。低分全都一样，排序于是退化成按码点，
    // 结果是确定的 —— 「排序稳定且可复现」也包括这条路。
    for (let i = 0; i < REDACTION_RESIDUAL_MAX_KEYS + 100; i += 1) {
      collector.residual(input(`low-${String(i).padStart(5, '0')}-Kq7mZr2vT9wPbN4s`, 1))
    }
    // 高分那条**最后**才进来：剪枝把门槛抬起来之后仍然收得下它，才叫前 20 精确。
    collector.residual(input(PLANTED_SECRET, 90))
    const result = collector.summarize('residual-prune', true)

    expect(result.residuals[0]?.text).toBe(PLANTED_SECRET)
    expect(result.residualsPruned).toBe(true)
    expect(result.residuals).toHaveLength(REDACTION_RESIDUAL_TOP)
  })
})

describe('同一个会话审两次，结果一模一样', () => {
  it('两份残留深度相等', async () => {
    const { library, sessionId } = await openFixture()
    const first = await library.auditSession(sessionId)
    const second = await library.auditSession(sessionId)
    if (!first || !second) throw new Error('审计没有产出报告')

    expect(first.residuals).toEqual(second.residuals)
    // 两个空数组也能让上面那条绿，所以顺手钉一下「确实有东西」。
    expect(first.residuals.length).toBeGreaterThan(0)
  })
})

describe('残留显示原文，但主目录仍然要洗掉', () => {
  const MASKED_PATH = '~/projects/gleam-residual/src/main.ts'

  it('默认（hidePaths 开着）显示 `~`，整张表里搜不到真实主目录', async () => {
    const report = await auditFixture()

    expect(residualOf(report, MASKED_PATH).shape).toBe('path')
    // 这一段是整份报告里唯一显示原文的地方，也就是唯一可能漏出用户名的地方。
    expect(JSON.stringify(report.residuals)).not.toContain(HOME)
  })

  it('showFullPaths 打开时反过来：原样显示，一条 `~` 都没有', async () => {
    const { library, sessionId } = await openFixture()
    await library.updateSettings({ showFullPaths: true })
    const report = await library.auditSession(sessionId)
    if (!report) throw new Error('审计没有产出报告')

    expect(residualOf(report, `${HOME}/projects/gleam-residual/src/main.ts`).shape).toBe('path')
    expect(report.residuals.some((item) => item.text.startsWith('~/'))).toBe(false)
  })

  /**
   * 洗主目录会让 `text` 变短，而 `length` 记的是原文真实长度。界面用
   * `length > text.length` 判断「这条被截断了，只显示了开头」——
   * 洗白把这个比较变成真，于是一条完整显示的路径被说成「共 N 字符，只显示开头」。
   *
   * 少掉的字符是洗掉的，不是截掉的。截断与否只由 `report.ts` 那一刀决定，
   * 所以 `auditSession` 洗完之后要把没截断的那些 `length` 跟着缩回去。
   */
  it('洗短的路径不会被说成「只显示开头」', async () => {
    const report = await auditFixture()
    const residual = residualOf(report, MASKED_PATH)

    // 前提：这条确实被洗短了（`~` 比 `/home/demo` 短）。前提不成立的话下面那条
    // 断言就成了空验 —— 它会在任何实现下都绿。
    expect(MASKED_PATH.length).toBeLessThan(
      `${HOME}/projects/gleam-residual/src/main.ts`.length
    )
    expect(residual.length).toBe(residual.text.length)
  })

  it('真的被截断时，`length` 仍然是截断前的真实长度', async () => {
    // 反向的另一半：上一条不能靠「把 length 一律钉成 text.length」来满足，
    // 那样会把真截断的提示也一起弄没。fixture 里那条超长 base64 数据块正是
    // 撞过 REDACTION_RESIDUAL_MAX_TEXT 的一条。
    const report = await auditFixture()
    const truncated = report.residuals.filter(
      (item) => item.text.length === REDACTION_RESIDUAL_MAX_TEXT
    )

    expect(truncated.length).toBeGreaterThan(0)
    for (const item of truncated) {
      expect(item.length).toBeGreaterThan(item.text.length)
    }
  })
})
