import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionLibrary } from '../../src/main/library'
import { LocalStore } from '../../src/main/storage/store'
import type { FileSystemAccess } from '../../src/main/scanner/fsAccess'
import type { KeptReason, RedactionHit, RedactionReport } from '../../src/shared/types'
import { createFakeFs } from '../support/fakeFs'
import { testFixturePath } from '../support/fixtures'

/**
 * 审计这条只读路径。
 *
 * 这个面板的用处全押在一件事上：它说的必须是**这一次分享真的会打掉什么**。
 * 所以这里盯五件事：
 *   1. 审计跑在**原始**会话上 —— 搭到 `getSession` 的出口上的话，报告会是一片干净的 0；
 *   2. 报告里的路径和界面上看到的一样，否则面板上冒出用户名而列表里全是 `~`；
 *   3. 打码开关关着时照样审计，并且报告里说清了开关是关的；
 *   4. 「哪个会话里有几个密钥」这句话不落盘；
 *   5. 会话不存在返回 `null`，不是一份「很干净」的空报告。
 */

const HOME = 'C:\\Users\\demo'
const ROOT = `${HOME}\\.codex`
const SESSION_FILE = `${ROOT}\\audit.jsonl`
const ENV_PATH = `${HOME}\\projects\\gleam-audit\\.env`

/** fixture 里那几个假密钥的本体。词形照着真的写，值全是编的。 */
const FAKE_SECRETS: readonly string[] = [
  'sk-live-9XyZaBcDeFgH0123456789',
  'Kq7mZr2vT9wPbN4sXyLd',
  'c2VjcmV0LWJlYXJlci12YWx1ZS0wOTg3NjU',
  'Rt5vQx8LmNp3JhKw2ZbY',
  'Fake-Passphrase-For-Audit-42',
  'Wm5kQx7TpLvR2sHb'
]

const [FAKE_KEY] = FAKE_SECRETS

/** 六种命中、五种排除，一份 fixture 里全齐 —— 这就是「审计完整」的定义。 */
const SIX_RULES: readonly string[] = [
  'known-secret:openai',
  'cookie-line',
  'auth-scheme',
  'cli-flag',
  'key-value',
  'sensitive-key'
]

const FIVE_REASONS: readonly KeptReason[] = [
  'name-not-matched',
  'metric-name',
  'value-too-short',
  'value-is-template',
  'value-not-secret'
]

let storeDir: string
let fixture: string

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'gleam-audit-'))
  fixture = await readFile(testFixturePath('redaction-audit.jsonl'), 'utf8')
})

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true })
})

/** 扫一遍只装着审计 fixture 的假文件系统。`homeDir` 对上 fixture 里的路径。 */
async function makeLibrary(): Promise<SessionLibrary> {
  const fs: FileSystemAccess = createFakeFs({ [SESSION_FILE]: fixture })
  const library = new SessionLibrary({
    store: new LocalStore(storeDir),
    fs,
    platform: 'win32',
    env: { USERPROFILE: HOME },
    homeDir: HOME,
    sampleDir: null
  })
  await library.init()
  await library.updateSettings({ useBuiltinDirs: false, extraScanDirs: [ROOT] })
  await library.scan(undefined, () => {})
  return library
}

/** fixture 里只有一个会话，取它的 id。 */
async function onlySessionId(library: SessionLibrary): Promise<string> {
  const sessions = await library.listSessions()
  expect(sessions).toHaveLength(1)
  const [summary] = sessions
  if (!summary) throw new Error('审计 fixture 没有解析出会话')
  return summary.id
}

function samplesOf(report: RedactionReport): RedactionHit[] {
  return report.groups.flatMap((group) => group.samples)
}

/** 存储目录的现状：文件名 + 修改时间 + 大小。任何一处变了，这行字符串就变了。 */
async function snapshotStore(): Promise<string[]> {
  const names = await readdir(storeDir, { recursive: true })
  const rows: string[] = []
  for (const name of [...names].map(String).sort()) {
    const info = await stat(join(storeDir, name))
    if (!info.isFile()) continue
    rows.push(`${name} ${info.mtimeMs} ${info.size}`)
  }
  return rows
}

describe('审计跑在原始会话上', () => {
  it('会话已经打开过（缓存是热的），审计照样找得到东西', async () => {
    const library = await makeLibrary()
    const sessionId = await onlySessionId(library)
    // 先按界面上的顺序来一次：打开会话 → 再点盾牌。
    await library.getSession(sessionId)

    const report = await library.auditSession(sessionId)

    expect(report).not.toBeNull()
    expect(report?.sessionId).toBe(sessionId)
    expect(report?.redactEnabled).toBe(true)
    // 掉到 0 的意思是审计搭在了 getSession 的出口上 —— 在一份已经打过码的会话上
    // 审计，什么都找不到，而面板会理直气壮地说「很干净」。
    expect(report?.totalHits).toBeGreaterThan(0)
  })

  it('六种命中、五种排除，一份 fixture 里全齐', async () => {
    const library = await makeLibrary()
    const report = await library.auditSession(await onlySessionId(library))
    if (!report) throw new Error('审计没有产出报告')

    for (const rule of SIX_RULES) {
      const group = report.groups.find((item) => item.rule === rule)
      expect(group?.count, rule).toBeGreaterThan(0)
      expect(group?.samples.length, rule).toBeGreaterThan(0)
    }
    for (const reason of FIVE_REASONS) {
      expect(
        report.kept.some((item) => item.reason === reason),
        reason
      ).toBe(true)
    }
  })

  it('报告里一个密钥本体都没有', async () => {
    // 上下文是从**终稿**上切的，所以「隔壁那处还没轮到打码」的值也进不来。
    const library = await makeLibrary()
    const report = await library.auditSession(await onlySessionId(library))
    const serialized = JSON.stringify(report)

    for (const secret of FAKE_SECRETS) {
      expect(serialized, secret).not.toContain(secret)
    }
  })
})

describe('报告里的路径和界面上看到的一样', () => {
  it('关着「显示完整路径」时（默认），上下文里的家目录换成了 ~', async () => {
    const library = await makeLibrary()
    const report = await library.auditSession(await onlySessionId(library))
    const contexts = samplesOf(report!).map((sample) => sample.maskedContext)

    expect(contexts.some((text) => text.includes('~\\projects\\gleam-audit\\.env'))).toBe(true)
    // raw 里那份路径是 JSON 转义过的双反斜杠，跟这里的单层分隔符不是一个串。
    for (const text of contexts) expect(text).not.toContain(`${HOME}\\projects`)
  })

  it('打开「显示完整路径」时，上下文原样保留', async () => {
    const library = await makeLibrary()
    await library.updateSettings({ showFullPaths: true })

    const report = await library.auditSession(await onlySessionId(library))
    const contexts = samplesOf(report!).map((sample) => sample.maskedContext)

    expect(contexts.some((text) => text.includes(ENV_PATH))).toBe(true)
  })
})

describe('打码开关关着的时候', () => {
  it('正文里密钥是原样的，而报告照样算得出来', async () => {
    const library = await makeLibrary()
    await library.updateSettings({ redactSensitive: false })
    const sessionId = await onlySessionId(library)

    const detail = await library.getSession(sessionId)
    const texts = (detail?.events ?? []).flatMap((event) => [
      event.title,
      event.content,
      event.command ?? ''
    ])
    // 这正是开关关着的语义：界面上看到的是原文。
    expect(texts.some((text) => text.includes(FAKE_KEY!))).toBe(true)

    const report = await library.auditSession(sessionId)

    // 开关是报告里的一个字段，不是审计的开关。这时候这份报告的意思是
    // 「你现在要分享的是原文，打开开关会打掉这些」—— 那正是最该看它的时刻。
    expect(report?.redactEnabled).toBe(false)
    expect(report?.totalHits).toBeGreaterThan(0)
  })
})

describe('报告是算出来就扔的', () => {
  it('审计前后，存储目录一个字节都没变', async () => {
    const library = await makeLibrary()
    const sessionId = await onlySessionId(library)
    await library.getSession(sessionId)

    const before = await snapshotStore()
    const report = await library.auditSession(sessionId)
    expect(report?.totalHits).toBeGreaterThan(0)

    // 「哪个会话里有几个密钥」这句话不该出现在磁盘上任何地方。
    expect(await snapshotStore()).toEqual(before)
  })
})

describe('会话不存在', () => {
  it('返回 null，不是一份「很干净」的空报告', async () => {
    const library = await makeLibrary()

    // 空报告的意思是「这个会话里没有密钥」，那是另一件事，面板上是另一句话。
    await expect(library.auditSession('no-such-session')).resolves.toBeNull()
  })
})
