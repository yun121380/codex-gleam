import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「在文件管理器中定位」。
 *
 * 两件事：
 *   - 日志里的路径**经常是相对的**（apply_patch 记的就是 `src/app.ts`），
 *     原样交给系统会去当前进程的工作目录里找，弹开一个八竿子打不着的位置；
 *   - 返回值代表真的定位到了。showItemInFolder 对着不存在的路径是静默的，
 *     不确认文件还在就 return true，界面便一句提示都不给，
 *     用户看到的只是"点了没反应"。
 */

const showItemInFolder = vi.fn()

vi.mock('electron', () => ({
  app: { enableSandbox: vi.fn(), on: vi.fn() },
  shell: { showItemInFolder: (path: string) => showItemInFolder(path) }
}))

const { revealInFolder } = await import('../../src/main/security')

let dir: string
let existing: string

beforeEach(async () => {
  showItemInFolder.mockClear()
  dir = await mkdtemp(join(tmpdir(), 'gleam-reveal-'))
  existing = join(dir, 'a.jsonl')
  await writeFile(existing, '{}', 'utf8')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('绝对路径', () => {
  it('文件在就交给系统', async () => {
    await expect(revealInFolder(existing)).resolves.toBe(true)
    expect(showItemInFolder).toHaveBeenCalledWith(existing)
  })

  it('有参照目录也不受影响', async () => {
    await expect(revealInFolder(existing, 'D:\\somewhere\\else')).resolves.toBe(true)
    expect(showItemInFolder).toHaveBeenCalledWith(existing)
  })
})

describe('相对路径', () => {
  it('按工作目录解析成绝对路径', async () => {
    await expect(revealInFolder('a.jsonl', dir)).resolves.toBe(true)

    const [target] = showItemInFolder.mock.calls[0] as [string]
    expect(isAbsolute(target)).toBe(true)
    expect(target).toBe(existing)
  })

  it('不知道参照目录时明确失败，而不是定位到错的地方', async () => {
    await expect(revealInFolder('a.jsonl')).resolves.toBe(false)
    await expect(revealInFolder('a.jsonl', null)).resolves.toBe(false)
    await expect(revealInFolder('a.jsonl', '   ')).resolves.toBe(false)
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('参照目录本身是相对的也不行（那样解析出来仍旧不可靠）', async () => {
    await expect(revealInFolder('a.jsonl', 'proj')).resolves.toBe(false)
    expect(showItemInFolder).not.toHaveBeenCalled()
  })
})

/*
 * 会话记录常常是几个月前的，原始文件早被挪走或删掉 —— 这条路径一点都不罕见。
 */
describe('文件已经不在了', () => {
  it('绝对路径指向不存在的文件时返回 false，也不去打扰系统', async () => {
    await expect(revealInFolder(join(dir, '没有这个.jsonl'))).resolves.toBe(false)
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('相对路径解析出来的文件不存在时同样返回 false', async () => {
    await expect(revealInFolder('nope.jsonl', dir)).resolves.toBe(false)
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('目录也算数（打开索引所在目录就是这么用的）', async () => {
    await expect(revealInFolder(dir)).resolves.toBe(true)
    expect(showItemInFolder).toHaveBeenCalledWith(dir)
  })
})

describe('挡掉不该交给系统的东西', () => {
  it('空路径', async () => {
    await expect(revealInFolder('')).resolves.toBe(false)
    await expect(revealInFolder('   ')).resolves.toBe(false)
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('带协议的地址', async () => {
    for (const url of ['http://example.com/a', 'file://C:/x', 'https://x.y/z']) {
      await expect(revealInFolder(url, dir)).resolves.toBe(false)
    }
    expect(showItemInFolder).not.toHaveBeenCalled()
  })
})
