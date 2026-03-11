import { RoomHeader } from './RoomHeader'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { TypingIndicator } from './TypingIndicator'
import { KeyBackupBanner } from './KeyBackupBanner'

export function ChatArea() {
  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bg-primary">
      <RoomHeader />
      <KeyBackupBanner />
      <MessageList />
      <TypingIndicator />
      <MessageInput />
    </div>
  )
}
