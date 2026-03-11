import { useState, useMemo } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { Avatar } from '../common/Avatar'
import { useAuthStore } from '../../stores/authStore'
import { logout } from '../../lib/matrix'

export function RoomSidebar() {
  const [search, setSearch] = useState('')
  const rooms = useRoomStore((s) => s.rooms)
  const activeSpaceId = useRoomStore((s) => s.activeSpaceId)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const session = useAuthStore((s) => s.session)

  const displayRooms = useMemo(() => {
    const allRooms = Array.from(rooms.values())

    if (activeSpaceId === null) {
      const dms = allRooms.filter((r) => r.isDirect)
      const nonSpaceNonDm = allRooms.filter((r) => !r.isSpace && !r.isDirect)
      const combined = [...dms, ...nonSpaceNonDm]
      return combined.sort((a, b) => b.lastMessageTs - a.lastMessageTs)
    }

    const space = rooms.get(activeSpaceId)
    if (!space) return []
    return space.children
      .map((id) => rooms.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r && !r.isSpace)
      .sort((a, b) => b.lastMessageTs - a.lastMessageTs)
  }, [rooms, activeSpaceId])

  const filtered = search
    ? displayRooms.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
    : displayRooms

  const spaceName = activeSpaceId ? rooms.get(activeSpaceId)?.name || 'Space' : 'Messages'

  return (
    <div className="w-60 bg-bg-secondary flex flex-col border-r border-border">
      <div className="h-12 px-3 flex items-center border-b border-border shrink-0">
        <h2 className="font-semibold text-text-primary truncate text-sm">{spaceName}</h2>
      </div>

      <div className="px-2 py-2">
        <input
          type="text"
          placeholder="Rechercher..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full text-xs !py-1.5 !px-2"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {filtered.map((room) => (
          <button
            key={room.roomId}
            onClick={() => setActiveRoom(room.roomId)}
            className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors text-left cursor-pointer group ${
              activeRoomId === room.roomId
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary'
            }`}
          >
            <Avatar src={room.avatarUrl} name={room.name} size={32} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate">{room.name}</span>
                {room.unreadCount > 0 && (
                  <span className="bg-accent-pink text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                    {room.unreadCount > 99 ? '99+' : room.unreadCount}
                  </span>
                )}
              </div>
              {room.lastMessage && (
                <p className="text-xs text-text-muted truncate">{room.lastMessage}</p>
              )}
            </div>
          </button>
        ))}

        {filtered.length === 0 && (
          <div className="text-center text-text-muted text-xs py-8">Aucun salon trouvé</div>
        )}
      </div>

      <div className="h-13 px-2 flex items-center gap-2 bg-bg-primary/50 border-t border-border">
        <Avatar src={null} name={session?.userId || '?'} size={32} status="online" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate text-text-primary">
            {session?.userId?.split(':')[0]?.replace('@', '') || ''}
          </div>
          <div className="text-[10px] text-text-muted truncate">En ligne</div>
        </div>
        <button
          onClick={() => logout()}
          className="p-1.5 text-text-muted hover:text-danger transition-colors rounded cursor-pointer"
          title="Déconnexion"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </button>
      </div>
    </div>
  )
}
