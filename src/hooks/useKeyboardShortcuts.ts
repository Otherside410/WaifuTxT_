import { useEffect } from 'react'
import { useRoomStore } from '../stores/roomStore'
import { useUiStore } from '../stores/uiStore'

export function useKeyboardShortcuts() {
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const rooms = useRoomStore((s) => s.rooms)
  const activeSpaceId = useRoomStore((s) => s.activeSpaceId)
  const toggleMemberPanel = useUiStore((s) => s.toggleMemberPanel)
  const setSettingsModal = useUiStore((s) => s.setSettingsModal)
  const showSettingsModal = useUiStore((s) => s.showSettingsModal)
  const bumpRoomSearchFocus = useUiStore((s) => s.bumpRoomSearchFocus)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isTyping =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.contentEditable === 'true'

      // Ctrl/Cmd+K → focus room search
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        bumpRoomSearchFocus()
        return
      }

      // Ctrl/Cmd+, → open/close settings
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setSettingsModal(!showSettingsModal)
        return
      }

      // Ctrl/Cmd+Shift+M → toggle member panel
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        toggleMemberPanel()
        return
      }

      // Escape → close settings modal
      if (e.key === 'Escape' && showSettingsModal) {
        setSettingsModal(false)
        return
      }

      // Alt+ArrowUp/Down → navigate between rooms (only when not focused in a text input)
      if (!isTyping && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        const allRooms = Array.from(rooms.values())
        let displayRooms: typeof allRooms

        if (activeSpaceId === null) {
          const dms = allRooms.filter((r) => r.isDirect)
          const nonSpaceNonDm = allRooms.filter((r) => !r.isSpace && !r.isDirect)
          displayRooms = [...dms, ...nonSpaceNonDm].sort((a, b) => b.lastMessageTs - a.lastMessageTs)
        } else {
          const space = rooms.get(activeSpaceId)
          if (!space) return
          displayRooms = space.children
            .map((id) => rooms.get(id))
            .filter((r): r is NonNullable<typeof r> => !!r && !r.isSpace)
            .sort((a, b) => b.lastMessageTs - a.lastMessageTs)
        }

        const idx = displayRooms.findIndex((r) => r.roomId === activeRoomId)
        const next =
          e.key === 'ArrowDown'
            ? Math.min(idx + 1, displayRooms.length - 1)
            : Math.max(idx - 1, 0)
        if (displayRooms[next]) setActiveRoom(displayRooms[next].roomId)
        return
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [
    activeRoomId,
    activeSpaceId,
    rooms,
    showSettingsModal,
    setActiveRoom,
    toggleMemberPanel,
    setSettingsModal,
    bumpRoomSearchFocus,
  ])
}
