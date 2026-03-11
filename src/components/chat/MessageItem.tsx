import { format, isToday, isYesterday } from 'date-fns'
import { fr } from 'date-fns/locale'
import { useState, useEffect, useCallback } from 'react'
import type { MessageEvent, EncryptedFileInfo } from '../../types/matrix'
import { Avatar } from '../common/Avatar'
import { decryptMediaUrl } from '../../lib/matrix'

interface MessageItemProps {
  message: MessageEvent
  showHeader: boolean
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts)
  if (isToday(date)) return format(date, 'HH:mm')
  if (isYesterday(date)) return `Hier ${format(date, 'HH:mm')}`
  return format(date, 'dd/MM/yyyy HH:mm', { locale: fr })
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

function useDecryptedUrl(encryptedFile?: EncryptedFileInfo): { url: string | null; error: boolean } {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!encryptedFile) return
    let cancelled = false
    setError(false)
    decryptMediaUrl(encryptedFile)
      .then((blobUrl) => { if (!cancelled) setUrl(blobUrl) })
      .catch((err) => {
        console.error('[WaifuTxT] Media decrypt error:', err)
        if (!cancelled) setError(true)
      })
    return () => { cancelled = true }
  }, [encryptedFile?.url])
  return { url, error }
}

function EncryptedImage({ message }: { message: MessageEvent }) {
  const { url: decryptedUrl, error: mainError } = useDecryptedUrl(message.encryptedFile)
  const { url: thumbUrl } = useDecryptedUrl(message.encryptedThumbnailFile)
  const displayUrl = decryptedUrl || thumbUrl

  const [fullscreen, setFullscreen] = useState(false)

  if (mainError && !displayUrl) {
    return (
      <div className="mt-1 p-3 rounded-lg bg-bg-tertiary border border-border text-text-muted text-xs flex items-center gap-2 max-w-sm">
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
        </svg>
        Image chiffrée — impossible de déchiffrer
      </div>
    )
  }

  if (!displayUrl) {
    const w = message.imageInfo?.w
    const h = message.imageInfo?.h
    const aspect = w && h ? w / h : 16 / 9
    const displayW = Math.min(w || 400, 512)
    const displayH = displayW / aspect
    return (
      <div
        className="mt-1 rounded-lg bg-bg-tertiary animate-pulse flex items-center justify-center"
        style={{ width: displayW, height: displayH, maxHeight: 320 }}
      >
        <svg className="w-6 h-6 text-text-muted" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
        </svg>
      </div>
    )
  }

  return (
    <>
      <div className="mt-1 max-w-lg">
        <img
          src={displayUrl}
          alt={message.content}
          className="rounded-lg max-h-80 object-contain cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => setFullscreen(true)}
        />
      </div>
      {fullscreen && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setFullscreen(false)}
        >
          <img
            src={decryptedUrl || displayUrl}
            alt={message.content}
            className="max-w-[90vw] max-h-[90vh] object-contain"
          />
        </div>
      )}
    </>
  )
}

function FileAttachment({ message }: { message: MessageEvent }) {
  const { url: decryptedUrl } = useDecryptedUrl(message.encryptedFile)
  const url = message.fileUrl || decryptedUrl

  const handleClick = useCallback(() => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = message.fileName || 'file'
    a.click()
  }, [url, message.fileName])

  return (
    <button
      onClick={handleClick}
      disabled={!url}
      className="mt-1 flex items-center gap-3 p-3 bg-bg-tertiary rounded-lg border border-border hover:border-accent-pink transition-colors max-w-sm text-left disabled:opacity-50 cursor-pointer disabled:cursor-wait"
    >
      <svg className="w-8 h-8 text-accent-pink shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
      <div className="min-w-0">
        <div className="text-sm text-accent-pink font-medium truncate">{message.fileName || message.content}</div>
        {message.fileSize != null && (
          <div className="text-xs text-text-muted">{formatFileSize(message.fileSize)}</div>
        )}
        {!url && message.encryptedFile && (
          <div className="text-xs text-text-muted">Déchiffrement...</div>
        )}
      </div>
    </button>
  )
}

export function MessageItem({ message, showHeader }: MessageItemProps) {
  const isMediaType = message.type === 'm.image' || message.type === 'm.video' || message.type === 'm.audio' || message.type === 'm.file'

  return (
    <div className={`group flex gap-4 px-4 py-0.5 hover:bg-bg-hover/30 transition-colors ${showHeader ? 'mt-4' : ''}`}>
      {showHeader ? (
        <Avatar src={message.senderAvatar} name={message.senderName} size={40} className="mt-0.5" />
      ) : (
        <div className="w-10 shrink-0 flex items-center justify-center">
          <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
            {format(new Date(message.timestamp), 'HH:mm')}
          </span>
        </div>
      )}

      <div className="flex-1 min-w-0">
        {showHeader && (
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm text-text-primary hover:underline cursor-pointer">
              {message.senderName}
            </span>
            <span className="text-[11px] text-text-muted">{formatTimestamp(message.timestamp)}</span>
            {message.isEdited && <span className="text-[10px] text-text-muted">(modifié)</span>}
          </div>
        )}

        {message.type === 'm.image' && (message.imageUrl || message.encryptedFile) && (
          message.encryptedFile
            ? <EncryptedImage message={message} />
            : (
              <div className="mt-1 max-w-lg">
                <img
                  src={message.imageUrl}
                  alt={message.content}
                  className="rounded-lg max-h-80 object-contain cursor-pointer hover:opacity-90 transition-opacity"
                  loading="lazy"
                />
              </div>
            )
        )}

        {message.type === 'm.video' && (message.fileUrl || message.encryptedFile) && (
          <VideoAttachment message={message} />
        )}

        {(message.type === 'm.file' || message.type === 'm.audio') && (message.fileUrl || message.encryptedFile) && (
          <FileAttachment message={message} />
        )}

        {(message.type === 'm.text' || message.type === 'm.notice' || message.type === 'm.emote') && (
          <p className={`text-sm leading-relaxed break-words ${
            message.type === 'm.notice' ? 'text-text-muted italic' : 'text-text-primary'
          }`}>
            {message.type === 'm.emote' && (
              <span className="text-text-secondary italic">* {message.senderName} </span>
            )}
            {message.content.startsWith('🔒') ? (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-bg-tertiary rounded text-text-muted text-xs italic">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                </svg>
                Message chiffré — clé de récupération requise
              </span>
            ) : message.content}
          </p>
        )}

        {!isMediaType && message.type !== 'm.text' && message.type !== 'm.notice' && message.type !== 'm.emote' && message.content && (
          <p className="text-sm text-text-primary leading-relaxed break-words">{message.content}</p>
        )}
      </div>
    </div>
  )
}

function VideoAttachment({ message }: { message: MessageEvent }) {
  const { url: decryptedUrl } = useDecryptedUrl(message.encryptedFile)
  const { url: thumbDecryptedUrl } = useDecryptedUrl(message.encryptedThumbnailFile)
  const videoUrl = message.fileUrl || decryptedUrl
  const posterUrl = message.thumbnailUrl || thumbDecryptedUrl

  if (!videoUrl) {
    return (
      <div className="mt-1 rounded-lg bg-bg-tertiary animate-pulse flex items-center justify-center" style={{ width: 400, height: 225 }}>
        <svg className="w-8 h-8 text-text-muted" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="mt-1 max-w-lg">
      <video
        src={videoUrl}
        poster={posterUrl || undefined}
        controls
        className="rounded-lg max-h-80"
        preload="metadata"
      />
    </div>
  )
}
