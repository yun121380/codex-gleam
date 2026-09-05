// 构建期脚本：把完整依赖树落成 JSON，既进构建日志也进安装包。
// spec 3.4：「把完整依赖树打进构建日志并作为构建产物保存，供离线自检页展示」。
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const OUT_DIR = join('build', 'generated')
const OUT_FILE = join(OUT_DIR, 'dependency-tree.json')

function readTree() {
  try {
    const output = execFileSync('pnpm', ['list', '--json', '--depth', 'Infinity'], {
      encoding: 'utf8',
      stdio: 'pipe',
      // Windows 上 pnpm 是 .cmd，shell:false 下不允许 spawn；
      // 理由与 buildEvidence.mjs 的 capture() 相同，args 全是写死的字面量。
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024
    })
    return JSON.parse(output)
  } catch {
    return null
  }
}

/**
 * pnpm list 会把每个包的绝对路径写进来，里面带着这台机器的用户名。
 * 这份 JSON 既随安装包发出（extraResources），也作为 CI 产物上传 ——
 * 本地打的包不该把打包者的用户名一起发出去。
 * 与导出功能的「不显示完整路径」是同一条规矩：用户目录一律写成 ~。
 *
 * 在序列化之后的文本上替换，这样不用管路径出现在哪个字段里。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripHome(text) {
  const home = homedir()
  if (!home) return text
  // JSON 文本里 Windows 路径的反斜杠是转义过的（C:\\Users\\…），
  // 所以先换转义形态，再换原始形态；posix 上两者相同，第二次替换是空操作。
  const escaped = JSON.stringify(home).slice(1, -1)
  return text.split(escaped).join('~').split(home).join('~')
}

export async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const tree = readTree()
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tree
  }
  await writeFile(OUT_FILE, stripHome(`${JSON.stringify(payload, null, 2)}\n`), 'utf8')
  // 同时打进构建日志。
  process.stdout.write(`${stripHome(JSON.stringify(payload))}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('dependencyTree.mjs')) {
  await main()
}
