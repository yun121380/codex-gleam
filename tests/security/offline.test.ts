import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 这些测试把"绝对约束"变成可执行的检查。
 *
 * 光在文档里承诺"不执行命令、不联网"是不够的 —— 这里直接扫描源码，
 * 一旦有人（包括未来的我）不小心引入了 child_process 或 fetch，测试立刻失败。
 */

const SRC_DIR = resolve(__dirname, '../../src')
const ROOT_DIR = resolve(__dirname, '../..')

interface SourceFile {
  path: string
  relative: string
  text: string
}

function collectSources(dir: string): SourceFile[] {
  const files: SourceFile[] = []

  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|css|html)$/.test(name)) continue
      files.push({
        path: full,
        relative: full.slice(SRC_DIR.length + 1).replace(/\\/g, '/'),
        text: readFileSync(full, 'utf8')
      })
    }
  }

  walk(dir)
  return files
}

const sources = collectSources(SRC_DIR)

function offenders(pattern: RegExp): string[] {
  return sources.filter((file) => pattern.test(file.text)).map((file) => file.relative)
}

describe('源码里不存在执行命令的能力', () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['import child_process', /from\s+['"](?:node:)?child_process['"]/],
    ['require child_process', /require\(\s*['"](?:node:)?child_process['"]\s*\)/],
    ['execSync', /\bexecSync\s*\(/],
    ['spawnSync', /\bspawnSync\s*\(/],
    ['spawn', /\bspawn\s*\(/],
    ['execFile', /\bexecFile\w*\s*\(/],
    ['vm.runInNewContext', /runInNewContext|runInThisContext/],
    ['eval', /(^|[^.\w])eval\s*\(/],
    ['new Function', /new\s+Function\s*\(/]
  ]

  for (const [label, pattern] of FORBIDDEN) {
    it(`不出现 ${label}`, () => {
      expect(offenders(pattern)).toEqual([])
    })
  }
})

describe('源码里不存在联网能力', () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['fetch(', /(^|[^.\w])fetch\s*\(/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['new WebSocket', /new\s+WebSocket\b/],
    ['EventSource', /\bEventSource\b/],
    ['axios', /\baxios\b/],
    ['sendBeacon', /\bsendBeacon\b/],
    ['node:http', /from\s+['"](?:node:)?https?['"]/],
    ['node:net / dns / tls', /from\s+['"](?:node:)?(?:net|dns|tls|dgram)['"]/],
    ['shell.openExternal', /openExternal\s*\(/]
  ]

  for (const [label, pattern] of FORBIDDEN) {
    it(`不出现 ${label}`, () => {
      expect(offenders(pattern)).toEqual([])
    })
  }

  it('界面 HTML 里没有任何 CDN 或外链资源', () => {
    const html = sources.filter((file) => file.relative.endsWith('.html'))
    expect(html.length).toBeGreaterThan(0)

    for (const file of html) {
      expect(file.text, file.relative).not.toMatch(/https?:\/\//)
      expect(file.text, file.relative).not.toMatch(/<link[^>]+href\s*=\s*["']https?:/i)
    }
  })

  it('样式里没有远程字体（字体全部使用系统字体栈）', () => {
    for (const file of sources.filter((entry) => entry.relative.endsWith('.css'))) {
      expect(file.text, file.relative).not.toMatch(/@import\s+url\(/)
      expect(file.text, file.relative).not.toMatch(/url\(\s*["']?https?:/)
    }
  })
})

describe('渲染进程与主进程的隔离', () => {
  const mainSource = readFileSync(join(SRC_DIR, 'main/main.ts'), 'utf8')
  const preloadSource = readFileSync(join(SRC_DIR, 'preload/preload.ts'), 'utf8')

  it('窗口开启了 contextIsolation 与 sandbox，并关闭 nodeIntegration', () => {
    expect(mainSource).toMatch(/contextIsolation:\s*true/)
    expect(mainSource).toMatch(/sandbox:\s*true/)
    expect(mainSource).toMatch(/nodeIntegration:\s*false/)
    expect(mainSource).toMatch(/nodeIntegrationInWorker:\s*false/)
    expect(mainSource).toMatch(/nodeIntegrationInSubFrames:\s*false/)
    expect(mainSource).toMatch(/webviewTag:\s*false/)
    expect(mainSource).toMatch(/webSecurity:\s*true/)
  })

  it('preload 只通过 contextBridge 暴露有限接口', () => {
    expect(preloadSource).toContain('contextBridge.exposeInMainWorld')
    expect(preloadSource).toContain("'gleam'")
    // 绝不能把整个 ipcRenderer 丢给页面。
    expect(preloadSource).not.toMatch(/exposeInMainWorld\(\s*['"]ipcRenderer['"]/)
    expect(preloadSource).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/)
  })

  it('渲染进程代码不直接导入 electron 或 node 模块', () => {
    const rendererFiles = sources.filter((file) => file.relative.startsWith('renderer/'))
    expect(rendererFiles.length).toBeGreaterThan(5)

    for (const file of rendererFiles) {
      expect(file.text, file.relative).not.toMatch(/from\s+['"]electron['"]/)
      expect(file.text, file.relative).not.toMatch(/from\s+['"]node:/)
      expect(file.text, file.relative).not.toMatch(/require\(\s*['"]/)
    }
  })

  it('主进程注册了网络拦截、导航限制与权限拒绝', () => {
    const securitySource = readFileSync(join(SRC_DIR, 'main/security.ts'), 'utf8')

    expect(securitySource).toContain('onBeforeRequest')
    expect(securitySource).toContain('setWindowOpenHandler')
    expect(securitySource).toContain('will-navigate')
    expect(securitySource).toContain('will-attach-webview')
    expect(securitySource).toContain('setPermissionRequestHandler')
    expect(securitySource).toContain('Content-Security-Policy')
  })

  it('生产环境的 CSP 禁止外部连接', () => {
    const viteConfig = readFileSync(join(ROOT_DIR, 'electron.vite.config.ts'), 'utf8')

    expect(viteConfig).toContain("default-src 'none'")
    expect(viteConfig).toContain("connect-src 'none'")
    expect(viteConfig).toContain("script-src 'self'")
  })
})

describe('没有账号、更新与遥测', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  it('依赖里没有自动更新、遥测或错误上报库', () => {
    const all = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
    const banned = [
      'electron-updater',
      'update-electron-app',
      '@sentry/electron',
      '@sentry/node',
      'posthog-js',
      'mixpanel',
      'analytics-node',
      'axios',
      'node-fetch',
      'got',
      'undici',
      'ws',
      'socket.io-client'
    ]

    expect(all.filter((name) => banned.includes(name))).toEqual([])
  })

  it('打包配置关闭了发布渠道（不会有自动更新）', () => {
    const builder = readFileSync(join(ROOT_DIR, 'electron-builder.yml'), 'utf8')
    expect(builder).toMatch(/^publish:\s*null$/m)
  })

  it('源码里没有任何 API Key / 登录相关的字段读取', () => {
    for (const file of sources) {
      expect(file.text, file.relative).not.toMatch(/process\.env\.(OPENAI|ANTHROPIC|GEMINI)/)
      expect(file.text, file.relative).not.toMatch(/api\.openai\.com|api\.anthropic\.com/)
    }
  })

  it('.env.example 明确写清不需要密钥', () => {
    const example = readFileSync(join(ROOT_DIR, '.env.example'), 'utf8')
    expect(example).toContain('不需要')
    expect(example).not.toMatch(/^\s*[A-Z_]*API_KEY\s*=\s*\S+/m)
  })
})
