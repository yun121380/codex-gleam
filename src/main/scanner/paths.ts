import { posix as posixPath, win32 as winPath } from 'node:path'
import type { CandidateRoot, Platform } from '@shared/types'

export type EnvLike = Record<string, string | undefined>

interface RootTemplate {
  /** 依赖的环境变量名。 */
  envVar: string
  /** 相对该环境变量的子路径片段。 */
  segments: string[]
  label: string
}

/**
 * Windows 默认候选目录。顺序即扫描顺序。
 * 这里刻意不假设 Codex 永远使用某个固定目录 —— 新目录只需往数组里加一条。
 */
const WINDOWS_TEMPLATES: RootTemplate[] = [
  { envVar: 'USERPROFILE', segments: ['.codex'], label: 'Codex 主目录' },
  { envVar: 'APPDATA', segments: ['Codex'], label: 'Codex 应用数据' },
  { envVar: 'LOCALAPPDATA', segments: ['Codex'], label: 'Codex 本地数据' },
  { envVar: 'APPDATA', segments: ['OpenAI', 'Codex'], label: 'OpenAI Codex 应用数据' },
  { envVar: 'LOCALAPPDATA', segments: ['OpenAI', 'Codex'], label: 'OpenAI Codex 本地数据' },
  { envVar: 'USERPROFILE', segments: ['.config', 'codex'], label: 'Codex 配置目录' }
]

const MACOS_TEMPLATES: RootTemplate[] = [
  { envVar: 'HOME', segments: ['.codex'], label: 'Codex 主目录' },
  { envVar: 'HOME', segments: ['.config', 'codex'], label: 'Codex 配置目录' },
  {
    envVar: 'HOME',
    segments: ['Library', 'Application Support', 'Codex'],
    label: 'Codex 应用支持目录'
  },
  {
    envVar: 'HOME',
    segments: ['Library', 'Application Support', 'OpenAI', 'Codex'],
    label: 'OpenAI Codex 应用支持目录'
  }
]

const LINUX_TEMPLATES: RootTemplate[] = [
  { envVar: 'HOME', segments: ['.codex'], label: 'Codex 主目录' },
  { envVar: 'XDG_CONFIG_HOME', segments: ['codex'], label: 'Codex XDG 配置目录' },
  { envVar: 'HOME', segments: ['.config', 'codex'], label: 'Codex 配置目录' },
  { envVar: 'HOME', segments: ['.local', 'share', 'codex'], label: 'Codex 数据目录' }
]

function templatesFor(platform: Platform): RootTemplate[] {
  switch (platform) {
    case 'win32':
      return WINDOWS_TEMPLATES
    case 'darwin':
      return MACOS_TEMPLATES
    default:
      return LINUX_TEMPLATES
  }
}

function pathApi(platform: Platform) {
  return platform === 'win32' ? winPath : posixPath
}

/** 归一化路径，用于去重与比较（Windows 下大小写不敏感）。 */
export function normalizePathKey(target: string, platform: Platform): string {
  const api = pathApi(platform)
  let normalized = api.normalize(target.trim())
  if (normalized.length > 1 && (normalized.endsWith(api.sep) || normalized.endsWith('/'))) {
    normalized = normalized.slice(0, -1)
  }
  return platform === 'win32' ? normalized.toLowerCase().replace(/\//g, '\\') : normalized
}

/** 取所在目录的归一化 key，与 normalizePathKey 出来的目录 key 可直接比较。 */
export function parentDirKey(target: string, platform: Platform): string {
  const api = pathApi(platform)
  return normalizePathKey(api.dirname(normalizePathKey(target, platform)), platform)
}

/**
 * 生成内置候选目录。纯函数：只依赖传入的 platform 与环境变量，方便测试。
 * 环境变量缺失时对应条目会被安静跳过（例如 Linux 上没有 %APPDATA%）。
 */
export function getBuiltinRoots(platform: Platform, env: EnvLike): CandidateRoot[] {
  const api = pathApi(platform)
  const seen = new Set<string>()
  const roots: CandidateRoot[] = []

  for (const template of templatesFor(platform)) {
    const base = env[template.envVar]
    if (!base || base.trim() === '') continue

    const fullPath = api.join(base.trim(), ...template.segments)
    const key = normalizePathKey(fullPath, platform)
    if (seen.has(key)) continue
    seen.add(key)

    roots.push({
      path: fullPath,
      label: template.label,
      origin: 'builtin',
      basedOn: `%${template.envVar}%`
    })
  }

  return roots
}

/**
 * 解析 GLEAM_EXTRA_DIRS 环境变量。
 * Windows 用 `;` 分隔（不能用 `:`，否则会切断盘符）。
 */
export function parseExtraDirsFromEnv(platform: Platform, env: EnvLike): string[] {
  const raw = env.GLEAM_EXTRA_DIRS
  if (!raw) return []
  const separator = platform === 'win32' ? /;/ : /[;:]/
  return raw
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** 合并内置目录与用户自定义目录，去重后返回。 */
export function buildScanRoots(options: {
  platform: Platform
  env: EnvLike
  useBuiltinDirs: boolean
  extraDirs: readonly string[]
}): CandidateRoot[] {
  const { platform, env, useBuiltinDirs, extraDirs } = options
  const result: CandidateRoot[] = []
  const seen = new Set<string>()

  const push = (root: CandidateRoot): void => {
    const key = normalizePathKey(root.path, platform)
    if (key === '' || seen.has(key)) return
    seen.add(key)
    result.push(root)
  }

  if (useBuiltinDirs) {
    for (const root of getBuiltinRoots(platform, env)) push(root)
  }

  for (const dir of [...extraDirs, ...parseExtraDirsFromEnv(platform, env)]) {
    if (dir.trim() === '') continue
    push({ path: dir.trim(), label: '自定义目录', origin: 'custom' })
  }

  return result
}

/**
 * 这个路径在不在某个目录之下（目录本身也算）？
 *
 * 边界必须落在路径分隔符上，不能直接 startsWith：`c:\users\bob` 同样是
 * `c:\users\bobby\notes.jsonl` 的前缀。少了这道边界，`bobby` 的文件会被当成
 * 「在 bob 家里」，展示时被截成 `~\by\notes.jsonl` —— 用户名没藏住，路径还错了。
 *
 * 两个参数都必须先过 normalizePathKey（Windows 下统一成小写反斜杠）。
 */
export function isUnderDir(key: string, parentKey: string): boolean {
  if (parentKey === '' || key === '') return false
  if (key === parentKey) return true

  // 盘符根（`c:\`）与 posix 根（`/`）本身就以分隔符结尾，不能再补一个。
  if (/[\\/]$/.test(parentKey)) return key.startsWith(parentKey)

  // 自定义目录可能写成 posix 风格，那时分隔符是 `/`。
  return key.startsWith(`${parentKey}\\`) || key.startsWith(`${parentKey}/`)
}

/**
 * 把路径转换成界面/导出里展示的形式。
 * 关闭「显示完整路径」时，把用户主目录替换成 `~`，以隐藏用户名。
 */
export function toDisplayPath(
  target: string,
  options: { showFullPaths: boolean; homeDir?: string | null; platform?: Platform }
): string {
  if (!target) return ''
  if (options.showFullPaths) return target

  const platform = options.platform ?? 'win32'
  const home = options.homeDir
  if (!home || home.trim() === '') return target

  const targetKey = normalizePathKey(target, platform)
  const homeKey = normalizePathKey(home, platform)
  if (!isUnderDir(targetKey, homeKey)) return target

  const remainder = target.slice(home.replace(/[\\/]+$/, '').length)
  const cleaned = remainder.replace(/^[\\/]+/, '')
  const sep = platform === 'win32' ? '\\' : '/'
  return cleaned === '' ? '~' : `~${sep}${cleaned}`
}

/** 取路径最后一段，用于标题显示。 */
export function baseName(target: string): string {
  const cleaned = target.replace(/[\\/]+$/, '')
  const index = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'))
  return index >= 0 ? cleaned.slice(index + 1) : cleaned
}

/** 取父目录名，用于推断项目名。 */
export function parentName(target: string): string {
  const cleaned = target.replace(/[\\/]+$/, '')
  const index = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'))
  if (index <= 0) return ''
  return baseName(cleaned.slice(0, index))
}

/** 文件扩展名（小写，含点）。没有扩展名时返回空字符串。 */
export function fileExtension(target: string): string {
  const name = baseName(target)
  const index = name.lastIndexOf('.')
  if (index <= 0) return ''
  return name.slice(index).toLowerCase()
}
