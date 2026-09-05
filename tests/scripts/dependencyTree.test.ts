import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { stripHome } from '../../scripts/dependencyTree.mjs'

describe('stripHome', () => {
  it('把用户目录换成 ~，不把打包者的用户名写进产物', () => {
    const home = homedir()
    // 模拟 JSON.stringify 之后的文本：Windows 路径的反斜杠是转义过的。
    const serialized = JSON.stringify({ path: `${home}/project/node_modules/diff` })

    const stripped = stripHome(serialized)

    expect(stripped).not.toContain(JSON.stringify(home).slice(1, -1))
    expect(stripped).toContain('~/project/node_modules/diff')
  })

  it('不含用户目录的文本原样返回', () => {
    const text = '{"name":"diff","version":"9.0.0"}'
    expect(stripHome(text)).toBe(text)
  })
})
