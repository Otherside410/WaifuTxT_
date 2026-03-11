import { useMessageStore } from '../../stores/messageStore'
import { useRoomStore } from '../../stores/roomStore'

const EMPTY_USERS: string[] = []

export function TypingIndicator() {
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const typingMap = useMessageStore((s) => s.typing)

  const typingUsers = activeRoomId ? typingMap.get(activeRoomId) ?? EMPTY_USERS : EMPTY_USERS

  if (typingUsers.length === 0) return null

  let text: string
  if (typingUsers.length === 1) {
    text = `${typingUsers[0]} est en train d'écrire...`
  } else if (typingUsers.length === 2) {
    text = `${typingUsers[0]} et ${typingUsers[1]} sont en train d'écrire...`
  } else {
    text = `${typingUsers[0]} et ${typingUsers.length - 1} autres sont en train d'écrire...`
  }

  return (
    <div className="px-4 py-1 text-xs text-text-muted flex items-center gap-2">
      <span className="flex gap-0.5">
        <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
      </span>
      <span>{text}</span>
    </div>
  )
}
