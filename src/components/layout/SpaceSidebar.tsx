import { useMemo } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { Avatar } from '../common/Avatar'
import { Tooltip } from '../common/Tooltip'

export function SpaceSidebar() {
  const rooms = useRoomStore((s) => s.rooms)
  const activeSpaceId = useRoomStore((s) => s.activeSpaceId)
  const setActiveSpace = useRoomStore((s) => s.setActiveSpace)

  const spaces = useMemo(
    () => Array.from(rooms.values()).filter((r) => r.isSpace),
    [rooms],
  )

  return (
    <div className="w-[72px] bg-bg-primary flex flex-col items-center py-3 gap-2 overflow-y-auto border-r border-border">
      <Tooltip content="Messages directs">
        <button
          onClick={() => setActiveSpace(null)}
          className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-200 cursor-pointer ${
            activeSpaceId === null
              ? 'bg-accent-pink rounded-xl text-white'
              : 'bg-bg-tertiary text-text-secondary hover:bg-accent-pink hover:text-white hover:rounded-xl'
          }`}
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
        </button>
      </Tooltip>

      <div className="w-8 h-0.5 bg-border rounded-full my-1" />

      {spaces.map((space) => (
        <Tooltip key={space.roomId} content={space.name}>
          <button
            onClick={() => setActiveSpace(space.roomId)}
            className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-200 cursor-pointer overflow-hidden ${
              activeSpaceId === space.roomId
                ? 'rounded-xl ring-2 ring-accent-pink'
                : 'hover:rounded-xl'
            }`}
          >
            <Avatar src={space.avatarUrl} name={space.name} size={48} />
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
