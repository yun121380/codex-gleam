import { describe, expect, it } from 'vitest'
import {
  flattenDependencyTree,
  readBuildEvidence,
  readDependencyEvidence
} from '../../src/main/selfCheck/evidence'
import { SELF_CHECK_MAX_EVIDENCE_BYTES, SELF_CHECK_MAX_PACKAGES } from '../../src/shared/constants'
import { createFakeFs } from '../support/fakeFs'

/**
 * 证据读取器最重要的性质不是「能读」，是**读不到时说得清为什么**：
 * 静默的空和真实的空在界面上长得一模一样，含义却相反。
 * 下面每一条失败路径都单独断言那句原因，就是为了把这件事钉死。
 */

const DIR = 'C:\\app\\generated'
const BUILD = `${DIR}\\build-evidence.json`
const DEPS = `${DIR}\\dependency-tree.json`

describe('构建期证据 · 构建校验', () => {
  it('目录为 null 时两手空空但不算岔子', async () => {
    const fs = createFakeFs({})
    // 「开发模式下没有这个目录」是常态，不是错误。往 issues 里塞一句
    // 只会让真正的岔子被淹在噪声里。
    await expect(readBuildEvidence(fs, null)).resolves.toEqual({ evidence: null, issues: [] })
    await expect(readDependencyEvidence(fs, null)).resolves.toEqual({
      evidence: null,
      issues: []
    })
  })

  it('正常 JSON 逐个字段对得上', async () => {
    const fs = createFakeFs({
      [BUILD]: JSON.stringify({
        schemaVersion: 1,
        gitSha: 'a'.repeat(40),
        testCount: 778,
        platform: 'win32',
        builtAt: '2026-09-06T00:00:00.000Z'
      })
    })

    const result = await readBuildEvidence(fs, DIR)
    expect(result.issues).toEqual([])
    expect(result.evidence).toEqual({
      schemaVersion: 1,
      gitSha: 'a'.repeat(40),
      testCount: 778,
      platform: 'win32',
      builtAt: '2026-09-06T00:00:00.000Z'
    })
  })

  it('一个字段坏了不把整份丢掉', async () => {
    const fs = createFakeFs({
      [BUILD]: JSON.stringify({ schemaVersion: 1, gitSha: 'abc123', testCount: null })
    })

    const result = await readBuildEvidence(fs, DIR)
    // 半份证据比没有强：拿到的照显示，没拿到的那一格说「不可用」。
    expect(result.evidence).toMatchObject({ gitSha: 'abc123', testCount: null, platform: null })
    expect(result.issues).toEqual([])
  })

  it('类型不对的字段当没有，而不是硬转成字符串', async () => {
    const fs = createFakeFs({ [BUILD]: JSON.stringify({ gitSha: 42, testCount: '778' }) })

    // `validators.ts` 那套宽松取法（asString(42) === '42'）是为 Codex 各版本
    // 日志格式不一准备的。这两份 JSON 是我们自己的脚本按固定 schema 写的，
    // 类型不对只说明写的那一方坏了——渲染成 "42" 是替坏数据圆场。
    const result = await readBuildEvidence(fs, DIR)
    expect(result.evidence).toMatchObject({ gitSha: null, testCount: null })
  })

  it('文件不存在时原因点明「读不到」', async () => {
    const fs = createFakeFs({})
    const result = await readBuildEvidence(fs, DIR)

    expect(result.evidence).toBeNull()
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toContain('读不到')
    expect(result.issues[0]).not.toContain('格式')
  })

  it('坏 JSON 时原因点明是格式坏，不和「读不到」混为一谈', async () => {
    const fs = createFakeFs({ [BUILD]: '{ 这不是 JSON' })
    const result = await readBuildEvidence(fs, DIR)

    expect(result.evidence).toBeNull()
    expect(result.issues[0]).toContain('格式')
    expect(result.issues[0]).not.toContain('读不到')
  })

  it('文件太大时说「太大」而不是「格式坏」', async () => {
    // 截断出来的文本解析必然失败，顺手报成「格式坏」会把人指向生成脚本，
    // 而真正的问题是这份文件大得离谱——方向差一步，排查差一天。
    const oversized = `{"gitSha":"${'x'.repeat(SELF_CHECK_MAX_EVIDENCE_BYTES)}"}`
    const fs = createFakeFs({ [BUILD]: oversized })
    const result = await readBuildEvidence(fs, DIR)

    expect(result.evidence).toBeNull()
    expect(result.issues[0]).toContain('大')
    expect(result.issues[0]).not.toContain('格式')
  })

  it('JSON 合法但不是对象时不当成证据', async () => {
    const fs = createFakeFs({ [BUILD]: '"just a string"' })
    const result = await readBuildEvidence(fs, DIR)

    expect(result.evidence).toBeNull()
    expect(result.issues).toHaveLength(1)
  })
})

describe('构建期证据 · 依赖树拍平', () => {
  it('嵌套三层全都收得上来，根包自己不算依赖', () => {
    const tree = [
      {
        name: 'gleam',
        version: '1.0.0',
        dependencies: {
          react: {
            version: '19.0.0',
            dependencies: { 'scheduler': { version: '0.25.0' } }
          }
        },
        devDependencies: {
          vitest: {
            version: '4.1.11',
            dependencies: { tinypool: { version: '2.0.0' } }
          }
        }
      }
    ]

    const flat = flattenDependencyTree(tree)
    // 根包（gleam@1.0.0）不在里面：它是应用自己，不是它的依赖。
    expect(flat.packages).toEqual([
      { name: 'react', version: '19.0.0' },
      { name: 'scheduler', version: '0.25.0' },
      { name: 'tinypool', version: '2.0.0' },
      { name: 'vitest', version: '4.1.11' }
    ])
    expect(flat.total).toBe(4)
    expect(flat.truncated).toBe(false)
  })

  it('同名不同版本各留一条，完全相同的才去重', () => {
    const tree = [
      {
        dependencies: {
          semver: {
            version: '7.6.0',
            dependencies: { lru: { version: '1.0.0' } }
          }
        },
        devDependencies: {
          semver: {
            version: '6.3.1',
            dependencies: { lru: { version: '1.0.0' } }
          }
        }
      }
    ]

    const flat = flattenDependencyTree(tree)
    // 一个树里同时有两个版本的 semver 是常态。合并成一条就把真相抹了 ——
    // 而「这个包里到底装了哪些东西」正是这一页要回答的问题。
    expect(flat.packages).toEqual([
      { name: 'lru', version: '1.0.0' },
      { name: 'semver', version: '6.3.1' },
      { name: 'semver', version: '7.6.0' }
    ])
    expect(flat.total).toBe(3)
  })

  it('带环的输入不死循环', () => {
    // pnpm 的输出理论上是树，但 peerDependencies 的解析结果里出现过自引用。
    const self: Record<string, unknown> = { version: '1.0.0' }
    self.dependencies = { loop: self }

    const flat = flattenDependencyTree([{ dependencies: { loop: self } }])
    expect(flat.packages).toEqual([{ name: 'loop', version: '1.0.0' }])
  })

  it('超上限时截断列表，但 packageCount 报的是截断前的真值', () => {
    const overflow = 7
    const dependencies: Record<string, unknown> = {}
    for (let i = 0; i < SELF_CHECK_MAX_PACKAGES + overflow; i += 1) {
      // 补零保证字典序和数值序一致，断言才能盯住具体是哪一条被切掉。
      dependencies[`pkg-${String(i).padStart(5, '0')}`] = { version: '1.0.0' }
    }

    const flat = flattenDependencyTree([{ dependencies }])
    expect(flat.packages).toHaveLength(SELF_CHECK_MAX_PACKAGES)
    expect(flat.truncated).toBe(true)
    // 列表是给人翻的，这个数才是精确的。
    expect(flat.total).toBe(SELF_CHECK_MAX_PACKAGES + overflow)
    expect(flat.packages.at(-1)?.name).toBe(`pkg-${String(SELF_CHECK_MAX_PACKAGES - 1).padStart(5, '0')}`)
  })

  it('没有版本的条目不进列表，但它的子树照收', () => {
    const tree = [
      { dependencies: { ghost: { dependencies: { real: { version: '2.0.0' } } } } }
    ]

    // 「装了 ghost」而不说哪个版本，等于什么都没说；但它下面那个包有自己的版本。
    expect(flattenDependencyTree(tree).packages).toEqual([{ name: 'real', version: '2.0.0' }])
  })

  it('树是 null 或形状不对时给空列表而不是抛', () => {
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      expect(flattenDependencyTree(bad)).toEqual({ packages: [], total: 0, truncated: false })
    }
  })
})

describe('构建期证据 · 依赖树读取', () => {
  it('正常文件读出时间戳与拍平后的包列表', async () => {
    const fs = createFakeFs({
      [DEPS]: JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-09-06T01:02:03.000Z',
        tree: [{ dependencies: { react: { version: '19.0.0' } } }]
      })
    })

    const result = await readDependencyEvidence(fs, DIR)
    expect(result.issues).toEqual([])
    expect(result.evidence).toEqual({
      generatedAt: '2026-09-06T01:02:03.000Z',
      packageCount: 1,
      packages: [{ name: 'react', version: '19.0.0' }],
      packagesTruncated: false
    })
  })

  it('生成时 pnpm list 没跑成（tree 为 null）要说一句', async () => {
    const fs = createFakeFs({
      [DEPS]: JSON.stringify({ generatedAt: '2026-09-06T00:00:00.000Z', tree: null })
    })

    const result = await readDependencyEvidence(fs, DIR)
    // 不说一句，页面上就是「0 个依赖」—— 那比撒谎好不了多少。
    expect(result.evidence?.packageCount).toBe(0)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toContain('pnpm list')
  })

  it('依赖树文件坏了时原因里点名是依赖树，不和构建校验混淆', async () => {
    const fs = createFakeFs({ [DEPS]: 'nope' })
    const result = await readDependencyEvidence(fs, DIR)

    // 两份证据各读各的，界面上要能分清是哪一份出的岔子。
    expect(result.issues[0]).toContain('依赖树')
  })
})
