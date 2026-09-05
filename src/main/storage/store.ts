import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings, SessionSummary } from '@shared/types'
import { normalizeSettings, safeJsonParse } from '@shared/validators'

/**
 * 本地存储。
 *
 * 只有三个 JSON 文件，全部放在系统的应用数据目录里：
 *   settings.json      —— 用户设置
 *   session-index.json —— 会话索引（只有摘要，不含事件内容，体积很小）
 *   app-state.json     —— 是否已完成首次引导
 *
 * 没有数据库、没有远程同步。删掉这个目录就等于恢复出厂设置。
 */

const SETTINGS_FILE = 'settings.json'
const INDEX_FILE = 'session-index.json'
const STATE_FILE = 'app-state.json'

interface AppState {
  firstRunCompleted: boolean
  lastScanAt: string | null
}

const DEFAULT_STATE: AppState = { firstRunCompleted: false, lastScanAt: null }

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(filePath, 'utf8')
    const parsed = safeJsonParse<T>(text)
    return parsed.ok ? parsed.value : fallback
  } catch {
    return fallback
  }
}

let temporaryCounter = 0

/**
 * 先写临时文件再改名，避免写到一半崩溃留下损坏的 JSON。
 *
 * 临时文件名必须唯一。原来固定叫 `<文件名>.tmp`，于是两次并发写同一个文件会
 * 抢同一个临时文件：后一个的 rename 发现它已经被前一个改走了，直接 ENOENT。
 * 带上进程号和序号之后，两个应用实例同时写、或上次崩溃留下残骸，都不会互相干扰。
 *
 * 调用方注意：**缓存要等这个函数成功返回之后再更新**。
 * 反过来写（先改缓存再落盘）的话，磁盘满了、目录没权限、文件被占用时，
 * 内存里已经是新值、磁盘上还是旧值，而且再也没人会去纠正它 ——
 * 后续 getSettings() 拿到的是那个从没存下来的值，用户以为改好了，
 * 下次开应用又变回去，且没有任何迹象说明发生了什么。
 */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  temporaryCounter += 1
  const temporary = `${filePath}.${process.pid}.${temporaryCounter}.tmp`

  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, filePath)
  } catch (error) {
    // 别把写了一半的临时文件留在磁盘上。
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * 按文件排队，一个文件同一时刻只有一个"读—改—写"在跑。
 *
 * 这不是理论上的并发：设置页的滑块每动一下就调一次 updateSettings，
 * 实测 100 次并发写设置有 96 次因为临时文件互相抢占而失败。
 * 唯一临时文件名能治好报错，但治不了"两个调用各自读到同一份旧值、
 * 后写的把先写的覆盖掉"——那需要把整段读改写都圈进队列。
 *
 * 表是模块级的：同一个目录被两个 LocalStore 实例打开时也照样串行。
 */
const writeQueues = new Map<string, Promise<unknown>>()

function enqueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve()
  // 前一次失败不该把后面排队的全堵死，所以成功失败都照样往下走。
  const result = previous.then(
    () => task(),
    () => task()
  )

  // 队列排空后把这条记录删掉，免得每个用过的目录都在表里留一份。
  const tail: Promise<unknown> = result.then(
    () => {
      if (writeQueues.get(filePath) === tail) writeQueues.delete(filePath)
    },
    () => {
      if (writeQueues.get(filePath) === tail) writeQueues.delete(filePath)
    }
  )
  writeQueues.set(filePath, tail)

  return result
}

export class LocalStore {
  private settingsCache: AppSettings | null = null
  private indexCache: SessionSummary[] | null = null
  private stateCache: AppState | null = null

  constructor(private readonly rootDir: string) {}

  get directory(): string {
    return this.rootDir
  }

  private path(fileName: string): string {
    return join(this.rootDir, fileName)
  }

  async getSettings(): Promise<AppSettings> {
    if (this.settingsCache) return this.settingsCache
    const raw = await readJson<unknown>(this.path(SETTINGS_FILE), DEFAULT_SETTINGS)
    this.settingsCache = normalizeSettings(raw)
    return this.settingsCache
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const file = this.path(SETTINGS_FILE)
    // 读旧值也要在队列里：否则两个并发调用会各自读到同一份旧值，后写的丢掉先写的补丁。
    return enqueue(file, async () => {
      const current = await this.getSettings()
      const next = normalizeSettings({ ...current, ...patch })
      // 先落盘再更新缓存，见 writeJsonAtomic 上方那段。
      await writeJsonAtomic(file, next)
      this.settingsCache = next
      return next
    })
  }

  async getIndex(): Promise<SessionSummary[]> {
    if (this.indexCache) return this.indexCache
    const raw = await readJson<unknown>(this.path(INDEX_FILE), [])
    this.indexCache = Array.isArray(raw)
      ? raw.filter(isSummaryLike).map((entry) => withDefaults(entry as SessionSummary))
      : []
    return this.indexCache
  }

  async saveIndex(sessions: readonly SessionSummary[]): Promise<SessionSummary[]> {
    const file = this.path(INDEX_FILE)
    const next = [...sessions]
    await enqueue(file, () => writeJsonAtomic(file, next))
    this.indexCache = next
    return next
  }

  async getState(): Promise<AppState> {
    if (this.stateCache) return this.stateCache
    const raw = await readJson<Partial<AppState>>(this.path(STATE_FILE), DEFAULT_STATE)
    this.stateCache = {
      firstRunCompleted: raw?.firstRunCompleted === true,
      lastScanAt: typeof raw?.lastScanAt === 'string' ? raw.lastScanAt : null
    }
    return this.stateCache
  }

  async updateState(patch: Partial<AppState>): Promise<AppState> {
    const file = this.path(STATE_FILE)
    return enqueue(file, async () => {
      const current = await this.getState()
      const next: AppState = { ...current, ...patch }
      await writeJsonAtomic(file, next)
      this.stateCache = next
      return next
    })
  }
}

function isSummaryLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { sourceFile?: unknown }).sourceFile === 'string'
  )
}

/**
 * 补齐旧版本索引里没有的字段。
 *
 * 索引是上一次扫描留在磁盘上的，可能由更早的版本写成。新增字段时不补默认值，
 * 界面上一读就是 undefined。重新扫描当然会写回完整数据，但不该逼用户先扫一遍。
 *
 * 逐字段补，不要写成"某个字段存在就整条原样返回" —— 那样只要旧索引恰好有那一个
 * 字段，之后新增的字段就全都留在 undefined 上，而类型签名说它们不可能是 undefined。
 */
function withDefaults(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    agent: summary.agent ?? {
      threadId: null,
      parentThreadId: null,
      nickname: null,
      role: null,
      taskPath: null
    },
    usage: summary.usage ?? null
  }
}
