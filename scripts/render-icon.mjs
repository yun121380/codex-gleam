/**
 * 把 build/icon.svg 渲染成各平台需要的图标文件。
 *
 * 图标的"源文件"是那份 SVG，其余都是产物 —— 改完 SVG 跑一次 `pnpm run icon` 即可。
 * 这里借项目自带的 Electron 来光栅化，不额外引入 sharp / resvg 之类的原生依赖。
 *
 * 两个刻意的选择：
 *   - 走 canvas.toDataURL 而不是 capturePage：后者要求窗口真的被合成过，
 *     在隐藏窗口 / 无显示器的环境里会直接报 UnknownVizError。
 *   - 自己拼 .ico 而不是让 electron-builder 从 PNG 转：它内置的 WASM 转换器
 *     在本机会 "WebAssembly.Memory(): could not allocate memory" 直接失败。
 *     ICO 本身就是"文件头 + 目录项 + 若干张 PNG"，自己拼更省事也更可控。
 *
 * 用法：electron scripts/render-icon.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const svgPath = join(projectRoot, 'build', 'icon.svg')

/** 单独成文件的 PNG。 */
const pngTargets = [
  // macOS / Linux 用这张，electron-builder 会自行派生所需尺寸。
  { file: join(projectRoot, 'build', 'icon.png'), size: 1024 },
  // 渲染进程的标签页图标：小一张，省得浏览器每次去缩 1024。
  { file: join(projectRoot, 'src', 'renderer', 'icon.png'), size: 256 }
]

/** 打进 .ico 的尺寸。覆盖任务栏、资源管理器各档显示。 */
const icoSizes = [16, 24, 32, 48, 64, 128, 256]

/** 在页面里把 SVG 画进 canvas，再取出 PNG 的 base64。 */
function rasterize(svgDataUrl, size) {
  return `new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = ${size}
      canvas.height = ${size}
      const context = canvas.getContext('2d')
      context.clearRect(0, 0, ${size}, ${size})
      context.drawImage(image, 0, 0, ${size}, ${size})
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => reject(new Error('SVG 解码失败'))
    image.src = ${JSON.stringify(svgDataUrl)}
  })`
}

/**
 * 把若干张 PNG 打成一个 .ico。
 *
 * 结构：6 字节文件头 → 每张图 16 字节的目录项 → 各张 PNG 原样拼在后面。
 * Vista 之后的 ICO 允许直接内嵌 PNG，不必转成 BMP。
 */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // 保留位
  header.writeUInt16LE(1, 2) // 1 = 图标
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(images.length * 16)
  let offset = header.length + directory.length

  images.forEach(({ size, data }, index) => {
    const at = index * 16
    // 256 要写成 0：这个字段只有一个字节。
    directory.writeUInt8(size >= 256 ? 0 : size, at)
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
    directory.writeUInt8(0, at + 2) // 调色板颜色数：真彩色填 0
    directory.writeUInt8(0, at + 3) // 保留位
    directory.writeUInt16LE(1, at + 4) // 颜色平面数
    directory.writeUInt16LE(32, at + 6) // 位深
    directory.writeUInt32LE(data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.data)])
}

async function renderAll(svg) {
  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

  const window = new BrowserWindow({
    width: 128,
    height: 128,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  await window.loadURL('data:text/html;charset=utf-8,<meta charset="utf-8">')

  const pngAt = async (size) => {
    const dataUrl = await window.webContents.executeJavaScript(rasterize(svgDataUrl, size), true)
    return Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64')
  }

  const write = (file, data) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
    console.log(`已生成 ${file.replace(projectRoot, '.')}  (${(data.length / 1024).toFixed(0)} KB)`)
  }

  for (const { file, size } of pngTargets) write(file, await pngAt(size))

  const images = []
  for (const size of icoSizes) images.push({ size, data: await pngAt(size) })
  write(join(projectRoot, 'build', 'icon.ico'), buildIco(images))

  window.destroy()
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  try {
    await renderAll(readFileSync(svgPath, 'utf8'))
    app.exit(0)
  } catch (error) {
    console.error('渲染图标失败：', error)
    app.exit(1)
  }
})
