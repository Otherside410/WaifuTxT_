import { useCallback } from 'react'
import { RoomHeader } from './RoomHeader'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { TypingIndicator } from './TypingIndicator'
import { KeyBackupBanner } from './KeyBackupBanner'
import { VoiceRoomView } from '../voice/VoiceRoomView'
import { useUiStore } from '../../stores/uiStore'
import { useRoomStore } from '../../stores/roomStore'

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'IMG', 'VIDEO'])

export function ChatArea() {
  const bumpChatInputFocus = useUiStore((s) => s.bumpChatInputFocus)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const rooms = useRoomStore((s) => s.rooms)

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (INTERACTIVE_TAGS.has(target.tagName)) return
    if (target.closest('a, button, input, textarea, select, [role="button"], [role="menuitem"]')) return
    if (window.getSelection()?.toString()) return
    bumpChatInputFocus()
  }, [bumpChatInputFocus])

  const room = activeRoomId ? rooms.get(activeRoomId) : null

  if (room?.isVoice) {
    return (
      <div className="flex-1 flex flex-col min-w-0 bg-bg-primary">
        <VoiceRoomView />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bg-primary" onClick={handleClick}>
      <RoomHeader />
      <KeyBackupBanner />
      <MessageList />
      <TypingIndicator />
      <MessageInput />
    </div>
  )
}
