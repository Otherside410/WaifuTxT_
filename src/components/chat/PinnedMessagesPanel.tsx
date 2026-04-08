import { useEffect, useState, useCallback } from 'react'
import { format, isToday, isYesterday } from 'date-fns'
import { fr } from 'date-fns/locale'
import { useRoomStore } from '../../stores/roomStore'
import { useMessageStore } from '../../stores/messageStore'
import { useUiStore } from '../../stores/uiStore'
import { loadPinnedMessages, unpinMessage, decryptMediaUrl, loadMediaWithAuth } from '../../lib/matrix'
import { Avatar } from '../common/Avatar'
import type { MessageEvent, EncryptedFileInfo } from '../../types/matrix'

function useDecryptedUrl(encryptedFile?: EncryptedFileInfo): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!encryptedFile) return
    let cancelled = false
    decryptMediaUrl(encryptedFile)
      .then((blobUrl) => { if (!cancelled) setUrl(blobUrl) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [encryptedFile?.url])
  return url
}

function PinnedImage({ src, alt }: { src: string; alt: string }) {
  const [displaySrc, setDisplaySrc] = useState(src)
  const [triedAuth, setTriedAuth] = useState(false)

  useEffect(() => { setDisplaySrc(src); setTriedAuth(false) }, [src])

  const handleError = async () => {
    if (triedAuth) return
    setTriedAuth(true)
    const recovered = await loadMediaWithAuth(src)
    if (recovered) setDisplaySrc(recovered)
  }

  return (
    <img
      src={displaySrc}
      alt={alt}
      className="mt-1 rounded max-h-32 max-w-full object-contain"
      loading="lazy"
      onError={handleError}
    />
  )
}

function PinnedMediaContent({ msg }: { msg: MessageEvent }) {
  const decryptedUrl = useDecryptedUrl(msg.encryptedFile)
  const decryptedThumbUrl = useDecryptedUrl(msg.encryptedThumbnailFile)

  if (msg.type === 'm.image') {
    const imgSrc = decryptedUrl || decryptedThumbUrl || msg.imageUrl || msg.thumbnailUrl
    if (imgSrc) return <PinnedImage src={imgSrc} alt={msg.content} />
    if (msg.encryptedFile) {
      return (
        <div className="mt-1 rounded bg-bg-tertiary animate-pulse flex items-center justify-center" style={{ width: 120, height: 80 }}>
          <svg className="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
          </svg>
        </div>
      )
    }
  }

  if (msg.type === 'm.video') {
    const videoSrc = decryptedUrl || msg.fileUrl
    const posterSrc = decryptedThumbUrl || msg.thumbnailUrl
    if (videoSrc) {
      return (
        <video
          src={videoSrc}
          poster={posterSrc || undefined}
          className="mt-1 rounded max-h-32 max-w-full"
          controls
          preload="metadata"
        />
      )
    }
    return (
      <div className="mt-1 flex items-center gap-1.5 text-text-muted">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
        </svg>
        <span className="text-xs">{msg.fileName || 'Vidéo'}</span>
      </div>
    )
  }

  if (msg.type === 'm.audio') {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-text-muted">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
        </svg>
        <span className="text-xs">{msg.isVoiceMessage ? 'Message vocal' : (msg.fileName || 'Audio')}</span>
        {msg.audioDuration != null && (
          <span className="text-[10px]">{Math.floor(msg.audioDuration / 1000)}s</span>
        )}
      </div>
    )
  }

  if (msg.type === 'm.file') {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-text-muted">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
        <span className="text-xs truncate">{msg.fileName || 'Fichier'}</span>
      </div>
    )
  }

  return (
    <p className="text-sm text-text-secondary mt-0.5 line-clamp-3 leading-snug break-words">
      {msg.content || '(média)'}
    </p>
  )
}

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
    <div className="w-full lg:w-80 border-0 lg:border-l border-border bg-bg-primary lg:bg-bg-secondary flex flex-col shrink-0">
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
                <PinnedMediaContent msg={msg} />
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
