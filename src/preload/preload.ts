import { contextBridge } from 'electron'
import { gleamApi } from './api'

/**
 * preload 是渲染进程与主进程之间唯一的桥。
 *
 * contextIsolation 打开时，contextBridge 会把 API 复制到一个独立的世界里，
 * 页面脚本拿不到这里的任何引用，也就无法顺着 require 摸到 Node.js。
 */
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('gleam', gleamApi)
} else {
  // 正常情况下永远走不到这里；万一 contextIsolation 被关掉，宁可让应用不可用也不降级。
  throw new Error('contextIsolation 未开启，出于安全考虑拒绝启动。')
}
