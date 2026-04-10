import { useRef, useCallback } from 'react'

const LONG_PRESS_MS = 480

export function useLongPress(onLongPress: () => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firedRef = useRef(false)

  const start = useCallback((e: React.TouchEvent) => {
    // Don't interfere with multi-touch gestures
    if (e.touches.length > 1) return
    firedRef.current = false
    timerRef.current = setTimeout(() => {
      firedRef.current = true
      onLongPress()
    }, LONG_PRESS_MS)
  }, [onLongPress])

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Swallow the click that fires right after a long press ends
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (firedRef.current) {
      e.preventDefault()
      e.stopPropagation()
      firedRef.current = false
    }
  }, [])

  return {
    onTouchStart: start,
    onTouchEnd: cancel,
    onTouchMove: cancel,
    onClick: handleClick,
  }
}
