import type {
  DirEntryLike,
  FileSystemAccess,
  LineChunk,
  ReadTextResult,
  StatLike,
  StreamLineOptions
} from '../../src/main/scanner/fsAccess'

/**
 * 测试用的虚拟文件系统。
 *
 * 扫描器把文件访问抽象成接口，正是为了让这些规则（深度、忽略目录、大小上限）
 * 能用纯内存的目录树来验证，不需要在磁盘上真的造一堆文件。
 */

export interface FakeFileSpec {
  content?: string
  size?: number
  mtimeMs?: number
}

export interface FakeFsOptions {
  /** 读取这些目录时抛出的错误码，用于测试权限不足等情况。 */
  errors?: Record<string, string>
}

function normalize(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

class FakeError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

function entry(name: string, kind: 'file' | 'dir'): DirEntryLike {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false
  }
}

export function createFakeFs(
  files: Record<string, FakeFileSpec | string>,
  options: FakeFsOptions = {}
): FileSystemAccess {
  const fileMap = new Map<string, { spec: FakeFileSpec; original: string }>()
  const dirChildren = new Map<string, Map<string, 'file' | 'dir'>>()

  const ensureDir = (dir: string): Map<string, 'file' | 'dir'> => {
    const key = normalize(dir)
    let children = dirChildren.get(key)
    if (!children) {
      children = new Map()
      dirChildren.set(key, children)
    }
    return children
  }

  for (const [rawPath, rawSpec] of Object.entries(files)) {
    const spec = typeof rawSpec === 'string' ? { content: rawSpec } : rawSpec
    const path = rawPath.replace(/\//g, '\\')
    fileMap.set(normalize(path), { spec, original: path })

    const segments = path.split('\\')
    const fileName = segments.pop() ?? ''
    ensureDir(segments.join('\\')).set(fileName, 'file')

    // 逐级把父目录登记到祖父目录里。
    while (segments.length > 1) {
      const name = segments.pop() ?? ''
      ensureDir(segments.join('\\')).set(name, 'dir')
    }
  }

  const errorCodes = new Map(
    Object.entries(options.errors ?? {}).map(([path, code]) => [normalize(path), code])
  )

  const sizeOf = (spec: FakeFileSpec): number =>
    spec.size ?? Buffer.byteLength(spec.content ?? '', 'utf8')

  return {
    async readDirectory(dir: string): Promise<DirEntryLike[]> {
      const key = normalize(dir)
      const forcedError = errorCodes.get(key)
      if (forcedError) throw new FakeError(`fake error for ${dir}`, forcedError)

      const children = dirChildren.get(key)
      if (!children) throw new FakeError(`no such directory: ${dir}`, 'ENOENT')
      return [...children.entries()].map(([name, kind]) => entry(name, kind))
    },

    async statPath(target: string): Promise<StatLike> {
      const key = normalize(target)
      const file = fileMap.get(key)
      if (file) {
        return {
          size: sizeOf(file.spec),
          mtimeMs: file.spec.mtimeMs ?? Date.UTC(2026, 7, 24, 9, 0, 0),
          isFile: () => true,
          isDirectory: () => false
        }
      }
      if (dirChildren.has(key)) {
        return {
          size: 0,
          mtimeMs: Date.UTC(2026, 7, 24, 9, 0, 0),
          isFile: () => false,
          isDirectory: () => true
        }
      }
      throw new FakeError(`no such file: ${target}`, 'ENOENT')
    },

    async readHead(target: string, maxBytes: number): Promise<string> {
      const file = fileMap.get(normalize(target))
      if (!file) throw new FakeError(`no such file: ${target}`, 'ENOENT')
      return (file.spec.content ?? '').slice(0, maxBytes)
    },

    async *streamLines(target: string, streamOptions: StreamLineOptions): AsyncGenerator<LineChunk> {
      const file = fileMap.get(normalize(target))
      if (!file) throw new FakeError(`no such file: ${target}`, 'ENOENT')

      const lines = (file.spec.content ?? '').split(/\r?\n/)
      let bytes = 0
      for (let index = 0; index < lines.length; index += 1) {
        if (index >= streamOptions.maxLines) return
        const line = lines[index] ?? ''
        bytes += Buffer.byteLength(line, 'utf8') + 1
        yield { line, index, bytesConsumed: bytes }
        if (bytes >= streamOptions.maxBytes) return
      }
    },

    async readText(target: string, maxBytes: number): Promise<ReadTextResult> {
      const file = fileMap.get(normalize(target))
      if (!file) throw new FakeError(`no such file: ${target}`, 'ENOENT')
      const content = file.spec.content ?? ''
      const full = Buffer.from(content, 'utf8')
      const truncated = full.byteLength > maxBytes
      return {
        text: truncated ? full.subarray(0, maxBytes).toString('utf8') : content,
        truncated,
        bytesRead: Math.min(full.byteLength, maxBytes)
      }
    }
  }
}
