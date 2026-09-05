// 构建期脚本：把"这份包是怎么造出来的"固化成一个 JSON，随包发出去。
// B3 的离线自检页读它；读不到就显示"开发模式，构建期证据不可用"。
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OUT_DIR = join('build', 'generated')
const OUT_FILE = join(OUT_DIR, 'build-evidence.json')

// vitest 在 CI 上会给输出上色，`Tests` 和数字之间夹着 ANSI 转义序列，
// 不剥掉的话 \s+ 匹配不上。ESC 用 fromCharCode 拼出来，
// 免得源码里出现一个看不见的控制字符（eslint 的 no-control-regex 也会拦）。
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

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
  } catch (error) {
    // 拿不到就说拿不到 —— 但也要说清为什么。以前这里是个光秃秃的 catch，
    // 结果 CI 上打出来的包里 testCount 是 null，构建日志里却一个字都没有，
    // 完全没法追。字段照旧记 null，原因写到 stderr（也就是构建日志）里。
    process.stderr.write(
      `build evidence: \`${command} ${args.join(' ')}\` 没跑成，相关字段记为 null —— ${
        error instanceof Error ? error.message : String(error)
      }\n`
    )
    const childStderr = error && typeof error === 'object' ? error.stderr : null
    if (childStderr) process.stderr.write(`${tail(String(childStderr), 20)}\n`)
    return null
  }
}

/** 取一段文本的最后 n 行，用来把子进程的输出摘进日志。 */
function tail(text, n) {
  return text.trimEnd().split(/\r?\n/).slice(-n).join('\n')
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
  const plain = output.replace(ANSI, '')
  const match = /Tests\s+(\d+)\s+passed/.exec(plain)
  if (!match) {
    process.stderr.write(
      'build evidence: `pnpm test` 跑通了，但输出里找不到 "Tests N passed"，testCount 记为 null。输出末尾：\n'
    )
    process.stderr.write(`${tail(plain, 15)}\n`)
    return null
  }
  return Number(match[1])
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
