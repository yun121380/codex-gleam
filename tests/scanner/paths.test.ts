import { describe, expect, it } from 'vitest'
import {
  baseName,
  buildScanRoots,
  fileExtension,
  getBuiltinRoots,
  isUnderDir,
  normalizePathKey,
  parentName,
  parseExtraDirsFromEnv,
  toDisplayPath
} from '../../src/main/scanner/paths'
import { maskHomePaths } from '../../src/shared/paths'

const WINDOWS_ENV = {
  USERPROFILE: 'C:\\Users\\demo',
  APPDATA: 'C:\\Users\\demo\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local'
}

describe('Windows 候选目录生成', () => {
  it('按规格生成全部 6 个默认目录', () => {
    const roots = getBuiltinRoots('win32', WINDOWS_ENV)
    const paths = roots.map((root) => root.path)

    expect(paths).toEqual([
      'C:\\Users\\demo\\.codex',
      'C:\\Users\\demo\\AppData\\Roaming\\Codex',
      'C:\\Users\\demo\\AppData\\Local\\Codex',
      'C:\\Users\\demo\\AppData\\Roaming\\OpenAI\\Codex',
      'C:\\Users\\demo\\AppData\\Local\\OpenAI\\Codex',
      'C:\\Users\\demo\\.config\\codex'
    ])
  })

  it('每个目录都带有面向用户的说明和来源环境变量', () => {
    const roots = getBuiltinRoots('win32', WINDOWS_ENV)
    for (const root of roots) {
      expect(root.label).not.toBe('')
      expect(root.origin).toBe('builtin')
      expect(root.basedOn).toMatch(/^%[A-Z]+%$/)
    }
  })

  it('环境变量缺失时安静跳过对应目录，而不是生成 undefined 路径', () => {
    const roots = getBuiltinRoots('win32', { USERPROFILE: 'C:\\Users\\demo' })
    const paths = roots.map((root) => root.path)

    expect(paths).toEqual(['C:\\Users\\demo\\.codex', 'C:\\Users\\demo\\.config\\codex'])
    expect(paths.some((path) => path.includes('undefined'))).toBe(false)
  })

  it('完全没有环境变量时返回空数组', () => {
    expect(getBuiltinRoots('win32', {})).toEqual([])
  })

  it('macOS 与 Linux 也各自有候选目录（保留跨平台结构）', () => {
    const mac = getBuiltinRoots('darwin', { HOME: '/Users/demo' })
    expect(mac.map((root) => root.path)).toContain('/Users/demo/.codex')
    expect(mac.map((root) => root.path)).toContain(
      '/Users/demo/Library/Application Support/Codex'
    )

    const linux = getBuiltinRoots('linux', { HOME: '/home/demo', XDG_CONFIG_HOME: '/home/demo/.conf' })
    expect(linux.map((root) => root.path)).toContain('/home/demo/.codex')
    expect(linux.map((root) => root.path)).toContain('/home/demo/.conf/codex')
  })
})

describe('路径归一化', () => {
  it('Windows 下大小写不敏感、斜杠统一、去掉末尾分隔符', () => {
    expect(normalizePathKey('C:\\Users\\Demo\\.codex\\', 'win32')).toBe('c:\\users\\demo\\.codex')
    expect(normalizePathKey('C:/Users/Demo/.codex', 'win32')).toBe('c:\\users\\demo\\.codex')
  })

  it('POSIX 下保留大小写', () => {
    expect(normalizePathKey('/home/Demo/.codex/', 'linux')).toBe('/home/Demo/.codex')
  })
})

describe('扫描目录合并', () => {
  it('内置目录与自定义目录合并且去重（不区分大小写）', () => {
    const roots = buildScanRoots({
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\demo' },
      useBuiltinDirs: true,
      extraDirs: ['D:\\backup\\codex', 'c:\\users\\DEMO\\.codex']
    })

    const paths = roots.map((root) => root.path)
    expect(paths).toEqual([
      'C:\\Users\\demo\\.codex',
      'C:\\Users\\demo\\.config\\codex',
      'D:\\backup\\codex'
    ])
  })

  it('关闭内置目录后只留自定义目录', () => {
    const roots = buildScanRoots({
      platform: 'win32',
      env: WINDOWS_ENV,
      useBuiltinDirs: false,
      extraDirs: ['D:\\backup\\codex']
    })

    expect(roots).toHaveLength(1)
    expect(roots[0]?.origin).toBe('custom')
  })

  it('读取 GLEAM_EXTRA_DIRS 环境变量', () => {
    const roots = buildScanRoots({
      platform: 'win32',
      env: { GLEAM_EXTRA_DIRS: 'D:\\one;E:\\two' },
      useBuiltinDirs: false,
      extraDirs: []
    })

    expect(roots.map((root) => root.path)).toEqual(['D:\\one', 'E:\\two'])
  })

  it('Windows 下用分号分隔，不会把盘符的冒号切开', () => {
    expect(parseExtraDirsFromEnv('win32', { GLEAM_EXTRA_DIRS: 'D:\\one;E:\\two' })).toEqual([
      'D:\\one',
      'E:\\two'
    ])
    expect(parseExtraDirsFromEnv('linux', { GLEAM_EXTRA_DIRS: '/a:/b' })).toEqual(['/a', '/b'])
  })
})

describe('展示用路径', () => {
  const options = { showFullPaths: false, homeDir: 'C:\\Users\\demo', platform: 'win32' as const }

  it('关闭"显示完整路径"时把用户目录换成 ~，隐藏用户名', () => {
    expect(toDisplayPath('C:\\Users\\demo\\.codex\\sessions\\a.jsonl', options)).toBe(
      '~\\.codex\\sessions\\a.jsonl'
    )
  })

  it('开启时原样返回', () => {
    expect(
      toDisplayPath('C:\\Users\\demo\\.codex\\a.jsonl', { ...options, showFullPaths: true })
    ).toBe('C:\\Users\\demo\\.codex\\a.jsonl')
  })

  it('不在用户目录下的路径不做改动', () => {
    expect(toDisplayPath('D:\\work\\a.jsonl', options)).toBe('D:\\work\\a.jsonl')
  })

  it('大小写不同也能识别出用户目录', () => {
    expect(toDisplayPath('c:\\users\\DEMO\\notes\\a.jsonl', options)).toBe('~\\notes\\a.jsonl')
  })

  /**
   * 边界原来是拿 startsWith 判断的：`c:\users\demo` 同样是
   * `c:\users\demo2\...` 的前缀，于是隔壁用户的文件被当成"在自己家里"，
   * 截出来的 `~\2\notes.jsonl` 既没藏住用户名，路径本身也是错的。
   */
  it('同名前缀的隔壁用户目录不当成主目录', () => {
    expect(toDisplayPath('C:\\Users\\demo2\\notes\\a.jsonl', options)).toBe(
      'C:\\Users\\demo2\\notes\\a.jsonl'
    )
    expect(toDisplayPath('C:\\Users\\demo.old\\a.jsonl', options)).toBe('C:\\Users\\demo.old\\a.jsonl')
  })

  it('主目录本身变成单独一个 ~', () => {
    expect(toDisplayPath('C:\\Users\\demo', options)).toBe('~')
    expect(toDisplayPath('C:\\Users\\demo\\', options)).toBe('~')
  })

  it('POSIX 下同样按分隔符判断边界', () => {
    const posix = { showFullPaths: false, homeDir: '/home/demo', platform: 'linux' as const }
    expect(toDisplayPath('/home/demo/.codex/a.jsonl', posix)).toBe('~/.codex/a.jsonl')
    expect(toDisplayPath('/home/demo2/.codex/a.jsonl', posix)).toBe('/home/demo2/.codex/a.jsonl')
  })
})

describe('目录归属判断', () => {
  it('按分隔符判断边界，前缀相同的兄弟目录不算在内', () => {
    expect(isUnderDir('c:\\foo\\a.jsonl', 'c:\\foo')).toBe(true)
    expect(isUnderDir('c:\\foo', 'c:\\foo')).toBe(true)
    expect(isUnderDir('c:\\foobar\\a.jsonl', 'c:\\foo')).toBe(false)
  })

  it('盘符根与 posix 根不会多出一个分隔符', () => {
    expect(isUnderDir('c:\\a.jsonl', 'c:\\')).toBe(true)
    expect(isUnderDir('/tmp/a.jsonl', '/')).toBe(true)
  })

  it('空字符串一律不算', () => {
    expect(isUnderDir('', 'c:\\foo')).toBe(false)
    expect(isUnderDir('c:\\foo\\a.jsonl', '')).toBe(false)
  })
})

/**
 * 事件标题不是一个路径，而是一句话里夹着路径（`读取 C:\Users\alice\a.ts`、
 * 或者一整条 shell 命令）。toDisplayPath 只认整串是路径的情况，所以另有这个。
 */
describe('文本里的主目录打码', () => {
  const windows = { homeDir: 'C:\\Users\\bob', platform: 'win32' as const }

  it('把句子中间的主目录换成 ~', () => {
    expect(maskHomePaths('读取 C:\\Users\\bob\\proj\\a.ts', windows)).toBe('读取 ~\\proj\\a.ts')
  })

  it('一句话里出现多次也全部处理', () => {
    expect(maskHomePaths('diff C:\\Users\\bob\\a C:\\Users\\bob\\b', windows)).toBe('diff ~\\a ~\\b')
  })

  it('大小写与正斜杠写法都认得出来', () => {
    expect(maskHomePaths('cat "C:/Users/BOB/.ssh/config"', windows)).toBe('cat "~/.ssh/config"')
  })

  it('同名前缀的隔壁用户目录不动', () => {
    expect(maskHomePaths('C:\\Users\\bobby\\notes.jsonl', windows)).toBe('C:\\Users\\bobby\\notes.jsonl')
    expect(maskHomePaths('C:\\Users\\bob.old\\x', windows)).toBe('C:\\Users\\bob.old\\x')
  })

  it('主目录就在末尾时也处理', () => {
    expect(maskHomePaths('打开 C:\\Users\\bob', windows)).toBe('打开 ~')
  })

  it('没有主目录信息、或主目录不像路径时原样返回', () => {
    const text = 'C:\\Users\\bob\\a.ts'
    expect(maskHomePaths(text, { homeDir: null, platform: 'win32' })).toBe(text)
    expect(maskHomePaths(text, { homeDir: 'C:\\', platform: 'win32' })).toBe(text)
    expect(maskHomePaths(text, { homeDir: '   ', platform: 'win32' })).toBe(text)
  })

  it('POSIX 下区分大小写', () => {
    const posix = { homeDir: '/home/bob', platform: 'linux' as const }
    expect(maskHomePaths('ls /home/bob/x /home/bobby/y', posix)).toBe('ls ~/x /home/bobby/y')
    expect(maskHomePaths('ls /home/BOB/x', posix)).toBe('ls /home/BOB/x')
  })
})

describe('路径小工具', () => {
  it('baseName / parentName / fileExtension 同时支持两种分隔符', () => {
    expect(baseName('C:\\a\\b\\c.jsonl')).toBe('c.jsonl')
    expect(baseName('/a/b/c.json')).toBe('c.json')
    expect(parentName('C:\\a\\b\\c.jsonl')).toBe('b')
    expect(fileExtension('C:\\a\\b\\c.JSONL')).toBe('.jsonl')
    expect(fileExtension('C:\\a\\b\\noext')).toBe('')
  })
})
