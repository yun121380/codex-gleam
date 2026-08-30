import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 时间线"播放"控制。
 *
 * 播放本质上就是每隔一段时间自动前进一步；走到末尾自动停下。
 * onTick 与 canAdvance 都用 ref 保存：定时器只在"是否播放"和"间隔"变化时重建，
 * 不会因为每次前进导致节奏被打乱。
 */
export function useTimelinePlayer(options: {
  intervalMs: number
  canAdvance: boolean
  onTick: () => void
}): {
  playing: boolean
  play: () => void
  pause: () => void
  toggle: () => void
} {
  const { intervalMs, canAdvance, onTick } = options
  const [playing, setPlaying] = useState(false)
  const tickRef = useRef(onTick)
  const canAdvanceRef = useRef(canAdvance)

  useEffect(() => {
    tickRef.current = onTick
    canAdvanceRef.current = canAdvance
  }, [onTick, canAdvance])

  useEffect(() => {
    if (!playing) return undefined

    const timer = window.setInterval(() => {
      if (!canAdvanceRef.current) {
        setPlaying(false)
        return
      }
      tickRef.current()
    }, Math.max(200, intervalMs))

    return () => window.clearInterval(timer)
  }, [playing, intervalMs])

  const play = useCallback(() => setPlaying(true), [])
  const pause = useCallback(() => setPlaying(false), [])
  const toggle = useCallback(() => setPlaying((current) => !current), [])

  return { playing, play, pause, toggle }
}
