import { useEffect, useState, useCallback } from 'react'
import { format, isToday, isYesterday } from 'date-fns'
import { fr } from 'date-fns/locale'
import { useRoomStore } from '../../stores/roomStore'
import { useMessageStore } from '../../stores/messageStore'
import { useUiStore } from '../../stores/uiStore'
import { loadPinnedMessages, unpinMessage } from '../../lib/matrix'
import { Avatar } from '../common/Avatar'
import type { MessageEvent } from '../../types/matrix'

function formatPinnedTimestamp(ts: number): string {
  const date = new Date(ts)
  if (isToday(date)) return format(date, 'HH:mm')
  if (isYesterday(date)) return `Hier ${format(date, 'HH:mm')}`
  return format(date, 'dd/MM/yyyy HH:mm', { locale: fr })
}

export function PinnedMessagesPanel() {
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const pinnedVersion = useMessageStore((s) => s.pinnedVersion)
  const pinnedEventIds = useMessageStore((s) => s.pinnedEventIds)
  const togglePinnedPanel = useUiStore((s) => s.togglePinnedPanel)
  const [pinnedMessages, setPinnedMessages] = useState<MessageEvent[]>([])
  const [loading, setLoading] = useState(false)

  const ids = activeRoomId ? pinnedEventIds.get(activeRoomId) || [] : []

  useEffect(() => {
    if (!activeRoomId || ids.length === 0) {
      setPinnedMessages([])
      return
    }
    let cancelled = false
    setLoading(true)
    loadPinnedMessages(activeRoomId).then((msgs) => {
      if (!cancelled) {
        setPinnedMessages(msgs)
        setLoading(false)
      }
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [activeRoomId, pinnedVersion])

  const handleUnpin = useCallback(async (eventId: string) => {
    if (!activeRoomId) return
    try {
      await unpinMessage(activeRoomId, eventId)
      setPinnedMessages((prev) => prev.filter((m) => m.eventId !== eventId))
    } catch (err) {
      console.error('[WaifuTxT] Unpin failed:', err)
    }
  }, [activeRoomId])

  return (
    <div className="w-80 border-l border-border bg-bg-secondary flex flex-col shrink-0">
      <div className="h-12 px-4 flex items-center gap-2 border-b border-border shrink-0">
        <svg className="w-5 h-5 text-accent-pink" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
        </svg>
        <h3 className="font-semibold text-sm text-text-primary flex-1">Messages épinglés</h3>
        <span className="text-xs text-text-muted">{ids.length}</span>
        <button
          onClick={togglePinnedPanel}
          className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title="Fermer"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex justify-center py-8">
            <svg className="animate-spin h-5 w-5 text-accent-pink" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}

        {!loading && pinnedMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <svg className="w-10 h-10 text-text-muted/40 mb-3" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
            </svg>
            <p className="text-sm text-text-muted">Aucun message épinglé</p>
            <p className="text-xs text-text-muted/60 mt-1">Épinglez un message important pour le retrouver facilement</p>
          </div>
        )}

        {!loading && pinnedMessages.map((msg) => (
          <div key={msg.eventId} className="px-3 py-3 border-b border-border/50 hover:bg-bg-hover/30 transition-colors group/pin">
            <div className="flex items-start gap-2.5">
              <Avatar src={msg.senderAvatar} name={msg.senderName} size={28} className="mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-xs text-text-primary truncate">{msg.senderName}</span>
                  <span className="text-[10px] text-text-muted shrink-0">{formatPinnedTimestamp(msg.timestamp)}</span>
                </div>
                <p className="text-sm text-text-secondary mt-0.5 line-clamp-3 leading-snug break-words">
                  {msg.content || '(média)'}
                </p>
              </div>
              <button
                onClick={() => handleUnpin(msg.eventId)}
                className="opacity-0 group-hover/pin:opacity-100 p-1 rounded text-text-muted hover:text-red-400 hover:bg-bg-hover transition-all cursor-pointer shrink-0"
                title="Désépingler"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
