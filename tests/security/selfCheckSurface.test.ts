import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 自检页的四条源码约束。
 *
 * 为什么是源码断言而不是渲染测试：这个仓库的 vitest 跑在 `node` 环境下，没有 DOM，
 * 渲染进程的行为只能从源码文本上验。这不是将就 —— 这四条要盯的东西恰好都是
 * 「代码里有没有出现某种写法」，源码文本正是它们最直接的证据。
 */

const ROOT_DIR = resolve(__dirname, '../..')
const PAGE_PATH = resolve(ROOT_DIR, 'src/renderer/pages/SelfCheckPage.tsx')
const PRELOAD_PATH = resolve(ROOT_DIR, 'src/preload/api.ts')
const IPC_PATH = resolve(ROOT_DIR, 'src/shared/ipc.ts')

const page = readFileSync(PAGE_PATH, 'utf8')
const preload = readFileSync(PRELOAD_PATH, 'utf8')
const ipc = readFileSync(IPC_PATH, 'utf8')

/**
 * 从 `GleamApi` 接口里抠出方法名。
 *
 * 用正则读源码而不是 import 类型：类型在运行时压根不存在，`GleamApi` 的方法名
 * 只能这么拿到。这也正是下面第一条测试必须存在的原因 —— 编译器同样看不见
 * 「preload 少实现了一个方法」这件事。
 */
function gleamApiMethodNames(): string[] {
  const start = ipc.indexOf('export interface GleamApi')
  expect(start).toBeGreaterThan(-1)

  const body = ipc.slice(start)
  const end = body.indexOf('\n}')
  expect(end).toBeGreaterThan(-1)

  const names = new Set<string>()
  // 只认顶层缩进两格的 `name(` 或 `name?(` —— 嵌套在参数对象里的成员缩进更深。
  for (const match of body.slice(0, end).matchAll(/^ {2}([A-Za-z_$][\w$]*)\??\(/gm)) {
    names.add(match[1] as string)
  }
  return [...names].sort()
}

/** 从 `gleamApi` 那个对象字面量里抠出键名。 */
function preloadKeys(): string[] {
  const start = preload.indexOf('const gleamApi: GleamApi = {')
  expect(start).toBeGreaterThan(-1)

  const body = preload.slice(start)
  const end = body.indexOf('\n}')
  expect(end).toBeGreaterThan(-1)

  const names = new Set<string>()
  for (const match of body.slice(0, end).matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)) {
    names.add(match[1] as string)
  }
  return [...names].sort()
}

describe('自检页的对外表面', () => {
  it('preload 暴露的键与 GleamApi 的方法名完全相等', () => {
    const declared = gleamApiMethodNames()
    const exposed = preloadKeys()

    // 不是随手写的一条对称性检查：`ipc.ts` 里的 handler 是一句句
    // `ipcMain.handle(IPC.x, …)`，没有任何类型把它们和 `GleamApi` 绑起来。
    // `GleamApi` 多一个方法而 preload 或主进程忘了跟上，typecheck 照样 exit 0，
    // 要等运行时点到那个按钮才炸。这条测试就是补上编译器看不见的那一段。
    expect(declared.length).toBeGreaterThan(20)
    expect(exposed).toEqual(declared)
  })

  it('自检页不出现任何 GleamApi 方法名的字符串字面量', () => {
    // 那一格必须是 `Object.keys(window.gleam)` 枚举出来的**运行时真实对象**。
    // 一旦页面里出现方法名的字面量，它显示的就是「我们记得有哪些能力」，
    // 而不是「此刻真的有哪些能力」—— 少暴露一个、多暴露一个，页面都看不出来。
    const offenders = gleamApiMethodNames().filter((name) => {
      const quoted = new RegExp(`['"\`]${name}['"\`]`)
      return quoted.test(page)
    })

    expect(offenders).toEqual([])
  })

  it('自检页确实用 Image 发起那次演示加载', () => {
    // 这是一条**正向**断言，缺了它上面两条和下面那条依然全绿 —— 把「你自己试」
    // 整段删掉是让它们变绿最省事的办法。演示能力本身也得被钉住。
    expect(page).toContain('new Image(')
    expect(page).toContain('onerror')
    expect(page).toContain('onload')
  })

  it('自检页一个联网 API 都不碰', () => {
    // `Image` 走的是浏览器的资源加载路径，正是 `onBeforeRequest` 要拦的那条；
    // 而 `fetch` / XHR / WebSocket 在这个仓库里是被禁的 API（`offline.test.ts` 盯着
    // 整个 src）。这里再单独盯一遍这一页：它是全仓库唯一一处「故意去加载点什么」的
    // 代码，最容易被后来人顺手改成 `fetch`。
    expect(page).not.toContain('fetch(')
    expect(page).not.toContain('XMLHttpRequest')
    expect(page).not.toContain('new WebSocket')
  })
})
