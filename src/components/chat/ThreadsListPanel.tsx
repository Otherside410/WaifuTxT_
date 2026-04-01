import { useEffect, useState, useCallback } from 'react'
import { format, isToday, isYesterday } from 'date-fns'
import { fr } from 'date-fns/locale'
import { useRoomStore } from '../../stores/roomStore'
import { useMessageStore } from '../../stores/messageStore'
import { useUiStore } from '../../stores/uiStore'
import { loadRoomThreads, loadMediaWithAuth, decryptMediaUrl } from '../../lib/matrix'
import { Avatar } from '../common/Avatar'
import type { ThreadSummary } from '../../types/matrix'

function formatTs(ts: number): string {
  const date = new Date(ts)
  if (isToday(date)) return format(date, 'HH:mm')
  if (isYesterday(date)) return `Hier ${format(date, 'HH:mm')}`
  return format(date, 'dd/MM/yyyy', { locale: fr })
}

function ThreadImagePreview({ imageUrl, encryptedFile }: {
  imageUrl?: string
  encryptedFile?: import('../../types/matrix').EncryptedFileInfo
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (encryptedFile) {
      decryptMediaUrl(encryptedFile).then((url) => {
        if (!cancelled) setBlobUrl(url)
      }).catch(() => {})
    } else if (imageUrl) {
      loadMediaWithAuth(imageUrl).then((url) => {
        if (!cancelled && url) setBlobUrl(url)
      }).catch(() => {})
    }
    return () => { cancelled = true }
  }, [imageUrl, encryptedFile])

  if (!blobUrl) {
    return (
      <div className="w-14 h-14 rounded-md bg-bg-hover shrink-0 flex items-center justify-center">
        <svg className="w-5 h-5 text-text-muted/40" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
        </svg>
      </div>
    )
  }

  return (
    <img
      src={blobUrl}
      alt=""
      className="w-14 h-14 rounded-md object-cover shrink-0"
    />
  )
}

function ThreadCard({ summary, onClick }: { summary: ThreadSummary; onClick: () => void }) {
  const hasImage = !!(summary.rootMessage.imageUrl || summary.rootMessage.encryptedFile)
  const isImageMessage = summary.rootMessage.type === 'm.image'

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-3 border-b border-border/50 hover:bg-bg-hover/40 transition-colors group cursor-pointer"
    >
      <div className="flex items-start gap-3">
        {/* Image preview (only for image messages) */}
        {isImageMessage && hasImage && (
          <ThreadImagePreview
            imageUrl={summary.rootMessage.imageUrl}
            encryptedFile={summary.rootMessage.encryptedFile}
          />
        )}

        <div className="flex-1 min-w-0">
          {/* Sender + timestamp */}
          <div className="flex items-center gap-2 mb-1">
            <Avatar src={summary.rootMessage.senderAvatar} name={summary.rootMessage.senderName} size={18} className="shrink-0" />
            <span className="text-xs font-semibold text-text-primary truncate">{summary.rootMessage.senderName}</span>
            <span className="text-[10px] text-text-muted shrink-0 ml-auto">{formatTs(summary.rootMessage.timestamp)}</span>
          </div>

          {/* Thread title / message preview */}
          <p className="text-sm text-text-secondary leading-snug line-clamp-2 break-words">
            {summary.rootMessage.content || '(média)'}
          </p>

          {/* Reply info */}
          <div className="flex items-center gap-1.5 mt-1.5">
            <Avatar src={summary.lastReplierAvatar} name={summary.lastReplierName} size={14} className="shrink-0" />
            <span className="text-[11px] text-accent-pink font-medium">
              {summary.replyCount} réponse{summary.replyCount > 1 ? 's' : ''}
            </span>
            <span className="text-[10px] text-text-muted">· dernière {formatTs(summary.lastReplyTs)}</span>
          </div>
        </div>

        {/* Arrow indicator */}
        <svg
          className="w-4 h-4 text-text-muted/40 group-hover:text-text-muted shrink-0 mt-1 transition-colors"
          fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
      </div>
    </button>
  )
}

export function ThreadsListPanel() {
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const toggleThreadsListPanel = useUiStore((s) => s.toggleThreadsListPanel)
  const openThreadPanel = useUiStore((s) => s.openThreadPanel)
  const threadsVersion = useMessageStore((s) => s.threadsVersion)

  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    if (!activeRoomId) return
    setLoading(true)
    loadRoomThreads(activeRoomId).then((result) => {
      setThreads(result)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [activeRoomId])

  // Load on mount and when threads change
  useEffect(() => {
    refresh()
  }, [refresh, threadsVersion])

  const handleOpenThread = useCallback((threadRootId: string) => {
    if (!activeRoomId) return
    openThreadPanel(activeRoomId, threadRootId)
  }, [activeRoomId, openThreadPanel])

  return (
    <div className="w-80 border-l border-border bg-bg-secondary flex flex-col shrink-0">
      {/* Header */}
      <div className="h-12 px-4 flex items-center gap-2 border-b border-border shrink-0">
        <svg className="w-4 h-4 text-accent-pink shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h8M8 8h5M8 16h6" />
          <rect x="3" y="3" width="18" height="18" rx="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h3 className="font-semibold text-sm text-text-primary flex-1">Fils de discussion</h3>
        {threads.length > 0 && (
          <span className="text-xs text-text-muted">{threads.length}</span>
        )}
        <button
          onClick={toggleThreadsListPanel}
          className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title="Fermer"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && threads.length === 0 && (
          <div className="flex justify-center py-8">
            <svg className="animate-spin h-5 w-5 text-accent-pink" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}

        {!loading && threads.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <svg className="w-10 h-10 text-text-muted/40 mb-3" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h8M8 8h5M8 16h6" />
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
            <p className="text-sm text-text-muted">Aucun fil de discussion</p>
            <p className="text-xs text-text-muted/60 mt-1">Démarrez un fil depuis n'importe quel message</p>
          </div>
        )}

        {threads.map((summary) => (
          <ThreadCard
            key={summary.rootMessage.eventId}
            summary={summary}
            onClick={() => handleOpenThread(summary.rootMessage.eventId)}
          />
        ))}
      </div>
    </div>
  )
}
