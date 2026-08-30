import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CodexSession, ScanIssue } from '../../src/shared/types'
import { fingerprintSample } from '../../src/main/scanner/fingerprint'
import { nodeFileSystem } from '../../src/main/scanner/fsAccess'
import { FINGERPRINT_HEAD_BYTES } from '../../src/shared/constants'
import { loadSessionsFromFile } from '../../src/main/parsers/loadSession'

export const FIXTURES_DIR = resolve(__dirname, '../../fixtures')
export const TEST_FIXTURES_DIR = resolve(__dirname, '../fixtures')

export function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name)
}

export function testFixturePath(name: string): string {
  return join(TEST_FIXTURES_DIR, name)
}

/** 用真实文件系统跑一遍完整解析流程，返回会话与问题列表。 */
export async function loadFixture(
  filePath: string
): Promise<{ sessions: CodexSession[]; issues: ScanIssue[] }> {
  const info = await stat(filePath)
  const head = await nodeFileSystem.readHead(filePath, FINGERPRINT_HEAD_BYTES)
  const fingerprint = fingerprintSample(head, filePath)

  return loadSessionsFromFile({
    filePath,
    fileSizeBytes: info.size,
    modifiedMs: info.mtimeMs,
    fs: nodeFileSystem,
    fingerprint,
    homeDir: 'C:\\Users\\demo',
    platform: 'win32'
  })
}

export async function loadFixtureSession(name: string): Promise<CodexSession> {
  const { sessions } = await loadFixture(fixturePath(name))
  const session = sessions[0]
  if (!session) throw new Error(`示例文件 ${name} 没有解析出任何会话`)
  return session
}
