import { useState, useRef, useCallback, type KeyboardEvent, type ChangeEvent } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { sendMessage, sendFile, sendImage, sendTyping } from '../../lib/matrix'

export function MessageInput() {
  const [text, setText] = useState('')
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>()

  const handleSend = useCallback(async () => {
    if (!text.trim() || !activeRoomId) return
    const msg = text.trim()
    setText('')
    sendTyping(activeRoomId, false)
    await sendMessage(activeRoomId, msg)
  }, [text, activeRoomId])

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
    clearTimeout(typingTimeoutRef.current)
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

  if (!activeRoomId) return null

  const room = useRoomStore.getState().rooms.get(activeRoomId)

  return (
    <div className="px-4 pb-4">
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
        <textarea
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={`Envoyer un message dans #${room?.name || '...'}`}
          rows={1}
          className="flex-1 bg-transparent !border-0 resize-none py-3 px-0 text-sm text-text-primary outline-none max-h-40"
          style={{ minHeight: '24px' }}
        />
        <button
          onClick={handleSend}
          disabled={!text.trim()}
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
