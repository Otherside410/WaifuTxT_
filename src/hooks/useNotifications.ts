import { useEffect, useRef } from 'react'
import { useMessageStore } from '../stores/messageStore'
import { useRoomStore } from '../stores/roomStore'
import { useAuthStore } from '../stores/authStore'
import { useUiStore } from '../stores/uiStore'
import { isEncryptedStorePlaceholder } from '../lib/matrix'

export function useNotifications() {
  const permissionRef = useRef<NotificationPermission>('default')
  const notifiedRef = useRef(new Set<string>())
  const session = useAuthStore((s) => s.session)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((perm) => {
        permissionRef.current = perm
      })
    } else if ('Notification' in window) {
      permissionRef.current = Notification.permission
    }
  }, [])

  useEffect(() => {
    const unsub = useMessageStore.subscribe((state, prevState) => {
      if (!session || !document.hidden) return
      if (permissionRef.current !== 'granted') return
      if (!useUiStore.getState().desktopNotifications) return

      for (const [roomId, messages] of state.messages) {
        const prev = prevState.messages.get(roomId)
        if (!prev || messages === prev) continue
        if (roomId === activeRoomId) continue

        const lastMsg = messages[messages.length - 1]
        const prevLast = prev[prev.length - 1]
        if (!lastMsg || lastMsg === prevLast) continue
        if (lastMsg.sender === session.userId) continue
        // Encrypted events land as a placeholder first; notify once the real
        // content replaces it (same eventId), never for the placeholder itself.
        if (isEncryptedStorePlaceholder(lastMsg)) continue
        if (prevLast?.eventId === lastMsg.eventId && !isEncryptedStorePlaceholder(prevLast)) continue
        if (notifiedRef.current.has(lastMsg.eventId)) continue
        notifiedRef.current.add(lastMsg.eventId)

        const room = useRoomStore.getState().rooms.get(roomId)
        new Notification(room?.name || 'WaifuChat', {
          body: `${lastMsg.senderName}: ${lastMsg.content}`,
          icon: '/favicon.png',
          tag: lastMsg.eventId,
        })
      }
    })

    return unsub
  }, [session, activeRoomId])
}
