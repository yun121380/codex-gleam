// 构建期脚本：把"这份包是怎么造出来的"固化成一个 JSON，随包发出去。
// B3 的离线自检页读它；读不到就显示"开发模式，构建期证据不可用"。
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OUT_DIR = join('build', 'generated')
const OUT_FILE = join(OUT_DIR, 'build-evidence.json')

/**
 * 跑一个命令并拿它的 stdout。失败一律返回 null —— 拿不到就说拿不到。
 *
 * Windows 上 pnpm 是一个 .cmd 批处理，而 Node 18.20 / 20.12 起
 * 禁止在 shell:false 下 spawn .bat/.cmd（CVE-2024-27980），
 * 所以那边必须开 shell。这里的 args 全是源码里写死的字面量，
 * 没有任何外部输入拼进命令行。
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {string | null}
 */
function capture(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: 'pipe',
      shell: process.platform === 'win32',
      // vitest 会把每个测试文件都打出来，默认 1 MB 的 maxBuffer 不一定够；
      // 超了会抛 ENOBUFS，那就白白把 testCount 变成 null。
      maxBuffer: 64 * 1024 * 1024
    })
  } catch {
    return null
  }
}

/** @param {{gitSha: string | null; testCount: number | null; platform: string; builtAt: string}} input */
export function buildEvidence(input) {
  return {
    schemaVersion: 1,
    gitSha: input.gitSha,
    testCount: input.testCount,
    platform: input.platform,
    builtAt: input.builtAt
  }
}

function readGitSha() {
  return capture('git', ['rev-parse', 'HEAD'])?.trim() ?? null
}

/** 从 `pnpm test` 的输出里抓 vitest 的 "Tests  N passed" 行。抓不到返回 null。 */
function readTestCount() {
  const output = capture('pnpm', ['test'])
  if (output === null) return null
  const match = /Tests\s+(\d+)\s+passed/.exec(output)
  return match ? Number(match[1]) : null
}

export async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const evidence = buildEvidence({
    gitSha: process.env.GITHUB_SHA ?? readGitSha(),
    testCount: readTestCount(),
    platform: process.platform,
    builtAt: new Date().toISOString()
  })
  await writeFile(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write(`build evidence → ${OUT_FILE}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('buildEvidence.mjs')) {
  await main()
}
