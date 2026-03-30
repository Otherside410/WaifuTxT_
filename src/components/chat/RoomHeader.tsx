import { useMemo } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { useMessageStore } from '../../stores/messageStore'
import { useUiStore } from '../../stores/uiStore'
import { Avatar } from '../common/Avatar'

export function RoomHeader() {
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const rooms = useRoomStore((s) => s.rooms)
  const toggleMemberPanel = useUiStore((s) => s.toggleMemberPanel)
  const showMemberPanel = useUiStore((s) => s.showMemberPanel)
  const togglePinnedPanel = useUiStore((s) => s.togglePinnedPanel)
  const showPinnedPanel = useUiStore((s) => s.showPinnedPanel)
  const pinnedEventIds = useMessageStore((s) => s.pinnedEventIds)
  const pinnedVersion = useMessageStore((s) => s.pinnedVersion)

  const pinnedCount = useMemo(() => {
    if (!activeRoomId) return 0
    return (pinnedEventIds.get(activeRoomId) || []).length
  }, [activeRoomId, pinnedEventIds, pinnedVersion])

  if (!activeRoomId) return null

  const room = rooms.get(activeRoomId)
  if (!room) return null

  return (
    <div className="h-12 px-4 flex items-center gap-3 border-b border-border bg-bg-primary/50 shrink-0">
      <Avatar src={room.avatarUrl} name={room.name} size={22} shape="rounded" />
      <h2 className="font-semibold text-text-primary text-sm">{room.name}</h2>
      {room.topic && (
        <>
          <div className="w-px h-5 bg-border" />
          <p className="text-xs text-text-muted truncate flex-1">{room.topic}</p>
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={togglePinnedPanel}
          className={`relative p-1.5 rounded transition-colors cursor-pointer ${
            showPinnedPanel ? 'text-text-primary bg-bg-hover' : 'text-text-muted hover:text-text-primary'
          }`}
          title="Messages épinglés"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
          </svg>
          {pinnedCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-accent-pink text-white text-[10px] font-bold px-1">
              {pinnedCount}
            </span>
          )}
        </button>
        <button
          onClick={toggleMemberPanel}
          className={`p-1.5 rounded transition-colors cursor-pointer ${
            showMemberPanel ? 'text-text-primary bg-bg-hover' : 'text-text-muted hover:text-text-primary'
          }`}
          title="Membres"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
