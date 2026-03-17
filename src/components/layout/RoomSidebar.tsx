import { useState, useMemo, useEffect, useRef } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { Avatar } from '../common/Avatar'
import { useAuthStore } from '../../stores/authStore'
import { useUiStore } from '../../stores/uiStore'
import { getOwnAvatarUrl, setOwnPresence } from '../../lib/matrix'
import { getWaifuById } from '../../lib/waifu'
import type { PresenceValue } from '../../stores/uiStore'

const PRESENCE_OPTIONS: { value: PresenceValue; label: string; color: string }[] = [
  { value: 'online',      label: 'En ligne',   color: 'bg-success' },
  { value: 'unavailable', label: 'Absent',      color: 'bg-warning' },
  { value: 'offline',     label: 'Hors-ligne',  color: 'bg-text-muted' },
]

function isVoiceRoom(room: { roomType?: string; name: string; topic: string }): boolean {
  const maybeVoice = room as { isVoice?: boolean; roomType?: string; name: string; topic: string }
  if (maybeVoice.isVoice) return true
  const type = (room.roomType || '').toLowerCase()
  if (type.includes('voice') || type.includes('call')) return true
  const label = `${room.name} ${room.topic}`.toLowerCase()
  return /\b(vocal|voice|audio)\b/.test(label)
}

export function RoomSidebar() {
  const [search, setSearch] = useState('')
  const [isMuted, setIsMuted] = useState(false)
  const [isDeafened, setIsDeafened] = useState(false)
  const [showPresenceMenu, setShowPresenceMenu] = useState(false)
  const [ownPresence, setOwnPresenceStore] = useState<PresenceValue>(() => {
    const stored = localStorage.getItem('waifutxt_presence')
    return stored === 'online' || stored === 'unavailable' || stored === 'offline' ? stored : 'online'
  })
  const presenceMenuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const rooms = useRoomStore((s) => s.rooms)
  const activeSpaceId = useRoomStore((s) => s.activeSpaceId)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const updatePresence = useRoomStore((s) => s.updatePresence)
  const session = useAuthStore((s) => s.session)
  const setSettingsModal = useUiStore((s) => s.setSettingsModal)
  const showRoomMessagePreview = useUiStore((s) => s.showRoomMessagePreview)
  const showUnreadDot = useUiStore((s) => s.showUnreadDot)
  const showMentionBadge = useUiStore((s) => s.showMentionBadge)
  const waifuOptIn = useUiStore((s) => s.waifuOptIn)
  const selectedWaifuId = useUiStore((s) => s.selectedWaifuId)
  const roomSearchFocusBump = useUiStore((s) => s.roomSearchFocusBump)
  const myUserId = session?.userId ?? null

  useEffect(() => {
    if (roomSearchFocusBump > 0) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
  }, [roomSearchFocusBump])

  const [ownAvatarUrl, setOwnAvatarUrl] = useState<string | null>(null)
  useEffect(() => {
    const url = getOwnAvatarUrl()
    if (url) setOwnAvatarUrl(url)
  }, [rooms])

  const displayedOwnAvatarUrl = useMemo(() => {
    if (waifuOptIn) return getWaifuById(selectedWaifuId).imageUrl
    return ownAvatarUrl
  }, [ownAvatarUrl, selectedWaifuId, waifuOptIn])

  // Close presence menu on outside click
  useEffect(() => {
    if (!showPresenceMenu) return
    const handler = (e: MouseEvent) => {
      if (!presenceMenuRef.current?.contains(e.target as Node)) setShowPresenceMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showPresenceMenu])

  const handleSetPresence = async (presence: PresenceValue) => {
    setOwnPresenceStore(presence)
    localStorage.setItem('waifutxt_presence', presence)
    if (myUserId) updatePresence(myUserId, presence)
    setShowPresenceMenu(false)
    await setOwnPresence(presence)
  }

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
          ref={searchInputRef}
          type="text"
          placeholder="Rechercher..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); searchInputRef.current?.blur() } }}
          className="w-full text-xs !py-1.5 !px-2"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {filtered.map((room) => (
          <button
            key={room.roomId}
            onClick={() => setActiveRoom(room.roomId)}
            className={`w-full flex items-center px-2 py-1.5 rounded-md transition-colors text-left cursor-pointer group ${
              activeRoomId === room.roomId
                ? 'bg-bg-hover text-text-primary'
                : room.unreadCount > 0
                  ? 'text-text-primary hover:bg-bg-hover/50'
                  : 'text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary'
            }`}
          >
            <span className="mr-1.5 text-text-muted/90 shrink-0" aria-hidden>
              {isVoiceRoom(room) ? (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 14a3 3 0 003-3V7a3 3 0 10-6 0v4a3 3 0 003 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 11-14 0m7 7v3" />
                </svg>
              ) : (
                <span className="text-base leading-none">#</span>
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-1.5">
                <span className={`text-sm truncate ${room.unreadCount > 0 && activeRoomId !== room.roomId ? 'font-semibold' : 'font-medium'}`}>
                  {room.name}
                </span>
                {showMentionBadge && activeRoomId !== room.roomId && room.mentionCount > 0 ? (
                  <span className="shrink-0 flex items-center justify-center rounded-full min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-accent-pink">
                    {room.mentionCount > 99 ? '99+' : room.mentionCount}
                  </span>
                ) : showUnreadDot && activeRoomId !== room.roomId && room.unreadCount > 0 ? (
                  <span className="shrink-0 w-2 h-2 rounded-full bg-accent-pink" />
                ) : null}
              </div>
              {showRoomMessagePreview && room.lastMessage && (
                <p className="text-xs text-text-muted truncate">{room.lastMessage}</p>
              )}
            </div>
          </button>
        ))}

        {filtered.length === 0 && (
          <div className="text-center text-text-muted text-xs py-8">Aucun salon trouvé</div>
        )}
      </div>

      <div className="relative -left-[72px] w-[calc(100%+72px)] h-14 pl-[80px] pr-2 flex items-center gap-2 bg-bg-tertiary/95 border-t border-border">
        {/* Presence menu */}
        {showPresenceMenu && (
          <div
            ref={presenceMenuRef}
            className="absolute bottom-16 left-[80px] w-44 bg-bg-tertiary border border-border rounded-lg shadow-xl p-1 z-50"
          >
            {PRESENCE_OPTIONS.map(({ value, label, color }) => (
              <button
                key={value}
                onClick={() => handleSetPresence(value)}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
              >
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${color}`} />
                <span className="flex-1 text-left">{label}</span>
                {ownPresence === value && (
                  <svg className="w-3.5 h-3.5 text-accent-pink shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}

        <button
          onClick={() => setShowPresenceMenu((v) => !v)}
          className="flex items-center gap-2 min-w-0 flex-1 px-1.5 py-1 rounded-md hover:bg-bg-hover/70 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-pink"
          title="Changer de statut"
          aria-label="Changer de statut"
        >
          <Avatar src={displayedOwnAvatarUrl} name={session?.userId || '?'} size={32} status={ownPresence} />
          <div className="min-w-0 text-left">
            <div className="text-sm font-semibold truncate text-text-primary leading-tight">
              {session?.userId?.split(':')[0]?.replace('@', '') || ''}
            </div>
            <div className="text-[11px] text-text-muted truncate leading-tight">
              {PRESENCE_OPTIONS.find((o) => o.value === ownPresence)?.label ?? 'Hors-ligne'}
            </div>
          </div>
        </button>

        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setIsMuted((v) => !v)}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              isMuted
                ? 'text-danger bg-danger/10 hover:bg-danger/20'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover/80'
            }`}
            title={isMuted ? 'Activer le micro' : 'Couper le micro'}
            aria-label={isMuted ? 'Activer le micro' : 'Couper le micro'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              {isMuted ? (
                <>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9v3a3 3 0 006 0V9m-3 8v3m-4-3a7 7 0 008 0M3 3l18 18" />
                </>
              ) : (
                <>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 14a3 3 0 003-3V7a3 3 0 10-6 0v4a3 3 0 003 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 11-14 0m7 7v3" />
                </>
              )}
            </svg>
          </button>

          <button
            onClick={() => setIsDeafened((v) => !v)}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              isDeafened
                ? 'text-danger bg-danger/10 hover:bg-danger/20'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover/80'
            }`}
            title={isDeafened ? 'Activer l’audio' : 'Désactiver l’audio'}
            aria-label={isDeafened ? 'Activer l’audio' : 'Désactiver l’audio'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              {isDeafened ? (
                <>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 8.5L7.5 11H5v2h2.5l3.5 3.5V8.5zM16 8a5 5 0 012 4 5 5 0 01-.6 2.4" />
                </>
              ) : (
                <>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5L6 9H3v6h3l5 4V5z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" />
                </>
              )}
            </svg>
          </button>

          <button
            onClick={() => setSettingsModal(true)}
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover/80 transition-colors cursor-pointer"
            title="Paramètres utilisateur"
            aria-label="Paramètres utilisateur"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317a1.724 1.724 0 013.35 0 1.724 1.724 0 002.573 1.066 1.724 1.724 0 012.353.994 1.724 1.724 0 001.724 2.99 1.724 1.724 0 010 3.266 1.724 1.724 0 00-1.724 2.99 1.724 1.724 0 01-2.353.994 1.724 1.724 0 00-2.573 1.066 1.724 1.724 0 01-3.35 0 1.724 1.724 0 00-2.573-1.066 1.724 1.724 0 01-2.353-.994 1.724 1.724 0 00-1.724-2.99 1.724 1.724 0 010-3.266 1.724 1.724 0 001.724-2.99 1.724 1.724 0 012.353-.994 1.724 1.724 0 002.573-1.066z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
