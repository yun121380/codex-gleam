import { describe, expect, it } from 'vitest'

import { buildEvidence } from '../../scripts/buildEvidence.mjs'

describe('buildEvidence', () => {
  it('产出固定形状，schemaVersion 恒为 1', () => {
    const evidence = buildEvidence({
      gitSha: 'abc1234',
      testCount: 462,
      platform: 'win32',
      builtAt: '2026-09-05T00:00:00.000Z'
    })

    expect(evidence).toEqual({
      schemaVersion: 1,
      gitSha: 'abc1234',
      testCount: 462,
      platform: 'win32',
      builtAt: '2026-09-05T00:00:00.000Z'
    })
  })

  it('拿不到 git sha 或测试数时写 null，不编造 0', () => {
    const evidence = buildEvidence({
      gitSha: null,
      testCount: null,
      platform: 'linux',
      builtAt: '2026-09-05T00:00:00.000Z'
    })

    expect(evidence.gitSha).toBeNull()
    expect(evidence.testCount).toBeNull()
  })
})
