import { format, isToday, isYesterday } from 'date-fns'
import { fr } from 'date-fns/locale'
import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,

} from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { EmojiPicker, addRecentEmoji } from '../common/EmojiPicker'
import { MessageContextMenu } from './MessageContextMenu'
import { useLongPress } from '../../hooks/useLongPress'
import type { EncryptedFileInfo, MessageEvent, RoomSummary } from '../../types/matrix'
import { Avatar } from '../common/Avatar'
import { UserProfileCard } from '../common/UserProfileCard'
import { useRoomStore } from '../../stores/roomStore'
import { useAuthStore } from '../../stores/authStore'
import { useMessageStore } from '../../stores/messageStore'
import {
  decryptMediaUrl,
  getMessageReadersAtEvent,
  getMessageReactions,
  getMediaUrlWithAccessToken,
  getStoredOwnStatusMessage,
  sendEditMessage,
  getUrlPreview,
  loadMediaWithAuth,
  toggleReaction,
  pinMessage,
  unpinMessage,
  canUserPinMessages,
  redactMessage,
  canUserRedact,
  type UrlPreviewData,
} from '../../lib/matrix'
import { useUiStore } from '../../stores/uiStore'

const URL_REGEX = /(?:https?:\/\/[^\s<>"']+|(?:www\.)[^\s<>"']+|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+(?:com|org|net|io|dev|co|me|app|xyz|info|fr|de|uk|eu|gov|edu|tv|gg|ai|sh|cc|be|to|fm|ly|gl|it|us|ca|au|jp|ru|br|in|nl|ch|se|no|fi|es|pt|pl|cz|sk|at|be|dk|ie|nz)(?:\/[^\s<>"']*)?)/gi
// Matches: URLs, <@user:server>, @user:server, @user (localpart-only), #room
const TOKEN_REGEX = /((?:https?:\/\/[^\s<>"']+|(?:www\.)[^\s<>"']+|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+(?:com|org|net|io|dev|co|me|app|xyz|info|fr|de|uk|eu|gov|edu|tv|gg|ai|sh|cc|be|to|fm|ly|gl|it|us|ca|au|jp|ru|br|in|nl|ch|se|no|fi|es|pt|pl|cz|sk|at|be|dk|ie|nz)(?:\/[^\s<>"']*)?)|<@[^>\s]+>|@[A-Za-z0-9._=+\-/]+(?::[A-Za-z0-9.-]+(?::\d+)?)?|#[A-Za-z0-9._=+\-/]+)/gi
const MENTION_REGEX = /(<@[^>\s]+>|@[A-Za-z0-9._=+\-/]+(?::[A-Za-z0-9.-]+(?::\d+)?)?|#[A-Za-z0-9._=+\-/]+)/g

function mxidToMentionLabel(raw: string): string {
  const mxid = raw.replace(/^<@/, '').replace(/>$/, '').replace(/^@/, '')
  const localpart = mxid.split(':')[0] || mxid
  return `@${localpart}`
}

function isMentionToken(part: string, knownLocalparts: Set<string>): boolean {
  if (part.startsWith('<@')) return true
  if (/^@[A-Za-z0-9._=+\-/]+:[A-Za-z0-9.-]/.test(part)) return true // full MXID
  if (/^@[A-Za-z0-9._=+\-/]+$/.test(part)) {
    return knownLocalparts.has(part.slice(1).toLowerCase())
  }
  return false
}

function normalizeRoomTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^#/, '')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
}

function roomNameToTag(roomName: string): string {
  const normalized = normalizeRoomTag(roomName)
  return normalized ? `#${normalized}` : ''
}

function getRoomServerName(roomId: string): string {
  const firstColon = roomId.indexOf(':')
  if (firstColon === -1) return ''
  return roomId.slice(firstColon + 1).toLowerCase()
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

function RichText({
  text,
  roomTagToId,
  onOpenRoomTag,
  knownLocalparts,
}: {
  text: string
  roomTagToId: Map<string, string>
  onOpenRoomTag: (roomId: string) => void
  knownLocalparts: Set<string>
}) {
  const parts = text.split(TOKEN_REGEX)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null
        if (URL_REGEX.test(part)) {
          URL_REGEX.lastIndex = 0
          const { cleanUrl, trailing } = splitTrailingPunctuation(part)
          const href = /^https?:\/\//i.test(cleanUrl) ? cleanUrl : `https://${cleanUrl}`
          return (
            <span key={i}>
              <a
                href={href}
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
        if (isMentionToken(part, knownLocalparts)) {
          return (
            <span
              key={i}
              className="inline-flex items-center rounded px-1 py-0.5 bg-mention-bg text-mention hover:bg-mention-hover-bg transition-colors"
            >
              {mxidToMentionLabel(part)}
            </span>
          )
        }
        if (part.startsWith('#')) {
          const normalizedTag = `#${normalizeRoomTag(part)}`
          const roomId = roomTagToId.get(normalizedTag)
          if (roomId) {
            return (
              <button
                key={i}
                onClick={() => onOpenRoomTag(roomId)}
                className="inline-flex items-center rounded px-1 py-0.5 bg-mention-bg text-mention hover:bg-mention-hover-bg transition-colors cursor-pointer"
              >
                {part}
              </button>
            )
          }
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

function MentionText({
  text,
  roomTagToId,
  onOpenRoomTag,
  knownLocalparts,
}: {
  text: string
  roomTagToId: Map<string, string>
  onOpenRoomTag: (roomId: string) => void
  knownLocalparts: Set<string>
}) {
  const parts = text.split(MENTION_REGEX)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null
        if (isMentionToken(part, knownLocalparts)) {
          return (
            <span
              key={i}
              className="inline-flex items-center rounded px-1 py-0.5 bg-mention-bg text-mention hover:bg-mention-hover-bg transition-colors"
            >
              {mxidToMentionLabel(part)}
            </span>
          )
        }
        if (part.startsWith('#')) {
          const normalizedTag = `#${normalizeRoomTag(part)}`
          const roomId = roomTagToId.get(normalizedTag)
          if (roomId) {
            return (
              <button
                key={i}
                onClick={() => onOpenRoomTag(roomId)}
                className="inline-flex items-center rounded px-1 py-0.5 bg-mention-bg text-mention hover:bg-mention-hover-bg transition-colors cursor-pointer"
              >
                {part}
              </button>
            )
          }
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

function decorateMentions(
  children: ReactNode,
  roomTagToId: Map<string, string>,
  onOpenRoomTag: (roomId: string) => void,
  knownLocalparts: Set<string>,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string') return <MentionText text={child} roomTagToId={roomTagToId} onOpenRoomTag={onOpenRoomTag} knownLocalparts={knownLocalparts} />
    if (!isValidElement<{ children?: ReactNode }>(child)) return child
    const childChildren = child.props.children
    if (childChildren == null) return child
    return cloneElement(child, { children: decorateMentions(childChildren, roomTagToId, onOpenRoomTag, knownLocalparts) })
  })
}

function hasMarkdownSyntax(text: string): boolean {
  return /(^|\s)([#>*-]|\d+\.)|(\*\*|__|~~|`)|\[[^\]]+\]\([^)]+\)/m.test(text)
}

function MarkdownText({
  text,
  className,
  roomTagToId,
  onOpenRoomTag,
  knownLocalparts,
}: {
  text: string
  className?: string
  roomTagToId: Map<string, string>
  onOpenRoomTag: (roomId: string) => void
  knownLocalparts: Set<string>
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        p: ({ children }) => <p className={className || 'text-sm leading-relaxed break-words text-text-primary'}>{decorateMentions(children, roomTagToId, onOpenRoomTag, knownLocalparts)}</p>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link hover:text-link-hover hover:underline break-all"
          >
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{decorateMentions(children, roomTagToId, onOpenRoomTag, knownLocalparts)}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{decorateMentions(children, roomTagToId, onOpenRoomTag, knownLocalparts)}</ol>,
        li: ({ children }) => <li className="text-sm leading-relaxed text-text-primary">{decorateMentions(children, roomTagToId, onOpenRoomTag, knownLocalparts)}</li>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-border-strong pl-3 text-text-secondary italic my-1">
            {decorateMentions(children, roomTagToId, onOpenRoomTag, knownLocalparts)}
          </blockquote>
        ),
        code: ({ className: codeClassName, children }) => {
          const isBlock = !!codeClassName
          if (isBlock) {
            return (
              <code className={`${codeClassName} block bg-bg-tertiary border border-border rounded-md p-2 text-xs overflow-x-auto`}>
                {children}
              </code>
            )
          }
          return <code className="bg-bg-tertiary border border-border rounded px-1 py-0.5 text-xs">{children}</code>
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function extractUrls(text: string): string[] {
  const raw = text.match(URL_REGEX) || []
  const cleaned = raw.map((u) => {
    const clean = splitTrailingPunctuation(u).cleanUrl
    if (!clean) return ''
    return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
  }).filter(Boolean)
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

function getYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.includes('youtube.com')) {
      const v = parsed.searchParams.get('v')
      if (v) return v
      const m = parsed.pathname.match(/\/(?:shorts|embed)\/([a-zA-Z0-9_-]+)/)
      if (m) return m[1]
    }
    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0]
      return id || null
    }
  } catch {}
  return null
}

type SocialPlatform = 'twitter' | 'instagram' | 'tiktok' | null

function detectSocialPlatform(url: string): SocialPlatform {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '')
    if (h === 'twitter.com' || h === 'x.com') return 'twitter'
    if (h === 'instagram.com') return 'instagram'
    if (h === 'tiktok.com' || h === 'vm.tiktok.com') return 'tiktok'
  } catch {}
  return null
}

function getTikTokVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)
    const h = parsed.hostname.replace(/^www\./, '')
    if (h === 'tiktok.com') {
      const m = parsed.pathname.match(/\/video\/(\d+)/)
      if (m) return m[1]
    }
  } catch {}
  return null
}


const DIRECT_IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?.*)?$/i
const DIRECT_VIDEO_EXT = /\.(mp4|webm|ogg|mov)(\?.*)?$/i

function isDirectImageUrl(url: string): boolean {
  try { return DIRECT_IMAGE_EXT.test(new URL(url).pathname) } catch { return false }
}

function isDirectVideoUrl(url: string): boolean {
  try { return DIRECT_VIDEO_EXT.test(new URL(url).pathname) } catch { return false }
}

function YouTubeEmbed({ url, videoId }: { url: string; videoId: string }) {
  const [playing, setPlaying] = useState(false)
  const thumb = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`

  return (
    <div className="mt-1.5 max-w-xl rounded-lg overflow-hidden border border-border">
      {playing ? (
        <div className="relative" style={{ paddingTop: '56.25%' }}>
          <iframe
            className="absolute inset-0 w-full h-full"
            src={`https://www.youtube.com/embed/${videoId}?autoplay=1`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            title="YouTube"
          />
        </div>
      ) : (
        <div
          className="relative cursor-pointer group"
          style={{ paddingTop: '56.25%' }}
          onClick={() => setPlaying(true)}
        >
          <img
            src={thumb}
            alt="YouTube"
            className="absolute inset-0 w-full h-full object-cover"
            referrerPolicy="no-referrer"
          />
          <div className="absolute inset-0 bg-black/30 group-hover:bg-black/10 transition-colors flex items-center justify-center">
            <div className="w-16 h-11 rounded-xl bg-red-600 group-hover:bg-red-500 transition-colors flex items-center justify-center shadow-xl">
              <svg className="w-6 h-6 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        </div>
      )}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 px-3 py-2 bg-bg-tertiary border-t border-border hover:bg-bg-hover transition-colors"
      >
        <svg className="w-4 h-4 shrink-0 text-red-500" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z" />
        </svg>
        <span className="text-xs text-text-muted truncate">{url}</span>
      </a>
    </div>
  )
}

function TikTokEmbed({ url, videoId }: { url: string; videoId: string }) {
  return (
    <div className="mt-1.5 max-w-[320px] rounded-lg overflow-hidden border border-border border-l-4 border-l-[#FE2C55]">
      <div className="relative" style={{ paddingTop: '177.77%' }}>
        <iframe
          className="absolute inset-0 w-full h-full"
          src={`https://www.tiktok.com/embed/v2/${videoId}`}
          allow="encrypted-media"
          allowFullScreen
          title="TikTok"
          style={{ border: 'none' }}
        />
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 px-3 py-2 bg-bg-tertiary border-t border-border hover:bg-bg-hover transition-colors"
      >
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34v-7.1a8.16 8.16 0 0 0 4.77 1.52V6.28a4.85 4.85 0 0 1-1-.41z"/>
        </svg>
        <span className="text-xs text-text-muted truncate">{url}</span>
      </a>
    </div>
  )
}

function DirectImageEmbed({ url }: { url: string }) {
  const [expanded, setExpanded] = useState(false)
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <>
      <div
        className="mt-1.5 inline-block rounded-lg overflow-hidden border border-border cursor-zoom-in max-w-sm"
        onClick={() => setExpanded(true)}
      >
        <img
          src={url}
          alt=""
          className="max-w-full max-h-72 object-contain block"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </div>
      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center cursor-zoom-out"
          onClick={() => setExpanded(false)}
        >
          <img
            src={url}
            alt=""
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
    </>
  )
}

function DirectVideoEmbed({ url }: { url: string }) {
  return (
    <div className="mt-1.5 max-w-xl rounded-lg overflow-hidden border border-border">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        src={url}
        controls
        className="w-full max-h-72 bg-black block"
        preload="metadata"
      />
    </div>
  )
}

// Media section for social cards: tries native video playback, falls back to thumbnail + external link
function SocialMediaSection({
  url,
  imageSrc,
  videoUrl,
  videoType,
  onImageError,
  onExpand,
}: {
  url: string
  imageSrc: string | null
  videoUrl?: string
  videoType?: string
  onImageError: () => void
  onExpand?: () => void
}) {
  const [videoFailed, setVideoFailed] = useState(false)

  // Attempt native video only for mp4/webm (not HTML embed URLs)
  const isNativeVideo =
    videoUrl &&
    !videoFailed &&
    (videoType === 'video/mp4' ||
      videoType === 'video/webm' ||
      /\.(mp4|webm)(\?.*)?$/i.test(videoUrl))

  if (isNativeVideo) {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        src={videoUrl}
        controls
        className="w-full max-h-80 bg-black block border-b border-border"
        preload="metadata"
        onError={() => setVideoFailed(true)}
      />
    )
  }

  if (!imageSrc) return null

  // Image post: click to expand; video post: play button overlay linking out
  return (
    <div className="relative">
      <img
        src={imageSrc}
        alt=""
        className={`w-full max-h-80 object-cover border-b border-border ${!videoUrl && onExpand ? 'cursor-zoom-in' : ''}`}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={onImageError}
        onClick={!videoUrl ? onExpand : undefined}
      />
      {videoUrl && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute inset-0 bg-black/25 hover:bg-black/15 transition-colors flex items-center justify-center"
        >
          <div className="w-14 h-14 rounded-full bg-black/70 ring-2 ring-white/20 flex items-center justify-center">
            <svg className="w-7 h-7 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </a>
      )}
    </div>
  )
}

function GenericLinkPreviewCard({ url, platform }: { url: string; platform: SocialPlatform }) {
  const [preview, setPreview] = useState<UrlPreviewData | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [faviconFailed, setFaviconFailed] = useState(false)
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

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
    return () => { cancelled = true }
  }, [url])

  if (!loaded) return null

  const hostname = (() => { try { return new URL(url).hostname } catch { return '' } })()
  const faviconUrl = getFaviconUrl(url)

  const handleImageError = async () => {
    if (!preview?.imageUrl) { setImageFailed(true); return }
    const recovered = await loadMediaWithAuth(preview.imageUrl)
    if (recovered) { setImageSrc(recovered); return }
    setImageFailed(true)
  }

  // ── Twitter / Instagram / TikTok (no video ID): rich media card ──
  if (platform === 'twitter' || platform === 'instagram' || platform === 'tiktok') {
    const accentClass =
      platform === 'twitter' ? 'border-l-[#1d9bf0]' :
      platform === 'instagram' ? 'border-l-[#e1306c]' :
      'border-l-[#FE2C55]'

    const platformIcon =
      platform === 'twitter' ? (
        // X / Twitter logo
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
        </svg>
      ) : platform === 'instagram' ? (
        // Instagram logo
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/>
        </svg>
      ) : (
        // TikTok logo
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34v-7.1a8.16 8.16 0 0 0 4.77 1.52V6.28a4.85 4.85 0 0 1-1-.41z"/>
        </svg>
      )

    return (
      <>
        <div className={`mt-1.5 rounded-lg overflow-hidden border border-border bg-bg-tertiary max-w-md border-l-4 ${accentClass}`}>
          {!imageFailed && (
            <SocialMediaSection
              url={url}
              imageSrc={imageSrc}
              videoUrl={preview?.videoUrl}
              videoType={preview?.videoType}
              onImageError={handleImageError}
              onExpand={() => setExpanded(true)}
            />
          )}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="block p-2.5 hover:bg-bg-hover/50 transition-colors"
          >
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-text-muted">{platformIcon}</span>
              <span className="text-[10px] text-text-muted uppercase tracking-wide">{preview?.siteName || hostname}</span>
            </div>
            {preview?.title && (
              <p className="text-sm font-semibold text-text-primary line-clamp-2 leading-snug">{preview.title}</p>
            )}
            {preview?.description && (
              <p className="text-xs text-text-secondary line-clamp-3 leading-snug mt-0.5">{preview.description}</p>
            )}
          </a>
        </div>
        {expanded && imageSrc && (
          <div
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center cursor-zoom-out"
            onClick={() => setExpanded(false)}
          >
            <img
              src={imageSrc}
              alt=""
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
              referrerPolicy="no-referrer"
            />
          </div>
        )}
      </>
    )
  }

  // ── Generic card ──
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
            onError={handleImageError}
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

function compactPreview(text: string, max = 90): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1)}...`
}

function LinkPreviewCard({ url }: { url: string }) {
  const ytId = getYouTubeVideoId(url)
  if (ytId) return <YouTubeEmbed url={url} videoId={ytId} />
  const ttId = getTikTokVideoId(url)
  if (ttId) return <TikTokEmbed url={url} videoId={ttId} />
  if (isDirectImageUrl(url)) return <DirectImageEmbed url={url} />
  if (isDirectVideoUrl(url)) return <DirectVideoEmbed url={url} />
  return <GenericLinkPreviewCard url={url} platform={detectSocialPlatform(url)} />
}

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

function formatAudioTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function VoiceMessagePlayer({ message }: { message: MessageEvent }) {
  const { url: decryptedUrl } = useDecryptedUrl(message.encryptedFile)
  const audioUrl = message.fileUrl || decryptedUrl
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(message.audioDuration ? message.audioDuration / 1000 : 0)
  const progressRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTimeUpdate = () => setCurrentTime(audio.currentTime)
    const onLoadedMetadata = () => {
      if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration)
    }
    const onEnded = () => { setIsPlaying(false); setCurrentTime(0) }
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('ended', onEnded)
    }
  }, [audioUrl])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      audio.play().then(() => setIsPlaying(true)).catch(() => {})
    }
  }, [isPlaying])

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current
    const bar = progressRef.current
    if (!audio || !bar || !duration) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = ratio * duration
    setCurrentTime(audio.currentTime)
  }, [duration])

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  if (!audioUrl) {
    return (
      <div className="mt-1 flex items-center gap-3 p-3 bg-bg-tertiary rounded-lg border border-border max-w-xs animate-pulse">
        <div className="w-9 h-9 rounded-full bg-bg-hover" />
        <div className="flex-1 h-3 rounded bg-bg-hover" />
      </div>
    )
  }

  return (
    <div className="mt-1 flex items-center gap-3 p-2.5 bg-bg-tertiary rounded-xl border border-border max-w-xs group">
      <audio ref={audioRef} src={audioUrl} preload="metadata" />
      <button
        onClick={togglePlay}
        className="w-9 h-9 shrink-0 rounded-full bg-accent-pink text-white flex items-center justify-center hover:bg-accent-pink-hover transition-colors cursor-pointer"
        aria-label={isPlaying ? 'Pause' : 'Lecture'}
      >
        {isPlaying ? (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5.14v14l11-7-11-7z" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div
          ref={progressRef}
          onClick={handleSeek}
          className="relative h-6 flex items-center cursor-pointer"
        >
          <div className="w-full h-1.5 rounded-full bg-border overflow-hidden">
            <div
              className="h-full rounded-full bg-accent-pink transition-[width] duration-100"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <div className="flex justify-between text-[10px] text-text-muted -mt-0.5">
          <span>{formatAudioTime(currentTime * 1000)}</span>
          <span>{formatAudioTime(duration * 1000)}</span>
        </div>
      </div>
    </div>
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
  const renderContent = useMemo(
    () => (hasMarkdownSyntax(message.content) ? message.content : contentWithoutUrls),
    [message.content, contentWithoutUrls],
  )
  const session = useAuthStore((s) => s.session)
  const receiptsVersion = useMessageStore((s) => s.receiptsVersion)
  const reactionsVersion = useMessageStore((s) => s.reactionsVersion)
  const replaceMessage = useMessageStore((s) => s.replaceMessage)
  const messagesMap = useMessageStore((s) => s.messages)
  const roomsMap = useRoomStore((s) => s.rooms)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const setActiveSpace = useRoomStore((s) => s.setActiveSpace)
  const membersMap = useRoomStore((s) => s.members)
  const setPendingReply = useUiStore((s) => s.setPendingReply)
  const roomMembers = useMemo(() => membersMap.get(message.roomId) || [], [membersMap, message.roomId])
  const repliedMessage = useMemo(() => {
    if (!message.replyTo) return null
    const roomMessages = messagesMap.get(message.roomId) || []
    return roomMessages.find((m) => m.eventId === message.replyTo) || null
  }, [message.replyTo, message.roomId, messagesMap])
  const senderMember = useMemo(
    () => roomMembers.find((m) => m.userId === message.sender),
    [roomMembers, message.sender],
  )
  const senderIdForProfile = senderMember?.userId ?? message.sender
  const profileCardPresence = useRoomStore((s) => s.presenceMap[senderIdForProfile])
  const profileCardStatusMessage = useRoomStore((s) => s.statusMessageMap[senderIdForProfile])
  const isOwnMessage = !!session?.userId && message.sender === session.userId
  const isSyncedMessage = message.eventId.startsWith('$')
  const canEditMessage =
    isOwnMessage &&
    isSyncedMessage &&
    message.type === 'm.text' &&
    !message.content.startsWith('🔒')
  const isEncrypted = message.content.startsWith('🔒')
  const canReplyMessage = isSyncedMessage
  const canReactMessage = isSyncedMessage
  const canDeleteMessage = isSyncedMessage && !isEncrypted && canUserRedact(message.roomId, message.sender)
  const canCopyMessage = !isEncrypted && (message.type === 'm.text' || message.type === 'm.notice' || message.type === 'm.emote')
  const canPinMessage = isSyncedMessage && !isEncrypted && canUserPinMessages(message.roomId)
  const canStartThread = isSyncedMessage && !isEncrypted && !message.threadRootId
  const pinnedVersion = useMessageStore((s) => s.pinnedVersion)
  const pinnedEventIds = useMessageStore((s) => s.pinnedEventIds)
  const threadsVersion = useMessageStore((s) => s.threadsVersion)
  const openThreadPanel = useUiStore((s) => s.openThreadPanel)
  void threadsVersion // subscribe for live updates on threadInfo
  const isPinned = useMemo(() => {
    const ids = pinnedEventIds.get(message.roomId) || []
    return ids.includes(message.eventId)
  }, [pinnedEventIds, message.roomId, message.eventId, pinnedVersion])
  const isDeletedNoticeMessage =
    message.type === 'm.notice' && message.content.trim().toLowerCase() === 'message supprimé'
  const readersUserIds = useMemo(
    () => (isOwnMessage ? getMessageReadersAtEvent(message.roomId, message.eventId, message.sender) : []),
    [isOwnMessage, message.roomId, message.eventId, message.sender, receiptsVersion],
  )
  const readers = useMemo(
    () =>
      readersUserIds.map((userId) => {
        const member = roomMembers.find((m) => m.userId === userId)
        return {
          userId,
          displayName: member?.displayName || userId,
          avatarUrl: member?.avatarUrl || null,
        }
      }),
    [readersUserIds, roomMembers],
  )
  const reactions = useMemo(
    () => (canReactMessage ? getMessageReactions(message.roomId, message.eventId) : []),
    [canReactMessage, message.roomId, message.eventId, reactionsVersion],
  )
  const roomTagToId = useMemo(() => {
    const map = new Map<string, string>()
    const currentRoomServer = getRoomServerName(message.roomId)
    for (const room of roomsMap.values()) {
      if (room.isSpace || room.isDirect || room.membership !== 'join') continue
      const roomServer = getRoomServerName(room.roomId)
      if (currentRoomServer && roomServer !== currentRoomServer) continue
      const tag = roomNameToTag(room.name)
      if (!tag) continue
      if (!map.has(tag)) map.set(tag, room.roomId)
    }
    return map
  }, [message.roomId, roomsMap])
  const knownLocalparts = useMemo(() => {
    const set = new Set<string>()
    for (const m of roomMembers) {
      const lp = m.userId.split(':')[0].slice(1).toLowerCase()
      if (lp) set.add(lp)
    }
    return set
  }, [roomMembers])
  const handleOpenRoomTag = useCallback((roomId: string) => {
    // Keep the space sidebar in sync with the opened room when possible.
    for (const room of roomsMap.values()) {
      if (room.isSpace && room.children.includes(roomId)) {
        setActiveSpace(room.roomId)
        break
      }
    }
    setActiveRoom(roomId)
  }, [roomsMap, setActiveRoom, setActiveSpace])
  const [showProfile, setShowProfile] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editDraft, setEditDraft] = useState(message.content)
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [showReactionPicker, setShowReactionPicker] = useState(false)
  const [pickerDir, setPickerDir] = useState<'up' | 'down'>('up')
  const showActionBar = !isEditing && (canReplyMessage || canEditMessage || canReactMessage || canPinMessage || canCopyMessage || canDeleteMessage)
  const actionButtonClass =
    'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-bg-tertiary/85 text-text-secondary hover:text-text-primary hover:border-accent-pink/60 hover:bg-bg-hover transition-all cursor-pointer shadow-sm'
  const senderNameRef = useRef<HTMLSpanElement | null>(null)
  const reactionPickerRef = useRef<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const editTargetEventId = useUiStore((s) => s.editTargetEventId)
  const setEditTargetEventId = useUiStore((s) => s.setEditTargetEventId)

  useEffect(() => {
    setEditDraft(message.content)
  }, [message.eventId, message.content])

  // Triggered from keyboard shortcut (ArrowUp in empty MessageInput)
  useEffect(() => {
    if (editTargetEventId === message.eventId && canEditMessage) {
      setIsEditing(true)
      setEditError(null)
      setEditTargetEventId(null)
      setTimeout(() => {
        wrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 30)
    }
  }, [editTargetEventId, message.eventId, canEditMessage, setEditTargetEventId])

  useEffect(() => {
    if (!showReactionPicker) return
    // Détermine si le picker doit s'ouvrir vers le haut ou le bas
    if (wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect()
      // 444 = hauteur du picker, 40 = marge de sécurité
      setPickerDir(rect.top >= 484 ? 'up' : 'down')
    }
    const onClickOutside = (event: MouseEvent) => {
      if (!reactionPickerRef.current) return
      if (reactionPickerRef.current.contains(event.target as Node)) return
      setShowReactionPicker(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [showReactionPicker])

  // Auto-focus edit textarea whenever edit mode activates
  useEffect(() => {
    if (isEditing && editTextareaRef.current) {
      editTextareaRef.current.focus()
      const len = editTextareaRef.current.value.length
      editTextareaRef.current.setSelectionRange(len, len)
    }
  }, [isEditing])

  const handleSaveEdit = useCallback(async () => {
    const nextBody = editDraft.trim()
    if (!nextBody || nextBody === message.content) {
      setIsEditing(false)
      return
    }
    setIsSavingEdit(true)
    setEditError(null)
    try {
      await sendEditMessage(message.roomId, message.eventId, nextBody)
      replaceMessage(message.roomId, message.eventId, {
        ...message,
        content: nextBody,
        htmlContent: null,
        isEdited: true,
      })
      setIsEditing(false)
    } catch (err) {
      console.error('[WaifuTxT] Edit message failed:', err)
      setEditError(err instanceof Error ? err.message : "Impossible d'envoyer la modification")
    } finally {
      setIsSavingEdit(false)
    }
  }, [editDraft, message, replaceMessage])

  const handleToggleReaction = useCallback(async (emoji: string) => {
    try {
      await toggleReaction(message.roomId, message.eventId, emoji)
      useMessageStore.getState().bumpReactionsVersion()
    } catch (err) {
      console.error('[WaifuTxT] Toggle reaction failed:', err)
    }
  }, [message.roomId, message.eventId])

  const [pinError, setPinError] = useState<string | null>(null)
  const [isPinning, setIsPinning] = useState(false)

  const handleTogglePin = useCallback(async () => {
    if (isPinning) return
    setIsPinning(true)
    setPinError(null)
    try {
      if (isPinned) {
        await unpinMessage(message.roomId, message.eventId)
      } else {
        await pinMessage(message.roomId, message.eventId)
      }
    } catch (err) {
      console.error('[WaifuTxT] Toggle pin failed:', err)
      const e = err as { httpStatus?: number; errcode?: string; message?: string; status?: number }
      const status = e?.httpStatus ?? e?.status ?? 0
      const errcode = e?.errcode ?? ''
      const msg = e?.message ?? ''
      const isForbidden =
        status === 403 ||
        errcode === 'M_FORBIDDEN' ||
        msg.includes('403') ||
        msg.toLowerCase().includes('forbidden') ||
        msg.toLowerCase().includes('power level')
      setPinError(isForbidden ? 'Droits insuffisants' : `Erreur : ${msg.replace('MatrixError: ', '').slice(0, 40) || 'inconnue'}`)
      setTimeout(() => setPinError(null), 5000)
    } finally {
      setIsPinning(false)
    }
  }, [message.roomId, message.eventId, isPinned, isPinning])

  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showContextMenu, setShowContextMenu] = useState(false)

  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches
  const longPress = useLongPress(() => { if (isMobile && showActionBar) setShowContextMenu(true) })

  const handleDelete = useCallback(async () => {
    if (isDeleting) return
    setIsDeleting(true)
    setDeleteError(null)
    try {
      await redactMessage(message.roomId, message.eventId)
      setShowDeleteConfirm(false)
    } catch (err) {
      const e = err as { message?: string }
      setDeleteError(e?.message?.slice(0, 50) || 'Erreur de suppression')
      setTimeout(() => setDeleteError(null), 4000)
    } finally {
      setIsDeleting(false)
    }
  }, [message.roomId, message.eventId, isDeleting])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }, [message.content])

  return (
    <div ref={wrapperRef} className={`group relative flex items-start gap-4 px-4 py-0.5 pr-24 hover:bg-bg-hover/30 transition-colors ${showHeader ? 'mt-4' : ''} ${isPinned ? 'border-l-2 border-l-accent-pink/50' : ''}`} {...(isMobile ? longPress : {})}>
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
        {showActionBar && (
          <div
            className={`absolute right-2 top-1 flex items-center gap-1 transition-opacity ${
              showReactionPicker
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto'
            }`}
          >
            {canReplyMessage && (
              <button
                onClick={() =>
                  setPendingReply({
                    roomId: message.roomId,
                    eventId: message.eventId,
                    senderName: message.senderName,
                    preview: compactPreview(message.content || '(message)'),
                  })
                }
                className={actionButtonClass}
                title="Répondre au message"
                aria-label="Répondre au message"
              >
                <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5l-7.5-7.5 7.5-7.5M3 12h12a6 6 0 016 6v1.5" />
                </svg>
              </button>
            )}

            {canStartThread && (
              <button
                onClick={() => openThreadPanel(message.roomId, message.eventId)}
                className={actionButtonClass}
                title="Fil de discussion"
                aria-label="Ouvrir le fil de discussion"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h8M8 8h5M8 16h6" />
                  <rect x="3" y="3" width="18" height="18" rx="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}

            {canEditMessage && (
              <button
                onClick={() => {
                  setEditError(null)
                  setIsEditing(true)
                }}
                className={actionButtonClass}
                title="Modifier le message"
                aria-label="Modifier le message"
              >
                <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 3.487a2.1 2.1 0 113 2.974l-10.5 10.5-4.2 1.2 1.2-4.2 10.5-10.474z" />
                </svg>
              </button>
            )}

            {canPinMessage && (
              <div className="relative">
                <button
                  onClick={handleTogglePin}
                  disabled={isPinning}
                  className={`${actionButtonClass} ${isPinned ? '!text-accent-pink !border-accent-pink/60 !bg-accent-pink/10' : ''} ${isPinning ? 'opacity-50' : ''}`}
                  title={isPinned ? 'Désépingler' : 'Épingler'}
                  aria-label={isPinned ? 'Désépingler le message' : 'Épingler le message'}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
                  </svg>
                </button>
                {pinError && (
                  <div className="absolute bottom-full right-0 mb-1 whitespace-nowrap rounded bg-red-500/90 px-2 py-1 text-[10px] text-white shadow-lg z-50">
                    {pinError}
                  </div>
                )}
              </div>
            )}

            {canReactMessage && (
              <div className="relative">
                <button
                  onClick={() => setShowReactionPicker((v) => !v)}
                  className={actionButtonClass}
                  title="Réagir"
                  aria-label="Réagir"
                >
                  <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
                {showReactionPicker && (
                  <div
                    ref={reactionPickerRef}
                    className={`absolute right-0 z-30 ${pickerDir === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'}`}
                  >
                    <EmojiPicker
                      onSelect={(emoji) => {
                        addRecentEmoji(emoji)
                        setShowReactionPicker(false)
                        void handleToggleReaction(emoji)
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {canCopyMessage && (
              <button
                onClick={handleCopy}
                className={`${actionButtonClass} ${copied ? '!text-success !border-success/60' : ''}`}
                title={copied ? 'Copié !' : 'Copier le message'}
                aria-label="Copier le message"
              >
                {copied ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                  </svg>
                )}
              </button>
            )}

            {canDeleteMessage && (
              <div className="relative">
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className={`${actionButtonClass} hover:!text-danger hover:!border-danger/60`}
                  title="Supprimer le message"
                  aria-label="Supprimer le message"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </button>
                {deleteError && (
                  <div className="absolute bottom-full right-0 mb-1 whitespace-nowrap rounded bg-red-500/90 px-2 py-1 text-[10px] text-white shadow-lg z-50">
                    {deleteError}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

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
          </div>
        )}

        {message.replyTo && (() => {
          const replyContent = repliedMessage?.content || ''
          const isMentioned = !!session?.userId && (
            replyContent.includes(`<@${session.userId}>`) ||
            replyContent.includes(session.userId)
          )
          return (
            <div className={`relative mb-1 mt-0.5 w-full rounded-md border border-accent-pink/35 border-l-[3px] border-l-accent-pink px-2.5 py-1.5${isMentioned ? ' bg-accent-pink/12' : ''}`}>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1.5 h-3.5 w-4 rounded-bl-md border-b-2 border-l-2 border-accent-pink/85"
              />
              <p className="flex items-center gap-1.5 pl-5 text-xs text-text-secondary">
                Réponse à <span className="font-semibold text-accent-pink">{repliedMessage?.senderName || 'message'}</span>
              </p>
              <p className="mt-0.5 text-sm text-text-primary truncate leading-snug">
                <MentionText text={compactPreview(replyContent || 'Message de référence')} roomTagToId={roomTagToId} onOpenRoomTag={handleOpenRoomTag} knownLocalparts={knownLocalparts} />
              </p>
            </div>
          )
        })()}

        {message.type === 'm.image' && (message.imageUrl || message.encryptedFile) && (
          message.encryptedFile ? (
            <EncryptedImage message={message} />
          ) : (
            <PlainImage message={message} />
          )
        )}

        {message.type === 'm.video' && (message.fileUrl || message.encryptedFile) && <VideoAttachment message={message} />}
        {message.type === 'm.audio' && message.isVoiceMessage && (message.fileUrl || message.encryptedFile) && (
          <VoiceMessagePlayer message={message} />
        )}
        {(message.type === 'm.file' || (message.type === 'm.audio' && !message.isVoiceMessage)) && (message.fileUrl || message.encryptedFile) && (
          <FileAttachment message={message} />
        )}

        {(message.type === 'm.text' || message.type === 'm.notice' || message.type === 'm.emote') && (
          <>
            {isEditing ? (
              <div className="mt-1 rounded-lg border border-border bg-bg-tertiary/70 p-2.5">
                <textarea
                  ref={editTextareaRef}
                  value={editDraft}
                  onChange={(e) => {
                    setEditDraft(e.target.value)
                    if (editError) setEditError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSaveEdit()
                    } else if (e.key === 'Escape') {
                      setIsEditing(false)
                      setEditDraft(message.content)
                    }
                  }}
                  className="w-full min-h-20 resize-y text-sm"
                  placeholder="Modifier votre message..."
                />
                {editError && <p className="mt-2 text-xs text-red-300">{editError}</p>}
                <div className="mt-2 flex items-center justify-end gap-2">
                  <button
                    onClick={() => {
                      setIsEditing(false)
                      setEditDraft(message.content)
                    }}
                    className="px-2.5 py-1 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                  >
                    Annuler
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    disabled={isSavingEdit || !editDraft.trim()}
                    className="px-2.5 py-1 text-xs rounded-md bg-accent-pink text-white hover:bg-accent-pink-hover disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-not-allowed"
                  >
                    {isSavingEdit ? 'Enregistrement...' : 'Enregistrer'}
                  </button>
                </div>
              </div>
            ) : (
              (message.content.startsWith('🔒') || contentWithoutUrls.length > 0) && (
              <>
                {message.type === 'm.emote' && <p className="text-sm leading-relaxed text-text-secondary italic">* {message.senderName}</p>}
                {message.content.startsWith('🔒') ? (
                  <p className="text-sm leading-relaxed break-words text-text-primary">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-bg-tertiary rounded text-text-muted text-xs italic">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                      Message chiffré — clé de récupération requise
                    </span>
                  </p>
                ) : isDeletedNoticeMessage ? (
                  <p className="inline-flex items-center gap-1.5 text-sm leading-relaxed break-words text-text-muted italic">
                    <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12m-9 0V5.75A1.75 1.75 0 0110.75 4h2.5A1.75 1.75 0 0115 5.75V7m-8 0l.75 11.25A1.75 1.75 0 009.5 20h5a1.75 1.75 0 001.75-1.75L17 7" />
                    </svg>
                    Message supprimé
                  </p>
                ) : (
                  <MarkdownText
                    text={renderContent}
                    className={`text-sm leading-relaxed break-words ${message.type === 'm.notice' ? 'text-text-muted italic' : 'text-text-primary'}`}
                    roomTagToId={roomTagToId}
                    onOpenRoomTag={handleOpenRoomTag}
                    knownLocalparts={knownLocalparts}
                  />
                )}
              </>
              )
            )}
            {!isEditing && urls.slice(0, 3).map((linkUrl) => (
              <LinkPreviewCard key={linkUrl} url={linkUrl} />
            ))}
          </>
        )}

        {!isMediaType && message.type !== 'm.text' && message.type !== 'm.notice' && message.type !== 'm.emote' && message.content && (
          <>
            {contentWithoutUrls.length > 0 && (
              <p className="text-sm text-text-primary leading-relaxed break-words">
                <RichText text={contentWithoutUrls} roomTagToId={roomTagToId} onOpenRoomTag={handleOpenRoomTag} knownLocalparts={knownLocalparts} />
              </p>
            )}
            {urls.slice(0, 3).map((linkUrl) => (
              <LinkPreviewCard key={linkUrl} url={linkUrl} />
            ))}
          </>
        )}

        {!isEditing && message.isEdited && (
          <span className="mt-0.5 inline-block text-[10px] text-text-muted">(modifié)</span>
        )}

        {!isEditing && reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {reactions.map((reaction) => (
              <button
                key={reaction.key}
                onClick={() => void handleToggleReaction(reaction.key)}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors cursor-pointer ${
                  reaction.reactedByMe
                    ? 'border-accent-pink/60 bg-accent-pink/20 text-text-primary'
                    : 'border-border bg-bg-tertiary text-text-secondary hover:text-text-primary hover:border-border-strong'
                }`}
                title={reaction.senders.join(', ')}
              >
                <span className="text-sm leading-none">{reaction.key}</span>
                <span>{reaction.count}</span>
              </button>
            ))}
          </div>
        )}

        {!isEditing && message.threadInfo && message.threadInfo.replyCount > 0 && (
          <button
            onClick={() => openThreadPanel(message.roomId, message.eventId)}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-bg-tertiary/60 px-2.5 py-0.5 text-xs text-text-secondary hover:border-accent-pink/60 hover:text-text-primary transition-colors cursor-pointer"
          >
            <Avatar
              src={message.threadInfo.lastReplierAvatar}
              name={message.threadInfo.lastReplierName}
              size={14}
            />
            <span className="font-medium text-accent-pink">
              {message.threadInfo.replyCount} réponse{message.threadInfo.replyCount > 1 ? 's' : ''}
            </span>
            <span className="text-text-muted text-[10px]">
              {format(new Date(message.threadInfo.lastReplyTs), 'HH:mm')}
            </span>
          </button>
        )}

      </div>
      {isOwnMessage && readers.length > 0 && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5">
          {readers.slice(0, 3).map((reader) => (
            <Avatar
              key={reader.userId}
              src={reader.avatarUrl}
              name={reader.displayName}
              size={14}
              className="ring-1 ring-bg-primary/80"
            />
          ))}
          {readers.length > 3 && (
            <span className="text-[10px] text-text-muted leading-none">+{readers.length - 3}</span>
          )}
        </div>
      )}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4" onClick={() => setShowDeleteConfirm(false)}>
          <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-text-primary">Supprimer le message ?</h3>
            <p className="mt-1.5 text-sm text-text-secondary">
              {isOwnMessage ? 'Ce message sera supprimé pour tout le monde.' : 'Tu vas supprimer le message de quelqu\'un d\'autre.'}
            </p>
            <div className="mt-1.5 rounded-md bg-bg-tertiary border border-border p-2">
              <p className="text-xs text-text-muted truncate">{message.senderName}</p>
              <p className="text-sm text-text-primary truncate">{message.content || '(média)'}</p>
            </div>
            {deleteError && <p className="mt-2 text-xs text-danger">{deleteError}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-3 py-1.5 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Annuler
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="px-3 py-1.5 text-sm rounded-md bg-danger text-white hover:bg-danger/80 disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                {isDeleting ? 'Suppression...' : 'Supprimer'}
              </button>
            </div>
          </div>
        </div>
      )}
      <UserProfileCard
        open={showProfile}
        anchorRef={senderNameRef}
        onClose={() => setShowProfile(false)}
        displayName={senderMember?.displayName || message.senderName}
        userId={senderMember?.userId || message.sender}
        avatarUrl={senderMember?.avatarUrl || message.senderAvatar}
        presence={profileCardPresence ?? senderMember?.presence ?? 'offline'}
        powerLevel={senderMember?.powerLevel || 0}
        statusMessage={
          isOwnMessage
            ? profileCardStatusMessage?.trim() || getStoredOwnStatusMessage().trim() || null
            : profileCardStatusMessage
        }
      />
      <MessageContextMenu
        open={showContextMenu}
        onClose={() => setShowContextMenu(false)}
        canReact={canReactMessage}
        onReact={(emoji) => { addRecentEmoji(emoji); void handleToggleReaction(emoji) }}
        canReply={canReplyMessage}
        onReply={() => setPendingReply({ roomId: message.roomId, eventId: message.eventId, senderName: message.senderName, preview: compactPreview(message.content || '(message)') })}
        canThread={canStartThread}
        onThread={() => openThreadPanel(message.roomId, message.eventId)}
        canEdit={canEditMessage}
        onEdit={() => { setEditError(null); setIsEditing(true) }}
        canPin={canPinMessage}
        isPinned={isPinned}
        isPinning={isPinning}
        onTogglePin={handleTogglePin}
        canCopy={canCopyMessage}
        copied={copied}
        onCopy={handleCopy}
        canDelete={canDeleteMessage}
        onDelete={() => setShowDeleteConfirm(true)}
      />
    </div>
  )
}
