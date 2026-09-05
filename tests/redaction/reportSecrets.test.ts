/**
 * 这一期唯一一条「安全性」测试：**命中报告绝不携带原值。**
 *
 * 它单独一个文件，理由和 `tests/search/secrets.test.ts` 一样：别的测试挂了是功能不对，
 * 这个挂了是把用户的密钥送进了一个专门为了保护密钥而做的面板。混进功能测试里之后，
 * 没人知道删掉某个 `it` 意味着什么。
 *
 * 四条合起来才是一句完整的话：
 *   1. fixture 里那六个密钥确实在（否则下面全是空验）；
 *   2. 整份报告序列化之后一个本体都搜不到；
 *   3. 反面对照 —— 报告里确实有内容，而且每条上下文都是打过码的；
 *   4. `kept` 那一半也搜一遍：它的输入正是**没被打码的**那些值。
 * 最后一条盯的是另一件事：这份报告不进导出产物。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionLibrary } from '../../src/main/library'
import { LocalStore } from '../../src/main/storage/store'
import { renderExport } from '../../src/main/exporters'
import { DEFAULT_EXPORT_OPTIONS, REDACTION_PLACEHOLDER } from '../../src/shared/constants'
import type { ExportFormat, RedactionReport } from '../../src/shared/types'
import type { FileSystemAccess } from '../../src/main/scanner/fsAccess'
import { createFakeFs } from '../support/fakeFs'
import { testFixturePath } from '../support/fixtures'

const HOME = 'C:\\Users\\demo'
const ROOT = `${HOME}\\.codex`
const SESSION_FILE = `${ROOT}\\audit.jsonl`

/**
 * fixture 里那六个假密钥的本体，一条规则一个。
 *
 * 每一个都得**真的能被对应规则认出来**（否则这条测试在验一件没发生的事），同时本体
 * 不能短到会在别处偶然出现 —— 拿 `abc123` 当密钥本体的话，`not.toContain` 会因为一个
 * 无关的路径片段而挂掉，然后总有人为了让它绿而放宽断言。
 */
const FAKE_SECRETS: readonly string[] = [
  'sk-live-9XyZaBcDeFgH0123456789',
  'Kq7mZr2vT9wPbN4sXyLd',
  'c2VjcmV0LWJlYXJlci12YWx1ZS0wOTg3NjU',
  'Rt5vQx8LmNp3JhKw2ZbY',
  'Fake-Passphrase-For-Audit-42',
  'Wm5kQx7TpLvR2sHb'
]

/** 短于这个长度就不配当断言里的密钥本体：偶然撞上的概率不再可以忽略。 */
const MIN_SECRET_LENGTH = 16

/** `kept` 一行只许有这三样。多一个字段就是多一条把原值带出去的路。 */
const KEPT_FIELDS: readonly string[] = ['count', 'keyName', 'reason']

const FORMATS: readonly ExportFormat[] = ['markdown', 'html', 'json']

let storeDir: string
let fixture: string

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'gleam-report-secrets-'))
  fixture = await readFile(testFixturePath('redaction-audit.jsonl'), 'utf8')
})

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true })
})

/** 扫一遍只装着审计 fixture 的假文件系统。`homeDir` 对上 fixture 里的路径。 */
async function openFixture(): Promise<{ library: SessionLibrary; sessionId: string }> {
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

  const [summary] = await library.listSessions()
  if (!summary) throw new Error('审计 fixture 没有解析出会话')
  return { library, sessionId: summary.id }
}

async function auditFixture(): Promise<RedactionReport> {
  const { library, sessionId } = await openFixture()
  const report = await library.auditSession(sessionId)
  if (!report) throw new Error('审计没有产出报告')
  return report
}

describe('报告里没有原值', () => {
  it('那六个密钥确实在 fixture 里，而且都够长', () => {
    // 没有这一条，下面几条会在「fixture 被改过、密钥换了名字」之后静默变成空验：
    // 搜一个压根不存在的串，永远搜不到。
    for (const secret of FAKE_SECRETS) {
      expect(fixture, secret).toContain(secret)
      expect(secret.length, secret).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH)
    }
  })

  it('整份报告序列化之后，一个密钥本体都搜不到', async () => {
    const report = await auditFixture()
    // 搜的是**序列化之后的整个字符串**而不是逐个字段：将来给报告加字段是必然的，
    // 加了之后这条自动覆盖到，不用有人记得回来改它。
    const serialized = JSON.stringify(report)

    for (const secret of FAKE_SECRETS) {
      expect(serialized, secret).not.toContain(secret)
    }
  })

  it('反面对照：报告里确实有内容，每条上下文都打过码', async () => {
    // 只断言「不含密钥」的话，一份空报告也是绿的 —— 那就只证明了「报告是空的」。
    const report = await auditFixture()

    expect(report.totalHits).toBeGreaterThan(0)
    expect(report.groups.length).toBeGreaterThan(0)
    for (const group of report.groups) {
      for (const sample of group.samples) {
        expect(sample.maskedContext, group.rule).toContain(REDACTION_PLACEHOLDER)
      }
    }
  })

  it('kept 每一条只有键名、原因、计数三个字段', async () => {
    // 「被判为不是密钥」这一段的输入正是**没被打码的**那些值，最容易在这里把原值
    // 带出去。所以不是搜一遍了事，而是把字段集合本身钉死。
    const report = await auditFixture()

    expect(report.kept.length).toBeGreaterThan(0)
    for (const entry of report.kept) {
      expect(Object.keys(entry).sort(), entry.keyName).toEqual(KEPT_FIELDS)
    }
  })
})

describe('审计结果不进导出产物', () => {
  it('三种格式各导一次，都没有这份报告的任何痕迹', async () => {
    const { library, sessionId } = await openFixture()
    const session = await library.getSession(sessionId)
    if (!session) throw new Error('会话打不开')

    for (const format of FORMATS) {
      const { content } = renderExport({
        session,
        format,
        options: DEFAULT_EXPORT_OPTIONS,
        homeDir: HOME,
        platform: 'win32',
        now: new Date('2026-09-04T09:30:00.000Z')
      })

      // B4 要往导出里加汇总计数时会先撞到这两条，那时它该被改成「只允许计数进去」
      // —— 这正是我们希望那次改动被人看见的方式。
      expect(content, format).not.toContain('redactionReport')
      expect(content, format).not.toContain('打掉了什么')
    }
  })
})
