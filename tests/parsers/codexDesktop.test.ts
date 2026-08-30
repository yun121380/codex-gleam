import { stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { FINGERPRINT_HEAD_BYTES } from '../../src/shared/constants'
import { loadSessionsFromFile } from '../../src/main/parsers/loadSession'
import { injectedContextTag } from '../../src/main/parsers/normalize'
import { fingerprintSample } from '../../src/main/scanner/fingerprint'
import { nodeFileSystem } from '../../src/main/scanner/fsAccess'
import type { ThreadTitles } from '../../src/main/scanner/threadTitles'
import type { CodexSession } from '../../src/shared/types'
import { testFixturePath } from '../support/fixtures'

/**
 * Codex Desktop 的滚动日志。这份 fixture 照着真实文件的形状写：
 *   - 开场先以 role=user 注入一段 `<recommended_plugins>`；
 *   - 同一句用户消息经两条通道各记一遍，中间隔着思考、回复和两条 turn_context；
 *   - 后面用户又真的把同一句话说了一遍（相隔近两分钟）。
 */
const FIXTURE = 'codex-desktop-rollout-01a04d76-bd47-7442-8c98-addbed920f33.jsonl'

async function loadDesktopSession(threadTitles?: ThreadTitles): Promise<CodexSession> {
  const filePath = testFixturePath(FIXTURE)
  const info = await stat(filePath)
  const head = await nodeFileSystem.readHead(filePath, FINGERPRINT_HEAD_BYTES)

  const { sessions } = await loadSessionsFromFile({
    filePath,
    fileSizeBytes: info.size,
    modifiedMs: info.mtimeMs,
    fs: nodeFileSystem,
    fingerprint: fingerprintSample(head, filePath),
    homeDir: 'C:\\Users\\demo',
    platform: 'win32',
    ...(threadTitles === undefined ? {} : { threadTitles })
  })

  const session = sessions[0]
  if (!session) throw new Error('fixture 没有解析出会话')
  return session
}

describe('认出 Codex 自己注入的上下文', () => {
  it('整段被 snake_case 标签包住的文本算注入内容', () => {
    expect(injectedContextTag('<recommended_plugins>\n…\n</recommended_plugins>')).toBe(
      'recommended_plugins'
    )
    expect(injectedContextTag('  <environment_context>x</environment_context>')).toBe(
      'environment_context'
    )
  })

  it('人写的消息不会被误判 —— 哪怕里面带尖括号', () => {
    expect(injectedContextTag('帮我看看 a < b 这个判断')).toBeNull()
    expect(injectedContextTag('用 <div> 包一层就行')).toBeNull()
    expect(injectedContextTag('')).toBeNull()
  })

  it('只有开标签、没有闭标签的不算（那多半是用户在讲代码）', () => {
    expect(injectedContextTag('<recommended_plugins> 这个标签是干嘛的？')).toBeNull()
  })

  it('注入的上下文不再冒充「你说」', async () => {
    const session = await loadDesktopSession()
    const userTexts = session.events
      .filter((event) => event.type === 'user_message')
      .map((event) => event.content)

    expect(userTexts.some((text) => text.includes('<recommended_plugins>'))).toBe(false)
    expect(userTexts.some((text) => text.includes('<environment_context>'))).toBe(false)
  })
})

describe('Codex Desktop 会话的标题', () => {
  it('不再是开场注入的 <recommended_plugins>', async () => {
    const session = await loadDesktopSession()
    expect(session.title).not.toContain('recommended_plugins')
  })

  it('回退到第一条真正是人说的消息', async () => {
    const session = await loadDesktopSession()
    expect(session.title).toBe('帮我梳理一下这个项目的目录结构')
  })

  it('Codex 自己给的会话名优先于从消息里猜', async () => {
    const titles: ThreadTitles = new Map([
      ['01a04d76-bd47-7442-8c98-addbed920f33', '构思 Codex 生态助力项目']
    ])
    const session = await loadDesktopSession(titles)
    expect(session.title).toBe('构思 Codex 生态助力项目')
  })

  it('索引里没有这个会话时不受影响', async () => {
    const titles: ThreadTitles = new Map([['00000000-0000-0000-0000-000000000000', '别的会话']])
    const session = await loadDesktopSession(titles)
    expect(session.title).toBe('帮我梳理一下这个项目的目录结构')
  })
})

describe('两条通道写同一句话时只留一份', () => {
  it('隔着思考、回复和 turn_context 的镜像记录也能合并', async () => {
    const session = await loadDesktopSession()
    const users = session.events.filter((event) => event.type === 'user_message')

    // 文件里这句话出现了三次：两次是同一瞬间的镜像，第三次是用户两分钟后真的又说了一遍。
    expect(users).toHaveLength(2)
  })

  it('用户隔了一会儿真的重复说同一句话，两次都保留', async () => {
    const session = await loadDesktopSession()
    const repeated = session.events.filter(
      (event) => event.type === 'user_message' && event.content.includes('目录结构')
    )

    expect(repeated).toHaveLength(2)
    expect(repeated[0]?.timestamp).toBe('2026-08-29T12:20:55.988Z')
    expect(repeated[1]?.timestamp).toBe('2026-08-29T12:22:51.783Z')
  })

  it('助手回复的镜像同样只留一份', async () => {
    const session = await loadDesktopSession()
    const replies = session.events.filter((event) => event.type === 'assistant_message')

    expect(replies.map((event) => event.content)).toEqual([
      '我先把方向收敛成一个能落地的项目。',
      '好，这次我换一个角度重新想。'
    ])
  })
})
