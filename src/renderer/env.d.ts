/// <reference types="vite/client" />

import type { GleamApi } from '@shared/ipc'

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入；渲染进程只有这一条通往主进程的路。 */
    gleam: GleamApi
  }
}

export {}
