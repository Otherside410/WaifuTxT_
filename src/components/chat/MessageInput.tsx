import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react'
import emojibaseShortcodes from 'emojibase-data/en/shortcodes/emojibase.json'
import emojibaseData from 'emojibase-data/en/data.json'
import { useRoomStore } from '../../stores/roomStore'
import { useUiStore } from '../../stores/uiStore'
import { useAuthStore } from '../../stores/authStore'
import { sendMessage, sendFile, sendImage, sendAudio, sendTyping } from '../../lib/matrix'
import { Avatar } from '../common/Avatar'
import type { RoomMember, RoomSummary } from '../../types/matrix'
import { EmojiPicker, addRecentEmoji } from '../common/EmojiPicker'

interface PendingImage {
  id: string
  file: File
  previewUrl: string
}

interface EmojiSuggestion {
  emoji: string
  shortcode: string
}

function unifiedToEmoji(unified: string): string {
  const codepoints = unified
    .split('-')
    .map((hex) => parseInt(hex, 16))
    .filter((cp) => Number.isFinite(cp))
  if (codepoints.length === 0) return ''
  try {
    return String.fromCodePoint(...codepoints)
  } catch {
    return ''
  }
}

function toShortcode(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function buildEmojiSuggestions(): EmojiSuggestion[] {
  const sc = emojibaseShortcodes as Record<string, string | string[]>
  const seen = new Set<string>()
  const result: EmojiSuggestion[] = []

  const sorted = [...(emojibaseData as { hexcode: string; emoji: string; order?: number }[])]
    .sort((a, b) => (a.order ?? 99999) - (b.order ?? 99999))

  for (const entry of sorted) {
    const value = sc[entry.hexcode] ?? sc[entry.hexcode.toLowerCase()]
    if (!value) continue
    const shortcodes = Array.isArray(value) ? value : [value]
    for (const raw of shortcodes) {
      const shortcode = toShortcode(raw)
      if (!shortcode || seen.has(shortcode)) continue
      seen.add(shortcode)
      result.push({ emoji: entry.emoji, shortcode })
    }
  }

  return result
}

const EMOJI_SUGGESTIONS = buildEmojiSuggestions()
const SHORTCODE_TO_EMOJI = new Map(EMOJI_SUGGESTIONS.map((entry) => [entry.shortcode, entry.emoji]))

function replaceEmojiShortcodes(input: string): string {
  return input.replace(/:([a-z0-9_]+):/gi, (full, rawCode: string) => {
    const normalized = toShortcode(rawCode)
    return SHORTCODE_TO_EMOJI.get(normalized) || full
  })
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

function getHomeserverHost(homeserver: string): string {
  try {
    return new URL(homeserver).host.toLowerCase()
  } catch {
    return homeserver.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
  }
}

function highlightInputText(text: string, validLocalparts: Set<string>, validRoomTags: Set<string>): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  return escaped
    .replace(/@[\w._\-=+/]+|#[\w._\-=+/]+/g, (match) => {
      if (match.startsWith('@')) {
        const localpart = match.slice(1).toLowerCase()
        if (validLocalparts.has(localpart)) {
          return `<mark style="border-radius:0.25rem;background:var(--color-mention-bg);color:var(--color-mention)">${match}</mark>`
        }
        return match
      }
      const normalizedTag = `#${normalizeRoomTag(match)}`
      if (normalizedTag.length > 1 && validRoomTags.has(normalizedTag)) {
        return `<mark style="border-radius:0.25rem;background:var(--color-mention-bg);color:var(--color-mention)">${match}</mark>`
      }
      return match
    }) + '\u200b'
}

const TAG_TOKEN_RE = /(?:@[\w._\-=+/]+|#[\w._\-=+/]+)/g

export function MessageInput() {
  const [text, setText] = useState('')
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [isSending, setIsSending] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionStart, setMentionStart] = useState(0)
  const [roomTagQuery, setRoomTagQuery] = useState<string | null>(null)
  const [roomTagStart, setRoomTagStart] = useState(0)
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null)
  const [emojiStart, setEmojiStart] = useState(0)
  const [suggestionIndex, setSuggestionIndex] = useState(0)

  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const activeSpaceId = useRoomStore((s) => s.activeSpaceId)
  const membersMap = useRoomStore((s) => s.members)
  const roomsMap = useRoomStore((s) => s.rooms)
  const session = useAuthStore((s) => s.session)
  const pendingMention = useUiStore((s) => s.pendingMention)
  const setPendingMention = useUiStore((s) => s.setPendingMention)
  const pendingReply = useUiStore((s) => s.pendingReply)
  const setPendingReply = useUiStore((s) => s.setPendingReply)
  const chatInputFocusBump = useUiStore((s) => s.chatInputFocusBump)
  const roomMembers = useMemo<RoomMember[]>(
    () => (activeRoomId ? membersMap.get(activeRoomId) || [] : []),
    [activeRoomId, membersMap],
  )
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [emojiPickerMounted, setEmojiPickerMounted] = useState(false)

  const [isRecording, setIsRecording] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingImagesRef = useRef<PendingImage[]>([])
  const nextCursorRef = useRef<number | null>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const emojiBtnRef = useRef<HTMLButtonElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingStartRef = useRef<number>(0)

  // Restore cursor position after a mention insertion/deletion re-render
  useEffect(() => {
    if (nextCursorRef.current !== null) {
      textareaRef.current?.setSelectionRange(nextCursorRef.current, nextCursorRef.current)
      nextCursorRef.current = null
    }
  })

  // Focus textarea when the chat area is clicked or when switching rooms
  useEffect(() => {
    if (chatInputFocusBump > 0) textareaRef.current?.focus()
  }, [chatInputFocusBump])

  useEffect(() => {
    if (activeRoomId) textareaRef.current?.focus()
  }, [activeRoomId])

  // Mount the picker on first open, keep it alive after that
  useEffect(() => {
    if (showEmojiPicker) setEmojiPickerMounted(true)
  }, [showEmojiPicker])

  // Close emoji picker on outside click
  useEffect(() => {
    if (!showEmojiPicker) return
    const handler = (e: MouseEvent) => {
      if (
        emojiPickerRef.current?.contains(e.target as Node) ||
        emojiBtnRef.current?.contains(e.target as Node)
      )
        return
      setShowEmojiPicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showEmojiPicker])

  // Inject mention from UserProfileCard / MemberPanel
  useEffect(() => {
    if (!pendingMention) return
    setText((prev) => (prev ? `${prev} ${pendingMention} ` : `${pendingMention} `))
    setPendingMention(null)
    textareaRef.current?.focus()
  }, [pendingMention, setPendingMention])

  // Set of localparts for valid mention highlighting
  const validLocalparts = useMemo(() => {
    const set = new Set<string>()
    for (const m of roomMembers) {
      set.add(m.userId.split(':')[0].slice(1).toLowerCase())
    }
    return set
  }, [roomMembers])
  const validRoomTags = useMemo(() => {
    const effectiveSpaceId = activeSpaceId || (() => {
      if (!activeRoomId) return null
      for (const room of roomsMap.values()) {
        if (room.isSpace && room.children.includes(activeRoomId)) return room.roomId
      }
      return null
    })()
    const activeRoomServer = activeRoomId ? getRoomServerName(activeRoomId) : ''
    const homeserverHost = session?.homeserver ? getHomeserverHost(session.homeserver) : ''
    const scopedRooms: RoomSummary[] = effectiveSpaceId
      ? (roomsMap.get(effectiveSpaceId)?.children || [])
          .map((roomId) => roomsMap.get(roomId))
          .filter((room): room is RoomSummary => !!room && !room.isSpace && !room.isDirect)
      : Array.from(roomsMap.values()).filter((room) => !room.isSpace && !room.isDirect)

    const set = new Set<string>()
    for (const room of scopedRooms) {
      const roomServer = getRoomServerName(room.roomId)
      if (activeRoomServer && roomServer !== activeRoomServer) continue
      if (homeserverHost && roomServer !== homeserverHost) continue
      const tag = roomNameToTag(room.name)
      if (tag) set.add(tag)
    }
    return set
  }, [activeRoomId, activeSpaceId, roomsMap, session?.homeserver])

  // Filtered autocomplete suggestions
  const mentionSuggestions = useMemo((): RoomMember[] => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    return roomMembers
      .filter((m) => {
        const localpart = m.userId.split(':')[0].slice(1).toLowerCase()
        return m.displayName.toLowerCase().includes(q) || localpart.includes(q)
      })
      .slice(0, 8)
  }, [roomMembers, mentionQuery])

  const roomSuggestions = useMemo((): RoomSummary[] => {
    if (roomTagQuery === null) return []
    const effectiveSpaceId = activeSpaceId || (() => {
      if (!activeRoomId) return null
      for (const room of roomsMap.values()) {
        if (room.isSpace && room.children.includes(activeRoomId)) return room.roomId
      }
      return null
    })()
    const q = normalizeRoomTag(roomTagQuery)
    const activeRoomServer = activeRoomId ? getRoomServerName(activeRoomId) : ''
    const homeserverHost = session?.homeserver ? getHomeserverHost(session.homeserver) : ''
    const scopedRooms: RoomSummary[] = effectiveSpaceId
      ? (roomsMap.get(effectiveSpaceId)?.children || [])
          .map((roomId) => roomsMap.get(roomId))
          .filter((room): room is RoomSummary => !!room && !room.isSpace && !room.isDirect)
      : Array.from(roomsMap.values()).filter((room) => !room.isSpace && !room.isDirect)

    return scopedRooms
      .filter((room) => {
        const roomServer = getRoomServerName(room.roomId)
        if (activeRoomServer && roomServer !== activeRoomServer) return false
        if (homeserverHost && roomServer !== homeserverHost) return false
        return true
      })
      .filter((room) => {
        const normalizedName = normalizeRoomTag(room.name)
        if (!q) return true
        return normalizedName.includes(q)
      })
      .slice(0, 8)
  }, [activeRoomId, activeSpaceId, roomsMap, roomTagQuery, session?.homeserver])

  const emojiSuggestions = useMemo((): EmojiSuggestion[] => {
    if (emojiQuery === null || emojiQuery.length < 3) return []
    const q = toShortcode(emojiQuery)
    if (!q) return []
    // Filtrage strict: on ne suggère que les emojis dont le shortcode contient la séquence.
    return EMOJI_SUGGESTIONS.filter((entry) => entry.shortcode.includes(q)).slice(0, 8)
  }, [emojiQuery])

  // Detect active @mention or #room-tag query at cursor position
  const detectToken = useCallback((newText: string, cursorPos: number) => {
    const before = newText.slice(0, cursorPos)
    const atIdx = before.lastIndexOf('@')
    const hashIdx = before.lastIndexOf('#')
    const colonIdx = before.lastIndexOf(':')
    const start = Math.max(atIdx, hashIdx, colonIdx)
    if (start !== -1) {
      const trigger = before[start]
      const query = before.slice(start + 1)
      const charBefore = start > 0 ? before[start - 1] : ' '
      if (!query.includes(' ') && !query.includes('\n') && (/\s/.test(charBefore) || start === 0)) {
        if (trigger === '@') {
          setMentionQuery(query)
          setMentionStart(start)
          setRoomTagQuery(null)
          setEmojiQuery(null)
        } else {
          if (trigger === '#') {
            setRoomTagQuery(query)
            setRoomTagStart(start)
            setMentionQuery(null)
            setEmojiQuery(null)
          } else {
            setEmojiQuery(query)
            setEmojiStart(start)
            setMentionQuery(null)
            setRoomTagQuery(null)
          }
        }
        setSuggestionIndex(0)
        return
      }
    }
    setMentionQuery(null)
    setRoomTagQuery(null)
    setEmojiQuery(null)
  }, [])

  const selectMentionSuggestion = useCallback(
    (member: RoomMember) => {
      const localpart = member.userId.split(':')[0].slice(1)
      const cursorPos =
        textareaRef.current?.selectionStart ?? mentionStart + (mentionQuery?.length ?? 0) + 1
      const before = text.slice(0, mentionStart)
      const after = text.slice(cursorPos)
      const newText = `${before}@${localpart} ${after}`
      setText(newText)
      setMentionQuery(null)
      setRoomTagQuery(null)
      setEmojiQuery(null)
      nextCursorRef.current = before.length + localpart.length + 2 // @ + localpart + space
      textareaRef.current?.focus()
    },
    [text, mentionStart, mentionQuery],
  )

  const selectRoomSuggestion = useCallback(
    (room: RoomSummary) => {
      const roomTag = roomNameToTag(room.name)
      if (!roomTag) return
      const cursorPos =
        textareaRef.current?.selectionStart ?? roomTagStart + (roomTagQuery?.length ?? 0) + 1
      const before = text.slice(0, roomTagStart)
      const after = text.slice(cursorPos)
      const newText = `${before}${roomTag} ${after}`
      setText(newText)
      setMentionQuery(null)
      setRoomTagQuery(null)
      setEmojiQuery(null)
      nextCursorRef.current = before.length + roomTag.length + 1 // #tag + space
      textareaRef.current?.focus()
    },
    [text, roomTagStart, roomTagQuery],
  )

  const selectEmojiSuggestion = useCallback(
    (entry: EmojiSuggestion) => {
      const cursorPos =
        textareaRef.current?.selectionStart ?? emojiStart + (emojiQuery?.length ?? 0) + 1
      const before = text.slice(0, emojiStart)
      const after = text.slice(cursorPos)
      const insertion = `:${entry.shortcode}: `
      const newText = `${before}${insertion}${after}`
      setText(newText)
      setMentionQuery(null)
      setRoomTagQuery(null)
      setEmojiQuery(null)
      nextCursorRef.current = before.length + insertion.length
      textareaRef.current?.focus()
    },
    [text, emojiStart, emojiQuery],
  )

  const handleSend = useCallback(async () => {
    if (isSending || !activeRoomId) return
    const msg = replaceEmojiShortcodes(text.trim())
    if (!msg && pendingImages.length === 0) return

    setIsSending(true)
    try {
      sendTyping(activeRoomId, false)
      if (pendingImages.length > 0) {
        for (const image of pendingImages) {
          await sendImage(activeRoomId, image.file)
          URL.revokeObjectURL(image.previewUrl)
        }
        setPendingImages([])
      }
      if (msg) {
        setText('')
        await sendMessage(activeRoomId, msg, pendingReply?.roomId === activeRoomId ? pendingReply.eventId : undefined)
        if (pendingReply?.roomId === activeRoomId) {
          setPendingReply(null)
        }
      }
    } finally {
      setIsSending(false)
    }
  }, [activeRoomId, isSending, pendingImages, pendingReply, setPendingReply, text])

  const handleKeyDown = (e: KeyboardEvent) => {
    // Autocomplete navigation takes priority
    const hasMentionSuggestions = mentionQuery !== null && mentionSuggestions.length > 0
    const hasRoomSuggestions = roomTagQuery !== null && roomSuggestions.length > 0
    const hasEmojiSuggestions = emojiQuery !== null && emojiSuggestions.length > 0
    const hasAutocomplete = hasMentionSuggestions || hasRoomSuggestions || hasEmojiSuggestions
    const activeSuggestionsLength = hasMentionSuggestions
      ? mentionSuggestions.length
      : hasRoomSuggestions
        ? roomSuggestions.length
        : emojiSuggestions.length
    if (hasAutocomplete) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSuggestionIndex((i) => (i + 1) % activeSuggestionsLength)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSuggestionIndex((i) => (i - 1 + activeSuggestionsLength) % activeSuggestionsLength)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (hasMentionSuggestions) {
          selectMentionSuggestion(mentionSuggestions[suggestionIndex])
        } else if (hasRoomSuggestions) {
          selectRoomSuggestion(roomSuggestions[suggestionIndex])
        } else {
          selectEmojiSuggestion(emojiSuggestions[suggestionIndex])
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionQuery(null)
        setRoomTagQuery(null)
        setEmojiQuery(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
      return
    }

    // Whole-token deletion — only when NOT actively typing a mention query
    if (mentionQuery === null && roomTagQuery === null && emojiQuery === null && (e.key === 'Backspace' || e.key === 'Delete')) {
      const textarea = textareaRef.current
      if (!textarea) return
      const { selectionStart, selectionEnd } = textarea
      if (selectionStart !== selectionEnd) return

      TAG_TOKEN_RE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = TAG_TOKEN_RE.exec(text)) !== null) {
        const start = match.index
        const end = match.index + match[0].length
        const hit =
          e.key === 'Backspace'
            ? selectionStart > start && selectionStart <= end
            : selectionStart >= start && selectionStart < end
        if (hit) {
          e.preventDefault()
          const newText = text.slice(0, start) + text.slice(end)
          nextCursorRef.current = start
          setText(newText)
          return
        }
      }
    }
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value
    setText(newText)
    detectToken(newText, e.target.selectionStart ?? newText.length)
    if (!activeRoomId) return

    sendTyping(activeRoomId, true)
    if (typingTimeoutRef.current !== null) clearTimeout(typingTimeoutRef.current)
    typingTimeoutRef.current = setTimeout(() => {
      sendTyping(activeRoomId, false)
    }, 4000)
  }

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !activeRoomId) return

    if (file.type.startsWith('image/')) {
      await sendImage(activeRoomId, file)
    } else {
      await sendFile(activeRoomId, file)
    }
    e.target.value = ''
  }

  const startRecording = useCallback(async () => {
    if (!activeRoomId) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      recorder.start(100)
      mediaRecorderRef.current = recorder
      recordingStartRef.current = Date.now()
      setIsRecording(true)
      setRecordingDuration(0)
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - recordingStartRef.current) / 1000))
      }, 500)
    } catch {
      // permission denied or not available
    }
  }, [activeRoomId])

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || !activeRoomId) return
    recorder.onstop = async () => {
      const duration = (Date.now() - recordingStartRef.current) / 1000
      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType })
      recorder.stream.getTracks().forEach((t) => t.stop())
      audioChunksRef.current = []
      await sendAudio(activeRoomId, blob, duration)
    }
    recorder.stop()
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    mediaRecorderRef.current = null
    setIsRecording(false)
    setRecordingDuration(0)
  }, [activeRoomId])

  const cancelRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder) return
    recorder.onstop = () => {
      recorder.stream.getTracks().forEach((t) => t.stop())
      audioChunksRef.current = []
    }
    recorder.stop()
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    mediaRecorderRef.current = null
    setIsRecording(false)
    setRecordingDuration(0)
  }, [])

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!activeRoomId) return
    const items = e.clipboardData?.items
    if (!items || items.length === 0) return

    const imageFiles: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }

    if (imageFiles.length === 0) return

    e.preventDefault()
    const addedImages = imageFiles.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }))
    setPendingImages((prev) => [...prev, ...addedImages])
  }

  const syncScroll = useCallback(() => {
    if (backdropRef.current && textareaRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [])

  const removePendingImage = (id: string) => {
    setPendingImages((prev) => {
      const img = prev.find((p) => p.id === id)
      if (img) URL.revokeObjectURL(img.previewUrl)
      return prev.filter((p) => p.id !== id)
    })
  }

  const clearPendingImages = () => {
    setPendingImages((prev) => {
      for (const image of prev) URL.revokeObjectURL(image.previewUrl)
      return []
    })
  }

  useEffect(() => {
    pendingImagesRef.current = pendingImages
  }, [pendingImages])

  useEffect(() => {
    return () => {
      for (const image of pendingImagesRef.current) URL.revokeObjectURL(image.previewUrl)
    }
  }, [])

  useEffect(() => {
    if (!pendingReply || !activeRoomId) return
    if (pendingReply.roomId !== activeRoomId) {
      setPendingReply(null)
    }
  }, [activeRoomId, pendingReply, setPendingReply])

  if (!activeRoomId) return null

  const room = useRoomStore.getState().rooms.get(activeRoomId)

  return (
    <div className="px-4 pb-4 relative">
      {pendingReply?.roomId === activeRoomId && (
        <div className="mb-2 rounded-md border-l-2 border-accent-pink/70 bg-gradient-to-r from-accent-pink/12 to-transparent px-2 py-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs text-text-secondary">
                <svg className="h-3.5 w-3.5 text-accent-pink/90" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v4m0 0l-3-3m3 3l3-3" />
                </svg>
                Réponse à <span className="font-medium text-accent-pink">{pendingReply.senderName}</span>
              </p>
              <p className="mt-0.5 text-sm text-text-primary truncate leading-snug">{pendingReply.preview || 'Message'}</p>
            </div>
            <button
              onClick={() => setPendingReply(null)}
              className="text-xs text-text-muted hover:text-text-primary transition-colors cursor-pointer"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {pendingImages.length > 0 && (
        <div className="mb-2 rounded-lg border border-border bg-bg-tertiary/70 p-2">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs text-text-secondary">
              {pendingImages.length} image{pendingImages.length > 1 ? 's' : ''} prête
              {pendingImages.length > 1 ? 's' : ''} à envoyer
            </p>
            <button
              onClick={clearPendingImages}
              className="text-xs text-text-muted hover:text-text-primary transition-colors cursor-pointer"
            >
              Tout retirer
            </button>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {pendingImages.map((image) => (
              <div key={image.id} className="relative shrink-0">
                <img
                  src={image.previewUrl}
                  alt={image.file.name || 'Image collée'}
                  className="h-20 w-20 rounded-md object-cover border border-border"
                />
                <button
                  onClick={() => removePendingImage(image.id)}
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-bg-secondary border border-border text-text-muted hover:text-text-primary flex items-center justify-center cursor-pointer"
                  aria-label="Retirer l'image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(mentionQuery !== null && mentionSuggestions.length > 0) ||
      (roomTagQuery !== null && roomSuggestions.length > 0) ||
      (emojiQuery !== null && emojiSuggestions.length > 0) ? (
        <div className="absolute bottom-full left-4 right-4 mb-1.5 rounded-lg border border-border bg-bg-secondary shadow-xl overflow-hidden z-20">
          <div className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wide border-b border-border/60">
            {mentionQuery !== null ? 'Membres' : roomTagQuery !== null ? 'Salons' : 'Emojis'}
          </div>
          {mentionQuery !== null
            ? mentionSuggestions.map((member, i) => {
                const localpart = member.userId.split(':')[0].slice(1)
                return (
                  <button
                    key={member.userId}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectMentionSuggestion(member)
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer ${i === suggestionIndex ? 'bg-bg-active text-text-primary' : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}`}
                  >
                    <Avatar src={member.avatarUrl} name={member.displayName} size={24} />
                    <span className="text-sm font-medium truncate">{member.displayName}</span>
                    <span className="text-xs text-text-muted truncate ml-auto">@{localpart}</span>
                  </button>
                )
              })
            : roomTagQuery !== null
              ? roomSuggestions.map((roomSuggestion, i) => {
                const roomTag = roomNameToTag(roomSuggestion.name)
                return (
                  <button
                    key={roomSuggestion.roomId}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectRoomSuggestion(roomSuggestion)
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer ${i === suggestionIndex ? 'bg-bg-active text-text-primary' : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}`}
                  >
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-bg-tertiary text-sm text-text-muted">#</span>
                    <span className="text-sm font-medium truncate">{roomSuggestion.name}</span>
                    <span className="text-xs text-text-muted truncate ml-auto">{roomTag}</span>
                  </button>
                )
                })
              : emojiSuggestions.map((entry, i) => (
                  <button
                    key={entry.shortcode}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectEmojiSuggestion(entry)
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer ${i === suggestionIndex ? 'bg-bg-active text-text-primary' : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}`}
                  >
                    <span className="text-lg leading-none">{entry.emoji}</span>
                    <span className="text-sm font-medium truncate">:{entry.shortcode}:</span>
                  </button>
                ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2 min-h-[44px] bg-bg-tertiary rounded-lg border border-border focus-within:border-accent-pink transition-colors">
        {!isRecording && (
          <>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-3 text-text-muted hover:text-text-primary transition-colors cursor-pointer"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileUpload}
            />
          </>
        )}
        {isRecording ? (
          <div className="flex flex-1 items-center gap-3 px-3">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
            <span className="text-sm text-text-primary tabular-nums">
              {`${Math.floor(recordingDuration / 60)}:${String(recordingDuration % 60).padStart(2, '0')}`}
            </span>
            <span className="flex-1 text-sm text-text-muted">Enregistrement en cours...</span>
            <button
              onClick={cancelRecording}
              className="p-2 text-text-muted hover:text-text-primary transition-colors cursor-pointer"
              title="Annuler"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <button
              onClick={stopRecording}
              className="p-2 text-accent-pink hover:text-accent-pink-hover transition-colors cursor-pointer"
              title="Envoyer le message vocal"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            <div className="relative flex-1 min-w-0 pt-[15px] pb-[9px]">
              {/* Highlight backdrop — renders behind the textarea */}
              <div
                ref={backdropRef}
                aria-hidden="true"
                className="absolute inset-0 pt-[15px] pb-[9px] px-0 text-sm text-text-primary overflow-hidden pointer-events-none whitespace-pre-wrap break-words"
                dangerouslySetInnerHTML={{ __html: highlightInputText(text, validLocalparts, validRoomTags) }}
              />
              <textarea
                ref={textareaRef}
                value={text}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onScroll={syncScroll}
                onSelect={(e) =>
                  detectToken(text, (e.target as HTMLTextAreaElement).selectionStart)
                }
                placeholder={`Envoyer un message dans #${room?.name || '...'}`}
                rows={1}
                className="relative z-10 w-full bg-transparent !border-0 resize-none py-0 px-0 text-sm outline-none max-h-40 placeholder:text-text-muted"
                style={{ minHeight: '24px', color: 'transparent', caretColor: 'var(--color-text-primary)' }}
              />
            </div>
            {/* Emoji picker button */}
            <div className="relative flex-shrink-0">
              <button
                ref={emojiBtnRef}
                type="button"
                onClick={() => setShowEmojiPicker((v) => !v)}
                className={`p-2.5 transition-colors cursor-pointer ${showEmojiPicker ? 'text-accent-pink' : 'text-text-muted hover:text-text-secondary'}`}
                title="Insérer un émoji"
                aria-label="Insérer un émoji"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              {emojiPickerMounted && (
                <div
                  ref={emojiPickerRef}
                  className="absolute bottom-full right-0 mb-2 z-40 transition-[opacity,transform] duration-[130ms] ease-out"
                  style={{
                    opacity: showEmojiPicker ? 1 : 0,
                    transform: showEmojiPicker ? 'translateY(0) scale(1)' : 'translateY(6px) scale(0.97)',
                    pointerEvents: showEmojiPicker ? 'auto' : 'none',
                    visibility: showEmojiPicker ? 'visible' : 'hidden',
                  }}
                >
                  <EmojiPicker
                    onSelect={(emoji) => {
                      addRecentEmoji(emoji)
                      const textarea = textareaRef.current
                      if (textarea) {
                        const start = textarea.selectionStart ?? text.length
                        const end = textarea.selectionEnd ?? text.length
                        const newText = text.slice(0, start) + emoji + text.slice(end)
                        setText(newText)
                        nextCursorRef.current = start + emoji.length
                        setTimeout(() => textarea.focus(), 0)
                      } else {
                        setText((prev) => prev + emoji)
                      }
                      setShowEmojiPicker(false)
                    }}
                  />
                </div>
              )}
            </div>
            {/* Mic button */}
            <button
              onClick={startRecording}
              className="p-2.5 text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
              title="Enregistrer un message vocal"
              aria-label="Enregistrer un message vocal"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
            </button>
            <button
              onClick={handleSend}
              disabled={isSending || (!text.trim() && pendingImages.length === 0)}
              className="p-3 text-accent-pink hover:text-accent-pink-hover disabled:text-text-muted transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  )
}
