import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react'
import { format, isToday, isYesterday } from 'date-fns'
import { fr } from 'date-fns/locale'
import { useMessageStore } from '../../stores/messageStore'
import { useUiStore } from '../../stores/uiStore'
import { useRoomStore } from '../../stores/roomStore'
import { loadThreadMessages, sendThreadReply } from '../../lib/matrix'
import { Avatar } from '../common/Avatar'
import type { MessageEvent, RoomMember } from '../../types/matrix'

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatThreadTimestamp(ts: number): string {
  const date = new Date(ts)
  if (isToday(date)) return format(date, 'HH:mm')
  if (isYesterday(date)) return `Hier ${format(date, 'HH:mm')}`
  return format(date, 'dd/MM/yyyy HH:mm', { locale: fr })
}

// Matches full MXIDs, localpart-only mentions, and room tags
const MENTION_SPLIT_RE = /(<@[^>\s]+>|@[A-Za-z0-9._=+\-/]+(?::[A-Za-z0-9.-]+(?::\d+)?)?)/g

function mxidToLabel(raw: string): string {
  const mxid = raw.replace(/^<@/, '').replace(/>$/, '').replace(/^@/, '')
  return `@${mxid.split(':')[0] || mxid}`
}

function isMxidToken(part: string): boolean {
  if (part.startsWith('<@')) return true
  return /^@[A-Za-z0-9._=+\-/]+:[A-Za-z0-9.-]/.test(part)
}

// Highlights @mentions with the same accent as the main chat
function ThreadMentionText({ text, knownLocalparts }: { text: string; knownLocalparts: Set<string> }) {
  const parts = text.split(MENTION_SPLIT_RE)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null
        if (isMxidToken(part)) {
          return (
            <span key={i} className="inline-flex items-center rounded px-1 py-0.5 bg-mention-bg text-mention">
              {mxidToLabel(part)}
            </span>
          )
        }
        // localpart-only @foo mention
        if (/^@[A-Za-z0-9._=+\-/]+$/.test(part) && knownLocalparts.has(part.slice(1).toLowerCase())) {
          return (
            <span key={i} className="inline-flex items-center rounded px-1 py-0.5 bg-mention-bg text-mention">
              {part}
            </span>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

function expandMentions(text: string, members: RoomMember[]): string {
  if (!text.includes('@')) return text
  const localpartToMxid = new Map<string, string>()
  for (const m of members) {
    const lp = m.userId.split(':')[0].slice(1).toLowerCase()
    if (lp) localpartToMxid.set(lp, m.userId)
  }
  return text.replace(/@([\w._\-=+/]+)/g, (match, lp: string) => {
    return localpartToMxid.get(lp.toLowerCase()) ?? match
  })
}

function compactPreview(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

// ─── sub-components ──────────────────────────────────────────────────────────

interface PendingReply { eventId: string; senderName: string; preview: string }

function ThreadMessageItem({
  message,
  showHeader,
  replyToMessage,
  knownLocalparts,
  onReply,
}: {
  message: MessageEvent
  showHeader: boolean
  replyToMessage: MessageEvent | null
  knownLocalparts: Set<string>
  onReply: (msg: MessageEvent) => void
}) {
  const isEncrypted = message.content.startsWith('🔒')

  return (
    <div
      className={`group flex items-start gap-3 px-4 py-1 hover:bg-bg-hover/20 transition-colors ${showHeader ? 'mt-3' : ''}`}
    >
      {showHeader ? (
        <Avatar src={message.senderAvatar} name={message.senderName} size={32} className="mt-0.5 shrink-0" />
      ) : (
        <div className="w-8 shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        {showHeader && (
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="font-semibold text-xs text-text-primary truncate">{message.senderName}</span>
            <span className="text-[10px] text-text-muted shrink-0">{formatThreadTimestamp(message.timestamp)}</span>
          </div>
        )}

        {/* Reply quote box */}
        {replyToMessage && (
          <div className="relative mb-1 mt-0.5 w-full rounded-md border border-accent-pink/35 border-l-[3px] border-l-accent-pink px-2.5 py-1.5">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1.5 h-3.5 w-4 rounded-bl-md border-b-2 border-l-2 border-accent-pink/85"
            />
            <p className="flex items-center gap-1.5 pl-5 text-xs text-text-secondary">
              Réponse à <span className="font-semibold text-accent-pink">{replyToMessage.senderName}</span>
            </p>
            <p className="mt-0.5 text-sm text-text-primary truncate leading-snug">
              <ThreadMentionText
                text={compactPreview(replyToMessage.content || 'Message de référence')}
                knownLocalparts={knownLocalparts}
              />
            </p>
          </div>
        )}

        {/* Message content */}
        <p className={`text-sm leading-relaxed break-words whitespace-pre-wrap ${isEncrypted ? 'text-text-muted italic' : 'text-text-primary'}`}>
          {isEncrypted
            ? message.content
            : <ThreadMentionText text={message.content || '(média)'} knownLocalparts={knownLocalparts} />
          }
        </p>
      </div>

      {/* Reply button — appears on hover */}
      {!isEncrypted && (
        <button
          onClick={() => onReply(message)}
          className="opacity-0 group-hover:opacity-100 shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-all cursor-pointer mt-0.5"
          title="Répondre"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5l-7.5-7.5 7.5-7.5M3 12h12a6 6 0 016 6v1.5" />
          </svg>
        </button>
      )}
    </div>
  )
}

// ─── main component ───────────────────────────────────────────────────────────

export function ThreadPanel() {
  const activeThreadRootId = useUiStore((s) => s.activeThreadRootId)
  const activeThreadRoomId = useUiStore((s) => s.activeThreadRoomId)
  const closeThreadPanel = useUiStore((s) => s.closeThreadPanel)
  const threadsVersion = useMessageStore((s) => s.threadsVersion)
  const getThreadMessages = useMessageStore((s) => s.getThreadMessages)
  const getMessages = useMessageStore((s) => s.getMessages)
  const membersMap = useRoomStore((s) => s.members)

  const roomMembers = useMemo<RoomMember[]>(
    () => (activeThreadRoomId ? membersMap.get(activeThreadRoomId) || [] : []),
    [activeThreadRoomId, membersMap],
  )

  // ── text input state ────────────────────────────────────────────────────────
  const [text, setText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pendingReply, setPendingReply] = useState<PendingReply | null>(null)

  // ── mention autocomplete state ──────────────────────────────────────────────
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionStart, setMentionStart] = useState(0)
  const [suggestionIndex, setSuggestionIndex] = useState(0)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nextCursorRef = useRef<number | null>(null)

  const threadMessages = activeThreadRootId ? getThreadMessages(activeThreadRootId) : []
  const rootMessage = activeThreadRootId && activeThreadRoomId
    ? getMessages(activeThreadRoomId).find((m) => m.eventId === activeThreadRootId) ?? null
    : null

  // ── load thread on open ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeThreadRootId || !activeThreadRoomId) return
    setText('')
    setPendingReply(null)
    let cancelled = false
    setLoading(true)
    loadThreadMessages(activeThreadRoomId, activeThreadRootId).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [activeThreadRootId, activeThreadRoomId])

  // ── scroll to bottom on new messages ───────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [threadsVersion, threadMessages.length])

  // ── restore cursor after mention insertion ─────────────────────────────────
  useEffect(() => {
    if (nextCursorRef.current !== null) {
      textareaRef.current?.setSelectionRange(nextCursorRef.current, nextCursorRef.current)
      nextCursorRef.current = null
    }
  })

  // ── known localparts for mention highlighting ──────────────────────────────
  const knownLocalparts = useMemo(() => {
    const set = new Set<string>()
    for (const m of roomMembers) {
      set.add(m.userId.split(':')[0].slice(1).toLowerCase())
    }
    return set
  }, [roomMembers])

  // ── lookup map for reply quotes ─────────────────────────────────────────────
  const allThreadMessages = useMemo(() => {
    const msgs = [...threadMessages]
    if (rootMessage) msgs.unshift(rootMessage)
    return msgs
  }, [threadMessages, rootMessage])

  // ── mention autocomplete ────────────────────────────────────────────────────
  const mentionSuggestions = useMemo((): RoomMember[] => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    return roomMembers
      .filter((m) => {
        const lp = m.userId.split(':')[0].slice(1).toLowerCase()
        return m.displayName.toLowerCase().includes(q) || lp.includes(q)
      })
      .slice(0, 8)
  }, [roomMembers, mentionQuery])

  const detectToken = useCallback((newText: string, cursorPos: number) => {
    const before = newText.slice(0, cursorPos)
    const atIdx = before.lastIndexOf('@')
    if (atIdx !== -1) {
      const query = before.slice(atIdx + 1)
      const charBefore = atIdx > 0 ? before[atIdx - 1] : ' '
      if (!query.includes(' ') && !query.includes('\n') && (/\s/.test(charBefore) || atIdx === 0)) {
        setMentionQuery(query)
        setMentionStart(atIdx)
        setSuggestionIndex(0)
        return
      }
    }
    setMentionQuery(null)
  }, [])

  const selectMention = useCallback(
    (member: RoomMember) => {
      const localpart = member.userId.split(':')[0].slice(1)
      const cursorPos = textareaRef.current?.selectionStart ?? mentionStart + (mentionQuery?.length ?? 0) + 1
      const before = text.slice(0, mentionStart)
      const after = text.slice(cursorPos)
      const newText = `${before}@${localpart} ${after}`
      setText(newText)
      setMentionQuery(null)
      nextCursorRef.current = before.length + localpart.length + 2
      textareaRef.current?.focus()
    },
    [text, mentionStart, mentionQuery],
  )

  // ── send ────────────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const body = expandMentions(text.trim(), roomMembers)
    if (!body || !activeThreadRootId || !activeThreadRoomId || isSending) return
    setIsSending(true)
    const replyId = pendingReply?.eventId
    setText('')
    setPendingReply(null)
    try {
      await sendThreadReply(activeThreadRoomId, activeThreadRootId, body, replyId)
    } catch (err) {
      console.error('[WaifuTxT] sendThreadReply failed:', err)
      setText(body)
    } finally {
      setIsSending(false)
      textareaRef.current?.focus()
    }
  }, [text, activeThreadRootId, activeThreadRoomId, isSending, pendingReply, roomMembers])

  // ── keyboard handling ───────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSuggestionIndex((i) => (i + 1) % mentionSuggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSuggestionIndex((i) => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectMention(mentionSuggestions[suggestionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionQuery(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }, [mentionQuery, mentionSuggestions, suggestionIndex, selectMention, handleSend])

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value
    const cursorPos = e.target.selectionStart ?? newText.length
    setText(newText)
    detectToken(newText, cursorPos)
    // auto-resize
    const t = e.currentTarget
    t.style.height = 'auto'
    t.style.height = `${Math.min(t.scrollHeight, 128)}px`
  }, [detectToken])

  // ── reply ───────────────────────────────────────────────────────────────────
  const handleReply = useCallback((msg: MessageEvent) => {
    setPendingReply({
      eventId: msg.eventId,
      senderName: msg.senderName,
      preview: compactPreview(msg.content || '(message)'),
    })
    textareaRef.current?.focus()
  }, [])

  if (!activeThreadRootId || !activeThreadRoomId) return null

  return (
    <div className="w-full lg:w-80 border-0 lg:border-l border-border bg-bg-primary lg:bg-bg-secondary flex flex-col shrink-0">
      {/* Header */}
      <div className="h-12 px-4 flex items-center gap-2 border-b border-border shrink-0">
        <svg className="w-4 h-4 text-accent-pink shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h8M8 8h5M8 16h6" />
          <rect x="3" y="3" width="18" height="18" rx="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h3 className="font-semibold text-sm text-text-primary flex-1">Fil de discussion</h3>
        {threadMessages.length > 0 && (
          <span className="text-xs text-text-muted">{threadMessages.length} réponse{threadMessages.length > 1 ? 's' : ''}</span>
        )}
        <button
          onClick={closeThreadPanel}
          className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title="Fermer"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Root message (frozen) */}
      {rootMessage && (
        <div className="px-4 py-3 border-b border-border/70 bg-bg-tertiary/40 shrink-0">
          <div className="flex items-start gap-3">
            <Avatar src={rootMessage.senderAvatar} name={rootMessage.senderName} size={32} className="mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 mb-0.5">
                <span className="font-semibold text-xs text-text-primary truncate">{rootMessage.senderName}</span>
                <span className="text-[10px] text-text-muted shrink-0">{formatThreadTimestamp(rootMessage.timestamp)}</span>
              </div>
              <p className="text-sm text-text-secondary leading-relaxed break-words line-clamp-4">
                {rootMessage.content || '(média)'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Thread replies */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
        {loading && threadMessages.length === 0 && (
          <div className="flex justify-center py-6">
            <svg className="animate-spin h-5 w-5 text-accent-pink" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}

        {!loading && threadMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
            <svg className="w-8 h-8 text-text-muted/40 mb-2" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h8M8 8h5M8 16h6" />
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
            <p className="text-sm text-text-muted">Aucune réponse pour l'instant</p>
            <p className="text-xs text-text-muted/60 mt-1">Soyez le premier à répondre dans ce fil</p>
          </div>
        )}

        {threadMessages.map((msg, i) => {
          const prev = threadMessages[i - 1]
          const showHeader = !prev || prev.sender !== msg.sender || (msg.timestamp - prev.timestamp) > 5 * 60 * 1000
          const replyToMessage = msg.replyTo ? allThreadMessages.find((m) => m.eventId === msg.replyTo) ?? null : null
          return (
            <ThreadMessageItem
              key={msg.eventId}
              message={msg}
              showHeader={showHeader}
              replyToMessage={replyToMessage}
              knownLocalparts={knownLocalparts}
              onReply={handleReply}
            />
          )
        })}
      </div>

      {/* Input area */}
      <div className="border-t border-border shrink-0 px-3 py-2 relative">

        {/* Mention autocomplete dropdown (above input) */}
        {mentionQuery !== null && mentionSuggestions.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 rounded-lg border border-border bg-bg-secondary shadow-lg overflow-hidden z-10">
            {mentionSuggestions.map((member, idx) => (
              <button
                key={member.userId}
                onMouseDown={(e) => { e.preventDefault(); selectMention(member) }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer ${
                  idx === suggestionIndex ? 'bg-bg-active' : 'hover:bg-bg-hover'
                }`}
              >
                <Avatar src={member.avatarUrl} name={member.displayName} size={22} className="shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-text-primary truncate">{member.displayName}</p>
                  <p className="text-[10px] text-text-muted truncate">{member.userId.split(':')[0].slice(1)}</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Pending reply bar */}
        {pendingReply && (
          <div className="mb-2 rounded border-l-2 border-accent-pink/70 bg-accent-pink/8 px-2 py-1.5 flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <p className="flex items-center gap-1 text-[11px] text-text-secondary">
                <svg className="h-3 w-3 text-accent-pink/90 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5l-7.5-7.5 7.5-7.5M3 12h12a6 6 0 016 6v1.5" />
                </svg>
                Réponse à <span className="font-medium text-accent-pink ml-0.5">{pendingReply.senderName}</span>
              </p>
              <p className="text-[11px] text-text-primary truncate mt-0.5">{pendingReply.preview}</p>
            </div>
            <button
              onClick={() => setPendingReply(null)}
              className="text-[10px] text-text-muted hover:text-text-primary transition-colors shrink-0 cursor-pointer"
            >
              Annuler
            </button>
          </div>
        )}

        {/* Text input */}
        <div className="flex items-end gap-2 rounded-lg bg-bg-tertiary border border-border px-3 py-2 focus-within:border-accent-pink/50 transition-colors">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Répondre dans le fil…"
            rows={1}
            disabled={isSending}
            className="flex-1 resize-none bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none leading-relaxed max-h-32 overflow-y-auto disabled:opacity-50"
            style={{ height: 'auto' }}
          />
          <button
            onClick={() => void handleSend()}
            disabled={!text.trim() || isSending}
            className="shrink-0 p-1.5 rounded-md text-accent-pink hover:bg-accent-pink/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
            title="Envoyer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.269 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>
        <p className="text-[10px] text-text-muted/50 mt-1 px-1">Entrée pour envoyer · Maj+Entrée pour saut de ligne</p>
      </div>
    </div>
  )
}
