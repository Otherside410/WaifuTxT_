import { useEffect, useRef, useState } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { useUiStore } from '../../stores/uiStore'
import { Avatar } from '../common/Avatar'
import type { RoomMember } from '../../types/matrix'
import type { PresenceValue } from '../../stores/uiStore'

function presenceOrder(p: PresenceValue | undefined): number {
  if (p === 'online') return 0
  if (p === 'unavailable') return 1
  return 2
}

export function MemberPanel() {
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const members = useRoomStore((s) => (activeRoomId ? s.members.get(activeRoomId) : undefined))
  const presenceMap = useRoomStore((s) => s.presenceMap)

  if (!members) return null

  const admins  = members.filter((m) => m.powerLevel >= 100)
  const mods    = members.filter((m) => m.powerLevel >= 50 && m.powerLevel < 100)
  const regular = members.filter((m) => m.powerLevel < 50)

  const getStatus = (m: RoomMember): PresenceValue =>
    (presenceMap[m.userId] as PresenceValue | undefined) ?? m.presence

  const sortByPresence = (list: RoomMember[]) =>
    [...list].sort((a, b) => presenceOrder(getStatus(a)) - presenceOrder(getStatus(b)))

  const renderGroup = (title: string, list: RoomMember[]) => {
    if (list.length === 0) return null
    const sorted = sortByPresence(list)
    const onlineCount = list.filter((m) => getStatus(m) !== 'offline').length

    return (
      <div className="mb-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted px-2 mb-1">
          {title}
          {onlineCount > 0 && onlineCount < list.length
            ? ` — ${onlineCount} en ligne`
            : ` — ${list.length}`}
        </h3>
        {sorted.map((member) => {
          const status = getStatus(member)
          const isOffline = status === 'offline'
          return (
            <div
              key={member.userId}
              className={`flex items-center gap-2.5 px-2 py-1 rounded-md hover:bg-bg-hover/50 transition-colors cursor-pointer ${isOffline ? 'opacity-40' : ''}`}
            >
              <Avatar
                src={member.avatarUrl}
                name={member.displayName}
                size={32}
                status={status}
              />
              <div className="min-w-0">
                <div className="text-sm truncate text-text-primary">{member.displayName}</div>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="w-60 bg-bg-secondary border-l border-border flex flex-col">
      <div className="h-12 px-4 flex items-center border-b border-border shrink-0">
        <h2 className="text-sm font-semibold text-text-primary">Membres — {members.length}</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {renderGroup('Admins', admins)}
        {renderGroup('Modérateurs', mods)}
        {renderGroup('Membres', regular)}
      </div>
    </div>
  )
}
