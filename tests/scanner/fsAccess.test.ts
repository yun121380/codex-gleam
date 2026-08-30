import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeFileSystem } from '../../src/main/scanner/fsAccess'

/**
 * 只读文件系统访问层的测试。
 *
 * 重点是分块读取的正确性：内部按 256 KB 一块读，
 * 一个多字节字符（中文、emoji）很容易正好跨在两块之间。
 * 逐块调用 Buffer.toString('utf8') 会把它切成两半变成乱码，
 * 而这类日志几乎全是中文 —— 必须用流式解码器。
 */

const CHUNK_BYTES = 256 * 1024

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gleam-fs-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  return path
}

async function readAllLines(path: string): Promise<string[]> {
  const lines: string[] = []
  for await (const chunk of nodeFileSystem.streamLines(path, {
    maxLines: 1_000_000,
    maxBytes: 256 * 1024 * 1024
  })) {
    lines.push(chunk.line)
  }
  return lines
}

describe('逐行流式读取', () => {
  it('读出全部行且内容完全一致', async () => {
    const path = await write('simple.jsonl', 'first\nsecond\nthird\n')
    expect(await readAllLines(path)).toEqual(['first', 'second', 'third'])
  })

  it('保留 Windows 换行里的内容，去掉 \\r', async () => {
    const path = await write('crlf.jsonl', 'a\r\nb\r\n')
    expect(await readAllLines(path)).toEqual(['a', 'b'])
  })

  it('最后一行没有换行也能读到', async () => {
    const path = await write('noeol.jsonl', 'a\nb')
    expect(await readAllLines(path)).toEqual(['a', 'b'])
  })

  it('中文字符正好跨在分块边界上时不会变成乱码', async () => {
    // 让一个 3 字节的汉字从第 CHUNK_BYTES-1 个字节开始：1 个字节落在第一块，2 个落在第二块。
    const padding = 'x'.repeat(CHUNK_BYTES - 1)
    const content = `${padding}汉字测试\n第二行也是中文\n`
    const path = await write('boundary.jsonl', content)

    const lines = await readAllLines(path)

    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(`${padding}汉字测试`)
    expect(lines[1]).toBe('第二行也是中文')
    expect(lines.join('')).not.toContain('�')
  })

  it('emoji（4 字节字符）跨边界同样安全', async () => {
    for (const offset of [-3, -2, -1, 0]) {
      const padding = 'x'.repeat(CHUNK_BYTES + offset)
      const path = await write(`emoji${offset}.jsonl`, `${padding}😀尾巴\n`)

      const lines = await readAllLines(path)
      expect(lines[0], `偏移 ${offset}`).toBe(`${padding}😀尾巴`)
      expect(lines[0], `偏移 ${offset}`).not.toContain('�')
    }
  })

  it('跨多个分块的大文件逐字节一致', async () => {
    // 约 1.2 MB 的中文内容，会经过 4 个以上的分块边界。
    const line = '这是一行用来测试分块解码的中文内容，里面还有 emoji 😀 和符号 ✓。'
    const count = Math.ceil((1.2 * 1024 * 1024) / Buffer.byteLength(`${line}\n`, 'utf8'))
    const expected = Array.from({ length: count }, (_, index) => `${index}:${line}`)
    const path = await write('big.jsonl', `${expected.join('\n')}\n`)

    const lines = await readAllLines(path)

    expect(lines).toEqual(expected)
    expect(lines.some((entry) => entry.includes('�'))).toBe(false)
  })

  it('遵守最大行数上限', async () => {
    const path = await write('many.jsonl', Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'))

    const lines: string[] = []
    for await (const chunk of nodeFileSystem.streamLines(path, { maxLines: 10, maxBytes: 1024 * 1024 })) {
      lines.push(chunk.line)
    }

    expect(lines).toHaveLength(10)
    expect(lines[9]).toBe('line 9')
  })

  it('空文件不产出任何行', async () => {
    const path = await write('empty.jsonl', '')
    expect(await readAllLines(path)).toEqual([])
  })
})

describe('读取文件头', () => {
  it('只读前若干字节', async () => {
    const path = await write('head.json', 'abcdefghij')
    expect(await nodeFileSystem.readHead(path, 4)).toBe('abcd')
  })

  it('文件比上限短时返回全部内容', async () => {
    const path = await write('short.json', 'abc')
    expect(await nodeFileSystem.readHead(path, 1024)).toBe('abc')
  })
})

describe('整份读取', () => {
  it('中文内容完整无损', async () => {
    const content = '{"text":"完整的中文内容，带 emoji 😀"}'
    const path = await write('whole.json', content)

    const result = await nodeFileSystem.readText(path, 1024 * 1024)
    expect(result.text).toBe(content)
    expect(result.truncated).toBe(false)
  })

  it('超过上限时标记截断', async () => {
    const path = await write('long.json', 'x'.repeat(5000))
    const result = await nodeFileSystem.readText(path, 1000)

    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(1000)
  })
})
