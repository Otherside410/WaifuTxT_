import { useEffect, useRef } from 'react'
import { useMessageStore } from '../stores/messageStore'
import { useRoomStore } from '../stores/roomStore'
import { useAuthStore } from '../stores/authStore'

export function useNotifications() {
  const permissionRef = useRef<NotificationPermission>('default')
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

      for (const [roomId, messages] of state.messages) {
        const prev = prevState.messages.get(roomId)
        if (!prev || messages.length <= prev.length) continue
        if (roomId === activeRoomId) continue

        const lastMsg = messages[messages.length - 1]
        if (lastMsg.sender === session.userId) continue

        const room = useRoomStore.getState().rooms.get(roomId)
        new Notification(room?.name || 'WaifuTxT', {
          body: `${lastMsg.senderName}: ${lastMsg.content}`,
          icon: '/vite.svg',
          tag: lastMsg.eventId,
        })
      }
    })

    return unsub
  }, [session, activeRoomId])
}
