import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, session } from 'electron'
import { APP_NAME } from '@shared/constants'
import type { Platform } from '@shared/types'
import { registerIpcHandlers } from './ipc'
import { SessionLibrary } from './library'
import { nodeFileSystem } from './scanner/fsAccess'
import { applySessionSecurity, hardenApp, hardenWindow } from './security'
import { LocalStore } from './storage/store'

/**
 * 拾光 —— Electron 主进程入口。
 *
 * 这里是唯一能碰文件系统的地方。渲染进程通过 preload 暴露的有限接口
 * 请求数据，自己既没有 Node.js 也没有网络。
 */

const isDev = !app.isPackaged
const devServerUrl = process.env.ELECTRON_RENDERER_URL

let mainWindow: BrowserWindow | null = null

function resolveSampleDir(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'fixtures')]
    : [join(app.getAppPath(), 'fixtures'), join(process.cwd(), 'fixtures')]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 构建期证据（`build-evidence.json` 与 `dependency-tree.json`）所在的目录。
 *
 * 开发路径**不是**多余的：开发机上跑过 `pnpm evidence` 之后那两份 JSON 就在
 * `build/generated/` 里，那时照实显示比硬说「开发模式没有」更诚实 ——
 * 「开发模式」不等于「一定没有」。
 */
function resolveEvidenceDir(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'generated')]
    : [join(app.getAppPath(), 'build', 'generated'), join(process.cwd(), 'build', 'generated')]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 开发时的窗口图标。
 *
 * 打包后任务栏用的是 exe 自带的图标（electron-builder 从 build/icon.png 生成），
 * 只有 `pnpm dev` 跑起来的窗口需要显式指定，否则会顶着 Electron 默认图标。
 */
function resolveWindowIcon(): string | null {
  if (app.isPackaged) return null
  const candidate = join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(candidate) ? candidate : null
}

function createWindow(): BrowserWindow {
  const icon = resolveWindowIcon()
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#12110f',
    title: APP_NAME,
    ...(icon === null ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      // 下面四项是"渲染进程不能碰 Node.js"的核心保障。
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false
    }
  })

  hardenWindow(window, { isDev, devServerUrl })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.on('closed', () => {
    mainWindow = null
  })

  if (isDev && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

async function bootstrap(): Promise<void> {
  const store = new LocalStore(join(app.getPath('userData'), 'store'))
  const library = new SessionLibrary({
    store,
    fs: nodeFileSystem,
    platform: process.platform as Platform,
    env: process.env,
    homeDir: homedir(),
    sampleDir: resolveSampleDir()
  })

  await library.init()

  const securityMonitor = applySessionSecurity(session.defaultSession, { isDev, devServerUrl })

  registerIpcHandlers({
    library,
    getWindow: () => mainWindow,
    platform: process.platform as Platform,
    sampleDataAvailable: resolveSampleDir() !== null,
    securityMonitor,
    evidenceDir: resolveEvidenceDir(),
    isDev,
    fs: nodeFileSystem
  })

  // 去掉默认菜单：它包含"访问 Electron 官网"之类的外链。
  Menu.setApplicationMenu(null)

  mainWindow = createWindow()
}

hardenApp()

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(bootstrap).catch((error) => {
    console.error('启动失败：', error)
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
