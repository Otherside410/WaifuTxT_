import { format, isToday, isYesterday } from 'date-fns'
import { fr } from 'date-fns/locale'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { EncryptedFileInfo, MessageEvent } from '../../types/matrix'
import { Avatar } from '../common/Avatar'
import { useRoomStore } from '../../stores/roomStore'
import {
  decryptMediaUrl,
  getMediaUrlWithAccessToken,
  getUrlPreview,
  loadMediaWithAuth,
  type UrlPreviewData,
} from '../../lib/matrix'

const URL_REGEX = /https?:\/\/[^\s<>"']+/g
const TOKEN_REGEX = /(https?:\/\/[^\s<>"']+|<@[^>\s]+>|@[A-Za-z0-9._=+\-/]+:[A-Za-z0-9.-]+(?:\:\d+)?)/g

function mxidToMentionLabel(raw: string): string {
  const mxid = raw.replace(/^<@/, '').replace(/>$/, '').replace(/^@/, '')
  const localpart = mxid.split(':')[0] || mxid
  return `@${localpart}`
}

function splitTrailingPunctuation(url: string): { cleanUrl: string; trailing: string } {
  let cleanUrl = url
  let trailing = ''
  while (cleanUrl.length > 0 && /[)\]}.,;:!?]+$/.test(cleanUrl)) {
    trailing = cleanUrl.slice(-1) + trailing
    cleanUrl = cleanUrl.slice(0, -1)
  }
  return { cleanUrl, trailing }
}

function RichText({ text }: { text: string }) {
  const parts = text.split(TOKEN_REGEX)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null
        if (part.startsWith('http://') || part.startsWith('https://')) {
          const { cleanUrl, trailing } = splitTrailingPunctuation(part)
          return (
            <span key={i}>
              <a
                href={cleanUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link hover:text-link-hover hover:underline break-all"
              >
                {cleanUrl}
              </a>
              {trailing}
            </span>
          )
        }
        if (part.startsWith('<@') || /^@[A-Za-z0-9._=+\-/]+:[A-Za-z0-9.-]+(?:\:\d+)?$/.test(part)) {
          return (
            <span
              key={i}
              className="inline-flex items-center rounded px-1 py-0.5 bg-mention-bg text-mention hover:bg-mention-hover-bg transition-colors"
            >
              {mxidToMentionLabel(part)}
            </span>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

function extractUrls(text: string): string[] {
  const raw = text.match(URL_REGEX) || []
  const cleaned = raw.map((u) => splitTrailingPunctuation(u).cleanUrl).filter(Boolean)
  return Array.from(new Set(cleaned))
}

function removeUrlsFromText(text: string): string {
  const withoutUrls = text.replace(URL_REGEX, ' ')
  return withoutUrls.replace(/\s+/g, ' ').trim()
}

function getFaviconUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return `https://icons.duckduckgo.com/ip3/${parsed.hostname}.ico`
  } catch {
    return null
  }
}

function LinkPreviewCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<UrlPreviewData | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [faviconFailed, setFaviconFailed] = useState(false)
  const [imageSrc, setImageSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getUrlPreview(url).then((data) => {
      if (!cancelled) {
        setPreview(data)
        setImageSrc(data?.imageUrl || null)
        setImageFailed(false)
        setFaviconFailed(false)
        setLoaded(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [url])

  if (!loaded) return null
  const hostname = (() => {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  })()
  const faviconUrl = getFaviconUrl(url)

  const handlePreviewImageError = async () => {
    if (!preview?.imageUrl) {
      setImageFailed(true)
      return
    }
    const recovered = await loadMediaWithAuth(preview.imageUrl)
    if (recovered) {
      setImageSrc(recovered)
      return
    }
    setImageFailed(true)
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 flex rounded-lg overflow-hidden border border-border bg-bg-tertiary hover:border-accent-pink/50 transition-colors max-w-xl cursor-pointer"
    >
      <div className="w-24 h-24 shrink-0 border-r border-border/60 bg-bg-hover/40 flex items-center justify-center">
        {imageSrc && !imageFailed ? (
          <img
            src={imageSrc}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={handlePreviewImageError}
          />
        ) : faviconUrl && !faviconFailed ? (
          <img
            src={faviconUrl}
            alt=""
            className="w-9 h-9 rounded-md object-contain opacity-80"
            loading="lazy"
            onError={() => setFaviconFailed(true)}
          />
        ) : (
          <svg className="w-6 h-6 text-text-muted/70" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 8.25V6.75A2.25 2.25 0 0011.25 4.5h-4.5A2.25 2.25 0 004.5 6.75v10.5A2.25 2.25 0 006.75 19.5h10.5a2.25 2.25 0 002.25-2.25v-4.5A2.25 2.25 0 0017.25 10.5h-1.5m-7.5 3h7.5m-7.5 3h4.5M15 4.5h4.5m0 0V9m0-4.5L10.5 13.5" />
          </svg>
        )}
      </div>
      <div className="p-2.5 min-w-0 flex-1">
        {preview?.siteName && (
          <p className="text-[10px] text-text-muted uppercase tracking-wide truncate">{preview.siteName}</p>
        )}
        {preview?.title ? (
          <p className="text-sm font-semibold text-accent-pink line-clamp-2 leading-snug">{preview.title}</p>
        ) : (
          <p className="text-sm font-semibold text-accent-pink line-clamp-1 leading-snug">{hostname || 'Lien'}</p>
        )}
        {preview?.description ? (
          <p className="text-xs text-text-secondary line-clamp-4 leading-snug mt-0.5">{preview.description}</p>
        ) : (
          <p className="text-xs text-text-secondary line-clamp-2 leading-snug mt-0.5 break-all">{url}</p>
        )}
        {!preview?.siteName && hostname && (
          <p className="text-[10px] text-text-muted truncate mt-0.5">{hostname}</p>
        )}
      </div>
    </a>
  )
}

interface MessageItemProps {
  message: MessageEvent
  showHeader: boolean
}

function UserProfileCard({
  open,
  anchorRef,
  onClose,
  displayName,
  userId,
  avatarUrl,
  presence,
  powerLevel,
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  displayName: string
  userId: string
  avatarUrl: string | null
  presence: 'online' | 'offline' | 'unavailable'
  powerLevel: number
}) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const width = 320
      const margin = 12
      const left = Math.min(rect.left, window.innerWidth - width - margin)
      const top = rect.bottom + 8
      setCoords({ top, left: Math.max(margin, left) })
    }

    const handleDocumentClick = (e: MouseEvent) => {
      const target = e.target as Node
      const inCard = cardRef.current?.contains(target)
      const inAnchor = anchorRef.current?.contains(target)
      if (!inCard && !inAnchor) onClose()
    }

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    document.addEventListener('mousedown', handleDocumentClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('mousedown', handleDocumentClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open, anchorRef, onClose])

  if (!open || !coords) return null

  const role =
    powerLevel >= 100 ? 'Admin' : powerLevel >= 50 ? 'Modérateur' : 'Membre'
  const statusLabel =
    presence === 'online' ? 'En ligne' : presence === 'unavailable' ? 'Absent' : 'Hors ligne'

  return (
    <div
      ref={cardRef}
      className="fixed z-50 w-80 rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden"
      style={{ top: coords.top, left: coords.left }}
    >
      <div className="h-16 bg-gradient-to-r from-purple-500/80 to-accent-pink/70" />
      <div className="px-4 pb-4">
        <div className="-mt-8 mb-3">
          <Avatar src={avatarUrl} name={displayName} size={64} />
        </div>
        <p className="text-2xl font-bold leading-none text-text-primary">{displayName}</p>
        <p className="text-sm text-text-secondary mt-1">{userId}</p>
        <div className="mt-3 flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              presence === 'online' ? 'bg-success' : presence === 'unavailable' ? 'bg-warning' : 'bg-text-muted'
            }`}
          />
          <span className="text-xs text-text-secondary">{statusLabel}</span>
          <span className="text-xs text-text-muted">•</span>
          <span className="text-xs text-text-secondary">{role}</span>
        </div>
      </div>
    </div>
  )
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
      .then((blobUrl) => {
        if (!cancelled) setUrl(blobUrl)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [encryptedFile?.url])
  return { url, error }
}

function ImageWithFallback({
  src,
  alt,
  className,
  onClick,
  loading = 'lazy',
}: {
  src: string
  alt: string
  className: string
  onClick?: () => void
  loading?: 'lazy' | 'eager'
}) {
  const [displaySrc, setDisplaySrc] = useState(src)
  const [triedAuth, setTriedAuth] = useState(false)

  useEffect(() => {
    setDisplaySrc(src)
    setTriedAuth(false)
  }, [src])

  const handleError = async () => {
    if (triedAuth) return
    setTriedAuth(true)
    const recovered = await loadMediaWithAuth(src)
    if (recovered) {
      setDisplaySrc(recovered)
      return
    }
    const tokenUrl = getMediaUrlWithAccessToken(src)
    if (tokenUrl) setDisplaySrc(tokenUrl)
  }

  return (
    <img
      src={displaySrc}
      alt={alt}
      className={className}
      loading={loading}
      onClick={onClick}
      onError={handleError}
    />
  )
}

function PlainImage({ message }: { message: MessageEvent }) {
  const [fullscreen, setFullscreen] = useState(false)
  if (!message.imageUrl) return null

  return (
    <>
      <div className="mt-1 max-w-lg">
        <ImageWithFallback
          src={message.imageUrl}
          alt={message.content}
          className="rounded-lg max-h-80 object-contain cursor-pointer hover:opacity-90 transition-opacity"
          loading="lazy"
          onClick={() => setFullscreen(true)}
        />
      </div>
      {fullscreen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer" onClick={() => setFullscreen(false)}>
          <ImageWithFallback
            src={message.imageUrl}
            alt={message.content}
            className="max-w-[90vw] max-h-[90vh] object-contain"
            loading="eager"
          />
        </div>
      )}
    </>
  )
}

function EncryptedImage({ message }: { message: MessageEvent }) {
  const { url: decryptedUrl, error } = useDecryptedUrl(message.encryptedFile)
  const { url: thumbUrl } = useDecryptedUrl(message.encryptedThumbnailFile)
  const displayUrl = decryptedUrl || thumbUrl
  const [fullscreen, setFullscreen] = useState(false)

  if (error && !displayUrl) {
    return (
      <div className="mt-1 p-3 rounded-lg bg-bg-tertiary border border-border text-text-muted text-xs">
        Image chiffrée — impossible de déchiffrer
      </div>
    )
  }

  if (!displayUrl) {
    return (
      <div className="mt-1 rounded-lg bg-bg-tertiary animate-pulse flex items-center justify-center" style={{ width: 360, height: 220 }}>
        <svg className="w-6 h-6 text-text-muted" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
        </svg>
      </div>
    )
  }

  return (
    <>
      <div className="mt-1 max-w-lg">
        <ImageWithFallback src={displayUrl} alt={message.content} className="rounded-lg max-h-80 object-contain cursor-pointer hover:opacity-90 transition-opacity" onClick={() => setFullscreen(true)} />
      </div>
      {fullscreen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer" onClick={() => setFullscreen(false)}>
          <img src={decryptedUrl || displayUrl} alt={message.content} className="max-w-[90vw] max-h-[90vh] object-contain" />
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
        {message.fileSize != null && <div className="text-xs text-text-muted">{formatFileSize(message.fileSize)}</div>}
        {!url && message.encryptedFile && <div className="text-xs text-text-muted">Déchiffrement...</div>}
      </div>
    </button>
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
      <video src={videoUrl} poster={posterUrl || undefined} controls className="rounded-lg max-h-80" preload="metadata" />
    </div>
  )
}

export function MessageItem({ message, showHeader }: MessageItemProps) {
  const isMediaType = message.type === 'm.image' || message.type === 'm.video' || message.type === 'm.audio' || message.type === 'm.file'
  const urls = extractUrls(message.content)
  const contentWithoutUrls = removeUrlsFromText(message.content)
  const membersMap = useRoomStore((s) => s.members)
  const senderMember = useMemo(
    () => membersMap.get(message.roomId)?.find((m) => m.userId === message.sender),
    [membersMap, message.roomId, message.sender],
  )
  const [showProfile, setShowProfile] = useState(false)
  const senderNameRef = useRef<HTMLSpanElement | null>(null)

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
            <span
              ref={senderNameRef}
              className="font-semibold text-sm text-text-primary hover:underline cursor-pointer"
              onClick={() => setShowProfile((v) => !v)}
            >
              {message.senderName}
            </span>
            <span className="text-[11px] text-text-muted">{formatTimestamp(message.timestamp)}</span>
            {message.isEdited && <span className="text-[10px] text-text-muted">(modifié)</span>}
          </div>
        )}

        {message.type === 'm.image' && (message.imageUrl || message.encryptedFile) && (
          message.encryptedFile ? (
            <EncryptedImage message={message} />
          ) : (
            <PlainImage message={message} />
          )
        )}

        {message.type === 'm.video' && (message.fileUrl || message.encryptedFile) && <VideoAttachment message={message} />}
        {(message.type === 'm.file' || message.type === 'm.audio') && (message.fileUrl || message.encryptedFile) && (
          <FileAttachment message={message} />
        )}

        {(message.type === 'm.text' || message.type === 'm.notice' || message.type === 'm.emote') && (
          <>
            {(message.content.startsWith('🔒') || contentWithoutUrls.length > 0) && (
              <p className={`text-sm leading-relaxed break-words ${message.type === 'm.notice' ? 'text-text-muted italic' : 'text-text-primary'}`}>
                {message.type === 'm.emote' && <span className="text-text-secondary italic">* {message.senderName} </span>}
                {message.content.startsWith('🔒') ? (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-bg-tertiary rounded text-text-muted text-xs italic">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                    Message chiffré — clé de récupération requise
                  </span>
                ) : (
                  <RichText text={contentWithoutUrls} />
                )}
              </p>
            )}
            {urls.slice(0, 3).map((linkUrl) => (
              <LinkPreviewCard key={linkUrl} url={linkUrl} />
            ))}
          </>
        )}

        {!isMediaType && message.type !== 'm.text' && message.type !== 'm.notice' && message.type !== 'm.emote' && message.content && (
          <>
            {contentWithoutUrls.length > 0 && (
              <p className="text-sm text-text-primary leading-relaxed break-words"><RichText text={contentWithoutUrls} /></p>
            )}
            {urls.slice(0, 3).map((linkUrl) => (
              <LinkPreviewCard key={linkUrl} url={linkUrl} />
            ))}
          </>
        )}
      </div>
      <UserProfileCard
        open={showProfile}
        anchorRef={senderNameRef}
        onClose={() => setShowProfile(false)}
        displayName={senderMember?.displayName || message.senderName}
        userId={senderMember?.userId || message.sender}
        avatarUrl={senderMember?.avatarUrl || message.senderAvatar}
        presence={senderMember?.presence || 'offline'}
        powerLevel={senderMember?.powerLevel || 0}
      />
    </div>
  )
}
