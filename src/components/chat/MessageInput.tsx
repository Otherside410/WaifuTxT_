import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react'

function highlightInputText(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  return (
    escaped.replace(
      /@[\w._\-=+/]+/g,
      '<mark style="display:inline-flex;align-items:center;border-radius:0.25rem;padding:1px 4px;background:var(--color-mention-bg);color:var(--color-mention)">$&</mark>',
    ) + '\u200b'
  )
}
import { useRoomStore } from '../../stores/roomStore'
import { useUiStore } from '../../stores/uiStore'
import { sendMessage, sendFile, sendImage, sendTyping } from '../../lib/matrix'

interface PendingImage {
  id: string
  file: File
  previewUrl: string
}

export function MessageInput() {
  const [text, setText] = useState('')
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [isSending, setIsSending] = useState(false)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const pendingMention = useUiStore((s) => s.pendingMention)
  const setPendingMention = useUiStore((s) => s.setPendingMention)
  const pendingReply = useUiStore((s) => s.pendingReply)
  const setPendingReply = useUiStore((s) => s.setPendingReply)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingImagesRef = useRef<PendingImage[]>([])

  // Inject mention from UserProfileCard / MemberPanel
  useEffect(() => {
    if (!pendingMention) return
    setText((prev) => (prev ? `${prev} ${pendingMention} ` : `${pendingMention} `))
    setPendingMention(null)
    textareaRef.current?.focus()
  }, [pendingMention, setPendingMention])

  const handleSend = useCallback(async () => {
    if (isSending || !activeRoomId) return
    const msg = text.trim()
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
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
    <div className="px-4 pb-4">
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
              {pendingImages.length} image{pendingImages.length > 1 ? 's' : ''} prête{pendingImages.length > 1 ? 's' : ''} à envoyer
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

      <div className="flex items-end gap-2 bg-bg-tertiary rounded-lg border border-border focus-within:border-accent-pink transition-colors">
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
        <div className="relative flex-1 min-w-0">
          {/* Highlight backdrop — renders behind the textarea */}
          <div
            ref={backdropRef}
            aria-hidden="true"
            className="absolute inset-0 py-3 px-0 text-sm text-text-primary overflow-hidden pointer-events-none whitespace-pre-wrap break-words"
            dangerouslySetInnerHTML={{ __html: highlightInputText(text) }}
          />
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={syncScroll}
            placeholder={`Envoyer un message dans #${room?.name || '...'}`}
            rows={1}
            className="relative z-10 w-full bg-transparent !border-0 resize-none py-3 px-0 text-sm outline-none max-h-40 placeholder:text-text-muted"
            style={{ minHeight: '24px', color: 'transparent', caretColor: 'var(--color-text-primary)' }}
          />
        </div>
        <button
          onClick={handleSend}
          disabled={isSending || (!text.trim() && pendingImages.length === 0)}
          className="p-3 text-accent-pink hover:text-accent-pink-hover disabled:text-text-muted transition-colors cursor-pointer disabled:cursor-not-allowed"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
