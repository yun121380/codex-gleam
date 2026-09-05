// 构建期脚本：给发布产物算 SHA-256。
// 只在 CI 与本地打包时运行，不属于应用源码（src/ 下不允许出现构建期依赖）。
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

/**
 * 对 dir 下后缀命中 patterns 的文件算 SHA-256，写成 sha256sum 兼容格式。
 *
 * @param {string} dir 产物目录
 * @param {string} outFile 输出文件路径
 * @param {string[]} patterns 要收录的后缀，例如 ['.exe', '.zip']
 * @returns {Promise<string>} 写入的文本
 */
export async function writeSums(dir, outFile, patterns) {
  const entries = await readdir(dir, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isFile() && patterns.includes(extname(entry.name)))
    .map((entry) => entry.name)
    .sort()

  if (names.length === 0) {
    throw new Error(`没有找到可校验的产物：${dir}（后缀 ${patterns.join(' ')}）`)
  }

  const lines = []
  for (const name of names) {
    const buffer = await readFile(join(dir, name))
    const digest = createHash('sha256').update(buffer).digest('hex')
    lines.push(`${digest}  ${name}`)
  }

  const text = `${lines.join('\n')}\n`
  await writeFile(outFile, text, 'utf8')
  return text
}

const DEFAULT_PATTERNS = ['.exe', '.zip', '.dmg', '.AppImage', '.deb', '.rpm', '.snap']

if (process.argv[1] && process.argv[1].endsWith('sha256sums.mjs')) {
  const [, , dir = 'release', outFile = 'release/SHA256SUMS.txt'] = process.argv
  const text = await writeSums(dir, outFile, DEFAULT_PATTERNS)
  process.stdout.write(text)
}
