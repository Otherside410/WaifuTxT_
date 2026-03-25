import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { Avatar } from '../common/Avatar'
import { useAuthStore } from '../../stores/authStore'
import { useUiStore } from '../../stores/uiStore'
import {
  getOwnAvatarUrl,
  getRoomMemberProfileBasics,
  getUserProfileBasics,
  joinRoom,
  declineInvite,
  joinVoiceRoom,
  leaveVoiceRoom,
  loadRoomMembers,
  setOwnPresence,
} from '../../lib/matrix'
import { getWaifuById } from '../../lib/waifu'
import type { RoomSummary } from '../../types/matrix'
import type { PresenceValue } from '../../stores/uiStore'

const PRESENCE_OPTIONS: { value: PresenceValue; label: string; color: string }[] = [
  { value: 'online',      label: 'En ligne',   color: 'bg-success' },
  { value: 'unavailable', label: 'Absent',      color: 'bg-warning' },
  { value: 'offline',     label: 'Hors-ligne',  color: 'bg-text-muted' },
]

type CategoryGroup = {
  id: string
  name: string
  rooms: RoomSummary[]
  totalUnread: number
  totalMentions: number
}

function isVoiceRoom(room: { roomType?: string; name: string; topic: string }): boolean {
  const maybeVoice = room as { isVoice?: boolean; roomType?: string; name: string; topic: string }
  if (maybeVoice.isVoice) return true
  const type = (room.roomType || '').toLowerCase()
  if (type.includes('voice') || type.includes('call')) return true
  const label = `${room.name} ${room.topic}`.toLowerCase()
  return /\b(vocal|voice|audio)\b/.test(label)
}

function isVoiceDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem('waifutxt_debug_voice') === '1'
  } catch {
    return false
  }
}

function loadCollapsedCategories(): Set<string> {
  try {
    const stored = localStorage.getItem('waifutxt_collapsed_categories')
    return new Set(stored ? (JSON.parse(stored) as string[]) : [])
  } catch {
    return new Set()
  }
}

export function RoomSidebar() {
  const [search, setSearch] = useState('')
  const [isMuted, setIsMuted] = useState(false)
  const [isDeafened, setIsDeafened] = useState(false)
  const [voiceActionRoomId, setVoiceActionRoomId] = useState<string | null>(null)
  const [showPresenceMenu, setShowPresenceMenu] = useState(false)
  const [ownPresence, setOwnPresenceStore] = useState<PresenceValue>(() => {
    const stored = localStorage.getItem('waifutxt_presence')
    return stored === 'online' || stored === 'unavailable' || stored === 'offline' ? stored : 'online'
  })
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(loadCollapsedCategories)
  const presenceMenuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const rooms = useRoomStore((s) => s.rooms)
  const activeSpaceId = useRoomStore((s) => s.activeSpaceId)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const membersByRoom = useRoomStore((s) => s.members)
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
  const [voiceProfileMap, setVoiceProfileMap] = useState<Record<string, { displayName: string | null; avatarUrl: string | null }>>({})
  const loadedVoiceMembersRef = useRef(new Set<string>())
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

  // --- Invitations ---
  const [pendingInvites, setPendingInvites] = useState<Set<string>>(new Set())

  const handleAcceptInvite = async (roomId: string) => {
    setPendingInvites((s) => new Set(s).add(roomId))
    try {
      await joinRoom(roomId)
      setActiveRoom(roomId)
    } finally {
      setPendingInvites((s) => { const n = new Set(s); n.delete(roomId); return n })
    }
  }

  const handleDeclineInvite = async (roomId: string) => {
    setPendingInvites((s) => new Set(s).add(roomId))
    try {
      await declineInvite(roomId)
    } finally {
      setPendingInvites((s) => { const n = new Set(s); n.delete(roomId); return n })
    }
  }

  // --- Category collapse ---
  const toggleCategory = useCallback((key: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      localStorage.setItem('waifutxt_collapsed_categories', JSON.stringify([...next]))
      return next
    })
  }, [])

  // --- Room hierarchy ---
  const { uncategorized, categories, invitedRooms } = useMemo(() => {
    const allRooms = Array.from(rooms.values())
    const invited = allRooms.filter((r) => r.membership === 'invite')
    const joinedOnly = allRooms.filter((r) => r.membership !== 'invite')

    // Flat mode: no active space
    if (activeSpaceId === null) {
      const dms = joinedOnly.filter((r) => r.isDirect)
      const nonSpaceNonDm = joinedOnly.filter((r) => !r.isSpace && !r.isDirect)
      return {
        uncategorized: [...dms, ...nonSpaceNonDm].sort((a, b) => b.lastMessageTs - a.lastMessageTs),
        categories: [] as CategoryGroup[],
        invitedRooms: invited,
      }
    }

    // Hierarchical mode: active space selected
    const space = rooms.get(activeSpaceId)
    if (!space) return { uncategorized: [], categories: [] as CategoryGroup[], invitedRooms: invited }

    const subSpaces: RoomSummary[] = []
    const directRooms: RoomSummary[] = []

    for (const childId of space.children) {
      const child = rooms.get(childId)
      if (!child || child.membership === 'invite') continue
      if (child.isSpace) subSpaces.push(child)
      else directRooms.push(child)
    }

    const cats: CategoryGroup[] = subSpaces.map((sub) => {
      const subRooms = sub.children
        .map((id) => rooms.get(id))
        .filter((r): r is RoomSummary => !!r && !r.isSpace && r.membership !== 'invite')
        .sort((a, b) => b.lastMessageTs - a.lastMessageTs)
      return {
        id: sub.roomId,
        name: sub.name,
        rooms: subRooms,
        totalUnread: subRooms.reduce((sum, r) => sum + r.unreadCount, 0),
        totalMentions: subRooms.reduce((sum, r) => sum + r.mentionCount, 0),
      }
    })

    return {
      uncategorized: directRooms.sort((a, b) => b.lastMessageTs - a.lastMessageTs),
      categories: cats,
      invitedRooms: invited,
    }
  }, [rooms, activeSpaceId])

  // All rooms visible in sidebar, used for voice profile loading
  const allDisplayedRooms = useMemo(
    () => [...uncategorized, ...categories.flatMap((c) => c.rooms)],
    [uncategorized, categories],
  )

  // Search: flat filter across all displayed rooms
  const searchResults = useMemo(() => {
    if (!search) return null
    const q = search.toLowerCase()
    return allDisplayedRooms.filter((r) => r.name.toLowerCase().includes(q))
  }, [search, allDisplayedRooms])

  // Rooms to scan for voice profile fetching
  const voiceScanRooms = searchResults ?? allDisplayedRooms

  useEffect(() => {
    const voiceUsers = new Map<string, string>()
    for (const room of voiceScanRooms) {
      if (!isVoiceRoom(room)) continue
      if ((room.voiceParticipants || []).length > 0 && !membersByRoom.get(room.roomId) && !loadedVoiceMembersRef.current.has(room.roomId)) {
        loadedVoiceMembersRef.current.add(room.roomId)
        loadRoomMembers(room.roomId).catch(() => {
          loadedVoiceMembersRef.current.delete(room.roomId)
        })
      }
      for (const participant of room.voiceParticipants || []) {
        if (!participant.userId) continue
        if (!participant.avatarUrl) {
          voiceUsers.set(participant.userId, room.roomId)
        }
      }
    }
    const toFetch = Array.from(voiceUsers.entries()).filter(([userId]) => !(userId in voiceProfileMap))
    if (toFetch.length === 0) return

    let cancelled = false
    Promise.all(
      toFetch.map(async ([userId, roomId]) => ({
        userId,
        profile: await (async () => {
          const roomProfile = await getRoomMemberProfileBasics(roomId, userId, 24)
          if (roomProfile.avatarUrl) return roomProfile
          return getUserProfileBasics(userId, 24)
        })(),
      })),
    )
      .then((items) => {
        if (cancelled) return
        setVoiceProfileMap((prev) => {
          const next = { ...prev }
          for (const item of items) next[item.userId] = item.profile
          return next
        })
      })
      .catch(() => { /* ignore */ })

    return () => { cancelled = true }
  }, [voiceScanRooms, voiceProfileMap, membersByRoom])

  useEffect(() => {
    if (!isVoiceDebugEnabled()) return
    const snapshot = voiceScanRooms
      .filter((room) => isVoiceRoom(room) && (room.voiceParticipants || []).length > 0)
      .map((room) => {
        const roomMembers = membersByRoom.get(room.roomId) || []
        return {
          roomId: room.roomId,
          roomName: room.name,
          participants: (room.voiceParticipants || []).map((p) => {
            const member = roomMembers.find((m) => m.userId === p.userId)
            const fallback = voiceProfileMap[p.userId]
            const resolvedAvatar = member?.avatarUrl || p.avatarUrl || fallback?.avatarUrl || null
            const source = member?.avatarUrl ? 'membersStore' : p.avatarUrl ? 'voiceParticipants' : fallback?.avatarUrl ? 'voiceProfileMap' : 'none'
            return {
              userId: p.userId,
              displayName: member?.displayName || fallback?.displayName || p.displayName,
              avatarSource: source,
              avatarUrl: resolvedAvatar,
            }
          }),
        }
      })
    console.debug('[VoiceDebug] RoomSidebar snapshot', snapshot)
  }, [voiceScanRooms, membersByRoom, voiceProfileMap])

  const spaceName = activeSpaceId ? rooms.get(activeSpaceId)?.name || 'Space' : 'Messages'
  const joinedVoiceRoomId = useMemo(() => {
    for (const room of rooms.values()) {
      if (!isVoiceRoom(room)) continue
      if (room.voiceJoinedByMe) return room.roomId
    }
    return null
  }, [rooms])

  const handleVoiceJoinLeave = async (roomId: string, joined: boolean) => {
    if (voiceActionRoomId) return
    setVoiceActionRoomId(roomId)
    try {
      if (joined) {
        await leaveVoiceRoom(roomId)
      } else {
        await joinVoiceRoom(roomId)
        setActiveRoom(roomId)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action vocale impossible'
      console.error('[Voice] join/leave failed:', message)
    } finally {
      setVoiceActionRoomId(null)
    }
  }

  // --- Room item renderer (shared between flat/search and hierarchical modes) ---
  const renderRoomItem = (room: RoomSummary) => {
    const isVoice = isVoiceRoom(room)
    const isJoinedVoice = joinedVoiceRoomId === room.roomId
    const participants = room.voiceParticipants || []
    const roomMembers = membersByRoom.get(room.roomId) || []
    return (
      <div key={room.roomId} className="space-y-1">
        <button
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
            {isVoice ? (
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
              <div className="flex items-center gap-1">
                {isVoice && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void handleVoiceJoinLeave(room.roomId, isJoinedVoice) }}
                    disabled={voiceActionRoomId === room.roomId}
                    className={`shrink-0 inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold transition-colors cursor-pointer ${
                      isJoinedVoice
                        ? 'text-danger bg-danger/12 hover:bg-danger/20'
                        : 'text-success bg-success/12 hover:bg-success/20'
                    } ${voiceActionRoomId === room.roomId ? 'opacity-60 cursor-wait' : ''}`}
                    title={isJoinedVoice ? 'Quitter le vocal' : 'Rejoindre le vocal'}
                    aria-label={isJoinedVoice ? 'Quitter le vocal' : 'Rejoindre le vocal'}
                  >
                    {voiceActionRoomId === room.roomId ? '...' : isJoinedVoice ? 'Quitter' : 'Rejoindre'}
                  </button>
                )}
                {showMentionBadge && activeRoomId !== room.roomId && room.mentionCount > 0 ? (
                  <span className="shrink-0 flex items-center justify-center rounded-full min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-accent-pink">
                    {room.mentionCount > 99 ? '99+' : room.mentionCount}
                  </span>
                ) : showUnreadDot && activeRoomId !== room.roomId && room.unreadCount > 0 ? (
                  <span className="shrink-0 w-2 h-2 rounded-full bg-accent-pink" />
                ) : null}
              </div>
            </div>
            {showRoomMessagePreview && room.lastMessage && (
              <p className="text-xs text-text-muted truncate">{room.lastMessage}</p>
            )}
          </div>
        </button>

        {isVoice && participants.length > 0 && (
          <div className="pl-6 pr-2 pb-1 space-y-1">
            {participants.map((participant) => {
              const matchedMember = roomMembers.find((m) => m.userId === participant.userId)
              const displayName = matchedMember?.displayName || voiceProfileMap[participant.userId]?.displayName || participant.displayName
              const avatarUrl = matchedMember?.avatarUrl || participant.avatarUrl || voiceProfileMap[participant.userId]?.avatarUrl || null
              return (
                <button
                  key={`${room.roomId}:${participant.userId}`}
                  onClick={() => setActiveRoom(room.roomId)}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-text-muted hover:text-text-primary hover:bg-bg-hover/40 transition-colors cursor-pointer"
                  title={participant.userId}
                >
                  <Avatar src={avatarUrl} name={displayName} size={18} />
                  <span className="text-xs truncate">{displayName}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

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
        {/* Invitations */}
        {invitedRooms.length > 0 && (
          <div className="mb-1">
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Invitations ({invitedRooms.length})
            </p>
            {invitedRooms.map((room) => (
              <div key={room.roomId} className="flex items-center px-2 py-1.5 rounded-md bg-bg-tertiary/60 mb-0.5">
                <span className="mr-1.5 text-text-muted/90 shrink-0 text-base leading-none">#</span>
                <span className="flex-1 min-w-0 text-sm font-medium text-text-secondary truncate">{room.name}</span>
                <div className="flex gap-1 shrink-0 ml-1">
                  <button
                    onClick={() => handleAcceptInvite(room.roomId)}
                    disabled={pendingInvites.has(room.roomId)}
                    className="px-2 py-0.5 text-[10px] font-semibold rounded bg-accent-pink text-white hover:bg-accent-pink-hover transition-colors disabled:opacity-50 cursor-pointer"
                    title="Accepter l'invitation"
                  >
                    Oui
                  </button>
                  <button
                    onClick={() => handleDeclineInvite(room.roomId)}
                    disabled={pendingInvites.has(room.roomId)}
                    className="px-2 py-0.5 text-[10px] font-semibold rounded bg-bg-hover text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50 cursor-pointer"
                    title="Refuser l'invitation"
                  >
                    Non
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Search mode: flat filtered list */}
        {searchResults !== null ? (
          <>
            {searchResults.map(renderRoomItem)}
            {searchResults.length === 0 && (
              <div className="text-center text-text-muted text-xs py-8">Aucun salon trouvé</div>
            )}
          </>
        ) : categories.length > 0 ? (
          /* Hierarchical mode: sub-spaces as collapsible categories */
          <>
            {/* Uncategorized rooms (direct children of the space, outside any sub-space) */}
            {uncategorized.map(renderRoomItem)}

            {/* Categories */}
            {categories.map((cat) => {
              const collapseKey = `${activeSpaceId}::${cat.id}`
              const isCollapsed = collapsedCategories.has(collapseKey)
              const hasUnread = cat.totalUnread > 0
              const hasMention = cat.totalMentions > 0
              return (
                <div key={cat.id} className="mt-2">
                  {/* Category header */}
                  <button
                    onClick={() => toggleCategory(collapseKey)}
                    className="w-full flex items-center gap-1 px-1 py-0.5 group rounded transition-colors hover:bg-bg-hover/30 cursor-pointer"
                    aria-expanded={!isCollapsed}
                  >
                    <svg
                      className={`w-3 h-3 text-text-muted shrink-0 transition-transform duration-150 ${isCollapsed ? '-rotate-90' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                    <span className="flex-1 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted group-hover:text-text-secondary truncate">
                      {cat.name}
                    </span>
                    {isCollapsed && (hasMention ? (
                      <span className="shrink-0 flex items-center justify-center rounded-full min-w-[16px] h-[16px] px-1 text-[10px] font-bold text-white bg-accent-pink">
                        {cat.totalMentions > 99 ? '99+' : cat.totalMentions}
                      </span>
                    ) : hasUnread ? (
                      <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-pink" />
                    ) : null)}
                  </button>

                  {/* Category rooms */}
                  {!isCollapsed && (
                    <div className="mt-0.5 space-y-0.5">
                      {cat.rooms.map(renderRoomItem)}
                      {cat.rooms.length === 0 && (
                        <p className="px-4 py-1 text-xs text-text-muted italic">Aucun salon</p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {uncategorized.length === 0 && categories.every((c) => c.rooms.length === 0) && (
              <div className="text-center text-text-muted text-xs py-8">Aucun salon</div>
            )}
          </>
        ) : (
          /* Flat mode: no space active, or space with no sub-spaces */
          <>
            {uncategorized.map(renderRoomItem)}
            {uncategorized.length === 0 && (
              <div className="text-center text-text-muted text-xs py-8">Aucun salon trouvé</div>
            )}
          </>
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
            title={isDeafened ? "Activer l'audio" : "Désactiver l'audio"}
            aria-label={isDeafened ? "Activer l'audio" : "Désactiver l'audio"}
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
