import { useEffect } from 'react'

export interface MarkReadMenuState {
  x: number
  y: number
  roomIds: string[]
}

interface MarkReadMenuProps {
  menu: MarkReadMenuState | null
  onMarkRead: (roomIds: string[]) => void
  onClose: () => void
}

// Menu contextuel à une seule entrée : « Marquer comme lu ». Fermé par clic ailleurs, Échap, défilement ou redimensionnement.
export function MarkReadMenu({ menu, onMarkRead, onClose }: MarkReadMenuProps) {
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [menu, onClose])

  if (!menu) return null
  const disabled = menu.roomIds.length === 0
  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div
        className="absolute min-w-44 rounded-md border border-border bg-bg-secondary py-1 shadow-lg"
        style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 50) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          disabled={disabled}
          onClick={() => { onMarkRead(menu.roomIds); onClose() }}
          className="w-full px-3 py-1.5 text-left text-sm text-text-primary hover:bg-bg-hover cursor-pointer disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent"
        >
          Marquer comme lu
        </button>
      </div>
    </div>
  )
}
