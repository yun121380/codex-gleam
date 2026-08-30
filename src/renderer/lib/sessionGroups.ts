import type { SessionSummary } from '@shared/types'

/**
 * 把并行子代理折叠到派出它们的那个会话下面。
 *
 * 为什么需要：Codex 派子代理并行干活时，每个子代理写自己的一份日志，而它们
 * 收到的是同一段任务描述 —— 于是标题、项目、时间全都一样。实测一个父会话下
 * 最多挂了 114 个子代理，列表里就是一百多行长得完全一样的条目。
 *
 * 分组依据是 Codex 自己写在 session_meta 里的 parent_thread_id，不是靠标题猜。
 * 猜是不行的：好几个月前各自打过一句 "hi" 的会话也会重名，它们之间毫无关系。
 */
export interface SessionGroup {
  /** 顶层那一条。子代理为空时它就是一次普通会话。 */
  parent: SessionSummary
  /** 挂在它下面的子代理，按开始时间从早到晚。 */
  children: SessionSummary[]
}

function startedAtOf(session: SessionSummary): number {
  const iso = session.startedAt ?? session.endedAt ?? session.indexedAt
  const parsed = iso === null ? Number.NaN : Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

export function foldSubAgents(sessions: readonly SessionSummary[]): SessionGroup[] {
  // 一个 thread id 可能对应多份文件（会话被续写/分叉过），取排在最前面的那条当代表。
  const byThreadId = new Map<string, SessionSummary>()
  for (const session of sessions) {
    const threadId = session.agent?.threadId
    if (threadId && !byThreadId.has(threadId)) byThreadId.set(threadId, session)
  }

  const parentOf = (session: SessionSummary): SessionSummary | null => {
    const parentId = session.agent?.parentThreadId
    if (!parentId) return null
    const parent = byThreadId.get(parentId)
    // 父会话不在当前列表里（没扫到、或被筛掉了）时，这条就按普通会话显示。
    return parent && parent.id !== session.id ? parent : null
  }

  /**
   * 一路往上找到顶层的那个会话。
   *
   * 子代理再派子代理是可能的，但列表只做一层折叠 —— 把整棵子树都挂到
   * 最顶上那个会话下面，比嵌套好几层更好读。seen 用来挡住数据异常导致的环。
   */
  const rootOf = (session: SessionSummary): SessionSummary => {
    const seen = new Set<string>([session.id])
    let current = session
    for (;;) {
      const parent = parentOf(current)
      if (!parent || seen.has(parent.id)) return current
      seen.add(parent.id)
      current = parent
    }
  }

  const groups: SessionGroup[] = []
  const indexById = new Map<string, number>()
  const childrenOf = new Map<string, SessionSummary[]>()

  // 先按原顺序把所有"顶层会话"排好，保持调用方的排序不被打乱。
  for (const session of sessions) {
    if (rootOf(session) !== session) continue
    indexById.set(session.id, groups.length)
    groups.push({ parent: session, children: [] })
  }

  for (const session of sessions) {
    const root = rootOf(session)
    if (root === session) continue
    const list = childrenOf.get(root.id) ?? []
    list.push(session)
    childrenOf.set(root.id, list)
  }

  for (const [parentId, children] of childrenOf) {
    const at = indexById.get(parentId)
    children.sort((a, b) => startedAtOf(a) - startedAtOf(b))
    if (at === undefined) {
      // 父会话被筛选条件挡掉了：让这些子代理各自作为普通条目出现，别凭空消失。
      for (const child of children) groups.push({ parent: child, children: [] })
      continue
    }
    groups[at] = { parent: groups[at]!.parent, children }
  }

  return groups
}

/** 子代理在列表里的显示名：代号 + 它负责的那件事。 */
export function describeAgent(session: SessionSummary): string {
  const { nickname, taskPath, role } = session.agent ?? {}
  const task = taskPath?.replace(/^\/root\//, '').replace(/_/g, ' ')
  const parts = [nickname, task, role].filter((part): part is string => Boolean(part && part.trim()))
  return parts.length === 0 ? '子代理' : parts.join(' · ')
}
