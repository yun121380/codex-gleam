import { open, readdir, stat } from 'node:fs/promises'

/**
 * 文件系统访问被抽象成接口，原因有两个：
 *   1. 测试可以注入虚拟文件系统，不需要真实文件；
 *   2. 强制所有读取都走"有上限"的入口，避免把大文件整块塞进内存。
 *
 * 这里只有"读"，没有任何写、删、移动或执行能力。
 */

export interface DirEntryLike {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface StatLike {
  size: number
  mtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
}

export interface LineChunk {
  line: string
  index: number
  bytesConsumed: number
}

export interface StreamLineOptions {
  maxLines: number
  maxBytes: number
}

export interface ReadTextResult {
  text: string
  truncated: boolean
  bytesRead: number
}

export interface FileSystemAccess {
  readDirectory(dir: string): Promise<DirEntryLike[]>
  statPath(target: string): Promise<StatLike>
  /** 只读取文件开头若干字节，用于指纹识别。 */
  readHead(target: string, maxBytes: number): Promise<string>
  /** 逐行流式读取，命中行数或字节上限即停止。 */
  streamLines(target: string, options: StreamLineOptions): AsyncGenerator<LineChunk>
  /** 读取整份文本，超过上限时截断并标记 truncated。 */
  readText(target: string, maxBytes: number): Promise<ReadTextResult>
}

const READ_CHUNK_BYTES = 256 * 1024

export const nodeFileSystem: FileSystemAccess = {
  async readDirectory(dir) {
    return readdir(dir, { withFileTypes: true })
  },

  async statPath(target) {
    return stat(target)
  },

  async readHead(target, maxBytes) {
    const handle = await open(target, 'r')
    try {
      const size = Math.max(0, Math.min(maxBytes, READ_CHUNK_BYTES * 8))
      const buffer = Buffer.allocUnsafe(size)
      const { bytesRead } = await handle.read(buffer, 0, size, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  },

  async *streamLines(target, options) {
    const handle = await open(target, 'r')
    try {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      // 分块读取时，一个多字节字符（比如中文）可能正好跨在两块之间。
      // 逐块调用 toString('utf8') 会把它切成两半、变成乱码；
      // TextDecoder 的 stream 模式会把不完整的字节留到下一块，不会破坏字符。
      const decoder = new TextDecoder('utf-8')
      let pending = ''
      let position = 0
      let emitted = 0
      let totalBytes = 0

      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, position)
        if (bytesRead === 0) break
        position += bytesRead
        totalBytes += bytesRead
        pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true })

        let newlineIndex = pending.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = pending.slice(0, newlineIndex).replace(/\r$/, '')
          pending = pending.slice(newlineIndex + 1)
          yield { line, index: emitted, bytesConsumed: totalBytes }
          emitted += 1
          if (emitted >= options.maxLines) return
          newlineIndex = pending.indexOf('\n')
        }

        if (totalBytes >= options.maxBytes) break
      }

      // 冲掉解码器里可能残留的最后几个字节。
      pending += decoder.decode()

      if (pending.trim() !== '' && emitted < options.maxLines) {
        yield { line: pending.replace(/\r$/, ''), index: emitted, bytesConsumed: totalBytes }
      }
    } finally {
      await handle.close()
    }
  },

  async readText(target, maxBytes) {
    const handle = await open(target, 'r')
    try {
      const info = await handle.stat()
      const limit = Math.min(info.size, maxBytes)
      const chunks: Buffer[] = []
      let position = 0

      while (position < limit) {
        const size = Math.min(READ_CHUNK_BYTES, limit - position)
        const buffer = Buffer.allocUnsafe(size)
        const { bytesRead } = await handle.read(buffer, 0, size, position)
        if (bytesRead === 0) break
        chunks.push(buffer.subarray(0, bytesRead))
        position += bytesRead
      }

      return {
        text: Buffer.concat(chunks).toString('utf8'),
        truncated: info.size > maxBytes,
        bytesRead: position
      }
    } finally {
      await handle.close()
    }
  }
}
