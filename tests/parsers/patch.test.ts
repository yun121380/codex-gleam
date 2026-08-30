import { describe, expect, it } from 'vitest'
import {
  buildUnifiedDiff,
  parseApplyPatch,
  parsePatchText,
  parseUnifiedDiff,
  sumChanges
} from '../../src/main/parsers/patch'

describe('apply_patch 解析', () => {
  it('解析多文件补丁并区分新增 / 修改 / 删除', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      '-const a = 1',
      '+const a = 2',
      '*** Add File: src/b.ts',
      '+export const b = 1',
      '+export const c = 2',
      '*** Delete File: src/old.ts',
      '*** End Patch'
    ].join('\n')

    const changes = parseApplyPatch(patch)

    expect(changes).toHaveLength(3)
    expect(changes[0]).toMatchObject({ path: 'src/a.ts', kind: 'edit', additions: 1, deletions: 1 })
    expect(changes[1]).toMatchObject({ path: 'src/b.ts', kind: 'write', additions: 2, deletions: 0 })
    expect(changes[2]).toMatchObject({ path: 'src/old.ts', kind: 'delete' })
  })

  it('保留每个文件自己的 diff 文本', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@ 上下文',
      '-old line',
      '+new line',
      '*** End Patch'
    ].join('\n')

    const [change] = parseApplyPatch(patch)
    expect(change?.diff).toContain('-old line')
    expect(change?.diff).toContain('+new line')
  })

  it('没有补丁结构时返回空数组，不瞎猜', () => {
    expect(parsePatchText('这只是一段普通文字')).toEqual([])
    expect(parsePatchText('')).toEqual([])
  })
})

describe('unified diff 解析', () => {
  it('解析 git diff 风格的输出', () => {
    const diff = [
      'diff --git a/src/cart/price.ts b/src/cart/price.ts',
      'index 1111111..2222222 100644',
      '--- a/src/cart/price.ts',
      '+++ b/src/cart/price.ts',
      '@@ -12,7 +12,7 @@',
      ' export function totalPrice() {',
      '-  return subtotal',
      '+  return Math.round(subtotal * 100) / 100',
      ' }'
    ].join('\n')

    const changes = parseUnifiedDiff(diff)

    expect(changes).toHaveLength(1)
    expect(changes[0]?.path).toBe('src/cart/price.ts')
    expect(changes[0]?.additions).toBe(1)
    expect(changes[0]?.deletions).toBe(1)
  })

  it('没有 git 头、只有 --- / +++ 也能解析', () => {
    const diff = ['--- src/a.ts', '+++ src/a.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    const [change] = parseUnifiedDiff(diff)

    expect(change?.path).toBe('src/a.ts')
    expect(change?.additions).toBe(1)
  })

  it('新文件的 /dev/null 不会变成文件名', () => {
    const diff = ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+created'].join('\n')
    const [change] = parseUnifiedDiff(diff)

    expect(change?.path).toBe('src/new.ts')
  })

  it('parsePatchText 会自动挑选正确的解析方式', () => {
    const applyPatch = '*** Begin Patch\n*** Update File: x.ts\n@@\n-a\n+b\n*** End Patch'
    const unified = '--- x.ts\n+++ x.ts\n@@ -1 +1 @@\n-a\n+b'

    expect(parsePatchText(applyPatch)[0]?.path).toBe('x.ts')
    expect(parsePatchText(unified)[0]?.path).toBe('x.ts')
  })
})

describe('从前后全文生成 diff', () => {
  it('生成的补丁只包含真正变化的行', () => {
    const before = 'line 1\nline 2\nline 3\nline 4\n'
    const after = 'line 1\nline 2 changed\nline 3\nline 4\n'

    const diff = buildUnifiedDiff('src/x.ts', before, after)

    expect(diff).toContain('-line 2')
    expect(diff).toContain('+line 2 changed')
    expect(diff).not.toContain('-line 4')
    expect(diff.startsWith('Index:')).toBe(false)
  })

  it('内容相同时不会产生增删行', () => {
    const diff = buildUnifiedDiff('src/x.ts', 'same\n', 'same\n')
    const changed = diff
      .split('\n')
      .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !/^[+-]{3}/.test(line))

    expect(changed).toEqual([])
  })
})

describe('增删行汇总', () => {
  it('把多个文件的增删行加起来', () => {
    const changes = parseApplyPatch(
      [
        '*** Begin Patch',
        '*** Update File: a.ts',
        '-1',
        '+2',
        '+3',
        '*** Update File: b.ts',
        '-4',
        '*** End Patch'
      ].join('\n')
    )

    expect(sumChanges(changes)).toEqual({ additions: 2, deletions: 2 })
  })
})
