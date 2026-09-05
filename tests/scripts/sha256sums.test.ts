import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { writeSums } from '../../scripts/sha256sums.mjs'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gleam-sums-'))
}

describe('writeSums', () => {
  it('对匹配的文件输出 "<sha256>  <文件名>" 两空格格式', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'app.exe'), 'hello', 'utf8')
    const out = join(dir, 'SHA256SUMS.txt')

    const text = await writeSums(dir, out, ['.exe'])

    // sha256('hello')
    const expected =
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  app.exe\n'
    expect(text).toBe(expected)
    expect(await readFile(out, 'utf8')).toBe(expected)
  })

  it('按文件名排序，保证同样的输入得到同样的输出', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'b.zip'), 'b', 'utf8')
    await writeFile(join(dir, 'a.zip'), 'a', 'utf8')
    const out = join(dir, 'SHA256SUMS.txt')

    const text = await writeSums(dir, out, ['.zip'])

    const names = text
      .trim()
      .split('\n')
      .map((line) => line.split('  ')[1])
    expect(names).toEqual(['a.zip', 'b.zip'])
  })

  it('跳过不匹配后缀的文件与子目录', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'keep.exe'), 'x', 'utf8')
    await writeFile(join(dir, 'skip.blockmap'), 'x', 'utf8')
    const out = join(dir, 'SHA256SUMS.txt')

    const text = await writeSums(dir, out, ['.exe'])

    expect(text).toContain('keep.exe')
    expect(text).not.toContain('skip.blockmap')
  })

  it('目录里没有匹配文件时抛错，不写出空文件', async () => {
    const dir = await makeDir()
    const out = join(dir, 'SHA256SUMS.txt')

    await expect(writeSums(dir, out, ['.exe'])).rejects.toThrow('没有找到')
  })
})
