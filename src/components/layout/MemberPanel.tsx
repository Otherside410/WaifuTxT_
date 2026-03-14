import { useRoomStore } from '../../stores/roomStore'
import { Avatar } from '../common/Avatar'

export function MemberPanel() {
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const members = useRoomStore((s) => (activeRoomId ? s.members.get(activeRoomId) : undefined))
  const presenceMap = useRoomStore((s) => s.presenceMap)

  if (!members) return null

  const admins = members.filter((m) => m.powerLevel >= 100)
  const mods = members.filter((m) => m.powerLevel >= 50 && m.powerLevel < 100)
  const regular = members.filter((m) => m.powerLevel < 50)

  const renderGroup = (title: string, list: typeof members) => {
    if (list.length === 0) return null
    return (
      <div className="mb-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted px-2 mb-1">
          {title} — {list.length}
        </h3>
        {list.map((member) => (
          <div
            key={member.userId}
            className="flex items-center gap-2.5 px-2 py-1 rounded-md hover:bg-bg-hover/50 transition-colors cursor-pointer"
          >
            <Avatar
              src={member.avatarUrl}
              name={member.displayName}
              size={32}
              status={presenceMap[member.userId] ?? member.presence}
            />
            <div className="min-w-0">
              <div className="text-sm truncate text-text-primary">{member.displayName}</div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="w-60 bg-bg-secondary border-l border-border flex flex-col">
      <div className="h-12 px-4 flex items-center border-b border-border shrink-0">
        <h2 className="text-sm font-semibold text-text-primary">
          Membres — {members.length}
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {renderGroup('Admins', admins)}
        {renderGroup('Modérateurs', mods)}
        {renderGroup('Membres', regular)}
      </div>
    </div>
  )
}
