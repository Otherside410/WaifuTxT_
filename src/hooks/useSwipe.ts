import { useRef, useCallback } from 'react'

interface SwipeHandlers {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: (e: React.TouchEvent) => void
}

const SWIPE_THRESHOLD = 50
const AXIS_LOCK_RATIO = 1.5 // horizontal must be 1.5x more than vertical

export function useSwipe(onSwipeLeft: () => void, onSwipeRight: () => void): SwipeHandlers {
  const startX = useRef<number | null>(null)
  const startY = useRef<number | null>(null)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX
    startY.current = e.touches[0].clientY
  }, [])

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (startX.current === null || startY.current === null) return
    const dx = e.changedTouches[0].clientX - startX.current
    const dy = e.changedTouches[0].clientY - startY.current
    startX.current = null
    startY.current = null

    if (Math.abs(dx) < SWIPE_THRESHOLD) return
    if (Math.abs(dx) < Math.abs(dy) * AXIS_LOCK_RATIO) return

    if (dx < 0) onSwipeLeft()
    else onSwipeRight()
  }, [onSwipeLeft, onSwipeRight])

  return { onTouchStart, onTouchEnd }
}
