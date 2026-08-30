import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { app, shell, type BrowserWindow, type Session, type WebContents } from 'electron'

/**
 * 安全与"完全离线"的集中实现。
 *
 * 这个文件是整个应用的护栏：
 *   - 渲染进程没有 Node.js 能力，只能通过 preload 暴露的方法说话；
 *   - 所有网络请求在 Electron 层被直接取消（不是"尽量不请求"，是"请求不出去"）；
 *   - 禁止页面跳转到外部地址、禁止新开窗口、禁止 webview；
 *   - 所有权限申请（摄像头、定位、通知……）一律拒绝。
 */

/** 允许的协议：全部是本地的，没有任何一个会出网。 */
const ALWAYS_ALLOWED_PROTOCOLS = new Set(['file:', 'devtools:', 'blob:', 'data:', 'about:'])

export interface SecurityOptions {
  isDev: boolean
  /** 开发模式下 Vite 的地址，只有它被放行（用于热更新）。 */
  devServerUrl?: string | undefined
}

function devOrigins(devServerUrl?: string): string[] {
  if (!devServerUrl) return []
  try {
    const url = new URL(devServerUrl)
    return [`http://${url.host}`, `ws://${url.host}`, `https://${url.host}`, `wss://${url.host}`]
  } catch {
    return []
  }
}

function isRequestAllowed(url: string, options: SecurityOptions): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (ALWAYS_ALLOWED_PROTOCOLS.has(parsed.protocol)) return true
  if (parsed.protocol === 'chrome-extension:' || parsed.protocol === 'chrome:') return true

  if (options.isDev) {
    const allowed = devOrigins(options.devServerUrl)
    const origin = `${parsed.protocol}//${parsed.host}`
    if (allowed.includes(origin)) return true
  }

  return false
}

/** 生产环境的 CSP（与 index.html 里注入的一致，这里再加一道响应头）。 */
const PRODUCTION_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

export function applySessionSecurity(session: Session, options: SecurityOptions): void {
  // 1. 拦截所有出网请求。
  session.webRequest.onBeforeRequest((details, callback) => {
    if (isRequestAllowed(details.url, options)) {
      callback({ cancel: false })
      return
    }
    console.warn('[安全] 已拦截网络请求：', details.url)
    callback({ cancel: true })
  })

  // 2. 生产环境补一道 CSP 响应头。
  if (!options.isDev) {
    session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [PRODUCTION_CSP]
        }
      })
    })
  }

  // 3. 拒绝一切权限申请（摄像头、麦克风、定位、通知、剪贴板读取……）。
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)

  // 4. 任何 TLS 连接都直接判为不可信 —— 本应用本来就不该发起它们。
  session.setCertificateVerifyProc((_request, callback) => {
    callback(-3)
  })
}

/** 对每个 webContents 生效的导航限制。 */
export function hardenWebContents(contents: WebContents, options: SecurityOptions): void {
  contents.setWindowOpenHandler(({ url }) => {
    console.warn('[安全] 已阻止打开新窗口：', url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    if (isRequestAllowed(url, options)) return
    console.warn('[安全] 已阻止页面跳转：', url)
    event.preventDefault()
  })

  contents.on('will-attach-webview', (event) => {
    console.warn('[安全] 已阻止 webview 嵌入。')
    event.preventDefault()
  })

  contents.on('will-redirect', (event, url) => {
    if (isRequestAllowed(url, options)) return
    event.preventDefault()
  })
}

export function hardenWindow(window: BrowserWindow, options: SecurityOptions): void {
  hardenWebContents(window.webContents, options)
}

/** 应用级别的加固，必须在 app ready 之前调用。 */
export function hardenApp(): void {
  app.enableSandbox()

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

/**
 * 在系统文件管理器里定位一个文件。
 * 这是本应用唯一会调用系统的地方 —— 它不打开网页，也不执行任何命令。
 *
 * baseDir 是这个路径的参照目录（通常是那一步的工作目录）。
 * 日志里的路径**经常是相对的** —— apply_patch 写的就是
 * `*** Update File: src/app.ts`。把这种路径原样交给系统，它会去
 * 当前进程的工作目录里找，于是定位到一个八竿子打不着的地方，或者干脆什么都不弹。
 *
 * 返回值代表**真的定位到了**，所以必须先确认文件还在。
 * shell.showItemInFolder 对着不存在的路径是静默的：它什么都不弹，也不报错。
 * 从前那样无脑 return true，界面就以为成功了、一句提示都不给 ——
 * 而用户看到的是"点了没反应"。会话记录常常是几个月前的，文件早被挪走或删掉，
 * 这条路径一点都不罕见。
 */
export async function revealInFolder(
  targetPath: string,
  baseDir?: string | null
): Promise<boolean> {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(targetPath)) return false

  const target = targetPath.trim()
  let absolute: string

  if (isAbsolute(target)) {
    absolute = target
  } else {
    // 相对路径而又不知道参照目录：与其定位到错的地方，不如明确地告诉界面"做不到"。
    if (typeof baseDir !== 'string' || baseDir.trim() === '') return false
    if (!isAbsolute(baseDir.trim())) return false
    absolute = resolve(baseDir.trim(), target)
  }

  try {
    await stat(absolute)
  } catch {
    return false
  }

  shell.showItemInFolder(absolute)
  return true
}
