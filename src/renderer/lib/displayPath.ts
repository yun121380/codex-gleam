import { maskHomePaths } from '@shared/paths'
import { useApp } from '../hooks/useAppStore'

/**
 * 界面上显示一个路径时统一走这里。
 *
 * 会话数据里的路径主进程已经算好了展示版（displaySourceFile、displayTitle……），
 * 直接用那些字段即可。这个 hook 管的是**主进程算不了**的那一类：
 * 引导页/设置页/扫描页列出来的扫描目录 —— 其中自定义目录是用户在设置页现场
 * 敲进去的，主进程提前算好的任何一份都会在下一次输入时过期。
 *
 * 默认设置下这些位置原来直接显示 `C:\Users\用户名\.codex`，
 * 而这几页恰恰是最容易被截图发出去的（"我这儿扫不到，你看看"）。
 */
export function useDisplayPath(): (target: string) => string {
  const { settings, bootstrap } = useApp()

  return (target: string): string => {
    if (settings.showFullPaths) return target
    return maskHomePaths(target, {
      homeDir: bootstrap?.homeDir ?? null,
      platform: bootstrap?.platform
    })
  }
}
