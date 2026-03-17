import { useEffect } from 'react'
import { useRoomStore } from '../stores/roomStore'
import { useUiStore } from '../stores/uiStore'
import { useAuthStore } from '../stores/authStore'
import { useMessageStore } from '../stores/messageStore'

export function useKeyboardShortcuts() {
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const rooms = useRoomStore((s) => s.rooms)
  const activeSpaceId = useRoomStore((s) => s.activeSpaceId)
  const toggleMemberPanel = useUiStore((s) => s.toggleMemberPanel)
  const setSettingsModal = useUiStore((s) => s.setSettingsModal)
  const bumpRoomSearchFocus = useUiStore((s) => s.bumpRoomSearchFocus)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isTyping =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.contentEditable === 'true'
      // True only when the message input textarea is the active element and empty
      const isEmptyMessageInput =
        target.tagName === 'TEXTAREA' &&
        target.getAttribute('placeholder')?.startsWith('Envoyer') === true &&
        (target as HTMLTextAreaElement).value.trim() === ''

      // Ctrl/Cmd+K → focus room search
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        bumpRoomSearchFocus()
        return
      }

      // Ctrl/Cmd+, → open/close settings
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        const { showSettingsModal } = useUiStore.getState()
        setSettingsModal(!showSettingsModal)
        return
      }

      // Ctrl/Cmd+Shift+M → toggle member panel
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        toggleMemberPanel()
        return
      }

      // Escape → cancel pending reply (settings close is handled inside SettingsModal itself)
      if (e.key === 'Escape') {
        const { pendingReply, setPendingReply } = useUiStore.getState()
        if (pendingReply) {
          setPendingReply(null)
          return
        }
      }

      // Shift+ArrowUp (no active text input OR empty message input) → reply to last message in room
      if (e.key === 'ArrowUp' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey &&
          (!isTyping || isEmptyMessageInput) && activeRoomId) {
        const messages = useMessageStore.getState().getMessages(activeRoomId)
        const lastReplyable = [...messages].reverse().find((m) => !m.content.startsWith('🔒'))
        if (lastReplyable) {
          e.preventDefault()
          useUiStore.getState().setPendingReply({
            roomId: lastReplyable.roomId,
            eventId: lastReplyable.eventId,
            senderName: lastReplyable.senderName,
            preview: lastReplyable.content,
          })
          // Focus the message input so the user can type the reply immediately
          setTimeout(() => {
            const textarea = document.querySelector('textarea[placeholder^="Envoyer"]') as HTMLTextAreaElement | null
            textarea?.focus()
          }, 0)
          return
        }
      }

      // ArrowUp (no modifiers, no active text input OR empty message input) → edit last own message
      if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
          (!isTyping || isEmptyMessageInput) && activeRoomId) {
        const myUserId = useAuthStore.getState().session?.userId
        if (myUserId) {
          const messages = useMessageStore.getState().getMessages(activeRoomId)
          const lastEditable = [...messages]
            .reverse()
            .find((m) => m.sender === myUserId && m.type === 'm.text' && !m.content.startsWith('🔒'))
          if (lastEditable) {
            e.preventDefault()
            useUiStore.getState().setEditTargetEventId(lastEditable.eventId)
            return
          }
        }
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
    setActiveRoom,
    toggleMemberPanel,
    setSettingsModal,
    bumpRoomSearchFocus,
  ])
}
