import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { Avatar } from '../common/Avatar'
import { useAuthStore } from '../../stores/authStore'
import { useUiStore } from '../../stores/uiStore'
import {
  getOwnAvatarUrl,
  getRoomMemberProfileBasics,
  getStoredOwnStatusMessage,
  getUserProfileBasics,
  joinRoom,
  declineInvite,
  joinVoiceRoom,
  leaveVoiceRoom,
  loadRoomMembers,
  setOwnPresence,
  createRoom,
  canUserCreateRoom,
} from '../../lib/matrix'
import { getWaifuById } from '../../lib/waifu'
import { setVoiceMuted, setVoiceDeafened } from '../../lib/voice'
import type { RoomSummary } from '../../types/matrix'
import type { PresenceValue } from '../../stores/uiStore'
import { VoicePanel } from './VoicePanel'
import { useVoiceStore } from '../../stores/voiceStore'

// ─── Types ───────────────────────────────────────────────────────────────────

const PRESENCE_OPTIONS: { value: PresenceValue; label: string; color: string }[] = [
  { value: 'online',      label: 'En ligne',   color: 'bg-success' },
  { value: 'unavailable', label: 'Absent',      color: 'bg-warning' },
  { value: 'offline',     label: 'Hors-ligne',  color: 'bg-text-muted' },
]

/** Flat ordered list stored per space – 't':'r'=room 't':'c'=category */
type LayoutItem = { t: 'r' | 'c'; id: string }
/** Map: spaceId (or '_flat') → flat LayoutItem[] */
type SidebarLayout = Record<string, LayoutItem[]>

/** Visual items rendered in the sidebar */
type DisplayItem =
  | { kind: 'category'; id: string; name: string; collapseKey: string; isCollapsed: boolean; totalUnread: number; totalMentions: number }
  | { kind: 'room'; room: RoomSummary; indented: boolean }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isVoiceRoom(room: { roomType?: string; name: string; topic: string }): boolean {
  const r = room as { isVoice?: boolean; roomType?: string; name: string; topic: string }
  if (r.isVoice) return true
  const type = (room.roomType || '').toLowerCase()
  if (type.includes('voice') || type.includes('call')) return true
  return /\b(vocal|voice|audio)\b/.test(`${room.name} ${room.topic}`.toLowerCase())
}

function isVoiceDebugEnabled(): boolean {
  try { return localStorage.getItem('waifutxt_debug_voice') === '1' } catch { return false }
}

function loadCollapsed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('waifutxt_collapsed_categories') || '[]') as string[]) }
  catch { return new Set() }
}

function loadLayout(): SidebarLayout {
  try { return JSON.parse(localStorage.getItem('waifutxt_sidebar_order') || '{}') as SidebarLayout }
  catch { return {} }
}

function saveLayout(layout: SidebarLayout) {
  localStorage.setItem('waifutxt_sidebar_order', JSON.stringify(layout))
}

/**
 * Build the natural order from Matrix data (no stored override).
 * Uncategorized rooms first, then categories with their rooms interleaved.
 */
function buildNaturalOrder(
  uncatRooms: RoomSummary[],
  categories: { id: string; rooms: RoomSummary[] }[],
): LayoutItem[] {
  // Track added IDs to prevent duplicates: a room can appear as both a direct
  // child of the space AND a child of a sub-space simultaneously in Matrix.
  const seen = new Set<string>()
  const items: LayoutItem[] = []
  for (const r of uncatRooms) {
    if (!seen.has(r.roomId)) { seen.add(r.roomId); items.push({ t: 'r' as const, id: r.roomId }) }
  }
  for (const cat of categories) {
    if (!seen.has(cat.id)) { seen.add(cat.id); items.push({ t: 'c', id: cat.id }) }
    for (const room of cat.rooms) {
      if (!seen.has(room.roomId)) { seen.add(room.roomId); items.push({ t: 'r', id: room.roomId }) }
    }
  }
  return items
}

/**
 * Apply stored layout order, keeping only existing items and appending new ones.
 */
function applyStoredLayout(
  stored: LayoutItem[] | undefined,
  natural: LayoutItem[],
): LayoutItem[] {
  if (!stored || stored.length === 0) return natural
  const validIds = new Set(natural.map((i) => i.id))
  // Filter stored list to valid items only, deduplicating as we go
  const seen = new Set<string>()
  const applied: LayoutItem[] = []
  for (const item of stored) {
    if (validIds.has(item.id) && !seen.has(item.id)) { seen.add(item.id); applied.push(item) }
  }
  // Append items from natural order that aren't in the stored list yet
  for (const item of natural) {
    if (!seen.has(item.id)) { seen.add(item.id); applied.push(item) }
  }
  return applied
}

/**
 * Move `fromId` to just before `toId` in the list.
 */
function reorderList(list: LayoutItem[], fromId: string, toId: string): LayoutItem[] {
  const without = list.filter((i) => i.id !== fromId)
  const toIdx = without.findIndex((i) => i.id === toId)
  if (toIdx === -1) return list
  const result = [...without]
  result.splice(toIdx, 0, list.find((i) => i.id === fromId)!)
  return result
}

/**
 * Expand a flat LayoutItem[] into visual DisplayItem[], respecting collapse state.
 */
function buildDisplay(
  layoutItems: LayoutItem[],
  catMap: Map<string, { id: string; name: string; rooms: RoomSummary[] }>,
  roomMap: Map<string, RoomSummary>,
  collapsed: Set<string>,
  spaceId: string,
): DisplayItem[] {
  const result: DisplayItem[] = []
  let insideCatId: string | null = null
  let catCollapsed = false

  for (const item of layoutItems) {
    if (item.t === 'c') {
      const cat = catMap.get(item.id)
      if (!cat) continue
      const collapseKey = `${spaceId}::${cat.id}`
      catCollapsed = collapsed.has(collapseKey)
      insideCatId = cat.id
      const catRooms = layoutItems
        .slice(layoutItems.indexOf(item) + 1)
        .reduce<RoomSummary[]>((acc, next) => {
          if (next.t === 'c') return acc  // stop at next category boundary (via reduce returning original)
          const r = roomMap.get(next.id)
          if (r) acc.push(r)
          return acc
        }, [])
      // Recompute only rooms that follow this category until next category
      const visibleRooms = (() => {
        const rooms: RoomSummary[] = []
        let i = layoutItems.indexOf(item) + 1
        while (i < layoutItems.length && layoutItems[i].t !== 'c') {
          const r = roomMap.get(layoutItems[i].id)
          if (r) rooms.push(r)
          i++
        }
        return rooms
      })()
      result.push({
        kind: 'category',
        id: cat.id,
        name: cat.name,
        collapseKey,
        isCollapsed: catCollapsed,
        totalUnread: visibleRooms.reduce((s, r) => s + r.unreadCount, 0),
        totalMentions: visibleRooms.reduce((s, r) => s + r.mentionCount, 0),
      })
    } else {
      if (catCollapsed && insideCatId !== null) continue  // hidden by collapsed category
      const room = roomMap.get(item.id)
      if (!room) continue
      result.push({ kind: 'room', room, indented: insideCatId !== null })
    }
  }
  return result
}

// ─── Component ───────────────────────────────────────────────────────────────

export function RoomSidebar() {
  const [search, setSearch] = useState('')
  const isMuted = useVoiceStore((s) => s.isMuted)
  const isDeafened = useVoiceStore((s) => s.isDeafened)
  const [voiceActionRoomId, setVoiceActionRoomId] = useState<string | null>(null)
  const [showPresenceMenu, setShowPresenceMenu] = useState(false)
  const [ownPresence, setOwnPresenceStore] = useState<PresenceValue>(() => {
    const s = localStorage.getItem('waifutxt_presence')
    return s === 'online' || s === 'unavailable' || s === 'offline' ? s : 'online'
  })
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [sidebarLayout, setSidebarLayout] = useState<SidebarLayout>(loadLayout)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const [showCreateRoomModal, setShowCreateRoomModal] = useState(false)
  const [newRoomName, setNewRoomName] = useState('')
  const [newRoomTopic, setNewRoomTopic] = useState('')
  const [newRoomType, setNewRoomType] = useState<'public' | 'private'>('private')
  const [createRoomError, setCreateRoomError] = useState<string | null>(null)
  const [isCreatingRoom, setIsCreatingRoom] = useState(false)

  const presenceMenuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const rooms = useRoomStore((s) => s.rooms)
  const activeSpaceId = useRoomStore((s) => s.activeSpaceId)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const membersByRoom = useRoomStore((s) => s.members)
  const updatePresence = useRoomStore((s) => s.updatePresence)
  const statusMessageMap = useRoomStore((s) => s.statusMessageMap)
  const session = useAuthStore((s) => s.session)
  const setSettingsModal = useUiStore((s) => s.setSettingsModal)
  const setMobileMenuOpen = useUiStore((s) => s.setMobileMenuOpen)
  const showRoomMessagePreview = useUiStore((s) => s.showRoomMessagePreview)
  const showUnreadDot = useUiStore((s) => s.showUnreadDot)
  const showMentionBadge = useUiStore((s) => s.showMentionBadge)
  const waifuOptIn = useUiStore((s) => s.waifuOptIn)
  const selectedWaifuId = useUiStore((s) => s.selectedWaifuId)
  const roomSearchFocusBump = useUiStore((s) => s.roomSearchFocusBump)
  const myUserId = session?.userId ?? null
  const ownStatusPhrase = (myUserId ? statusMessageMap[myUserId]?.trim() : '') || getStoredOwnStatusMessage().trim()

  useEffect(() => {
    if (roomSearchFocusBump > 0) { searchInputRef.current?.focus(); searchInputRef.current?.select() }
  }, [roomSearchFocusBump])

  const [ownAvatarUrl, setOwnAvatarUrl] = useState<string | null>(null)
  const [voiceProfileMap, setVoiceProfileMap] = useState<Record<string, { displayName: string | null; avatarUrl: string | null }>>({})
  const loadedVoiceMembersRef = useRef(new Set<string>())
  useEffect(() => { const u = getOwnAvatarUrl(); if (u) setOwnAvatarUrl(u) }, [rooms])

  const displayedOwnAvatarUrl = useMemo(() => {
    if (waifuOptIn) return getWaifuById(selectedWaifuId).imageUrl
    return ownAvatarUrl
  }, [ownAvatarUrl, selectedWaifuId, waifuOptIn])

  useEffect(() => {
    if (!showPresenceMenu) return
    const h = (e: MouseEvent) => { if (!presenceMenuRef.current?.contains(e.target as Node)) setShowPresenceMenu(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [showPresenceMenu])

  const handleSetPresence = async (presence: PresenceValue) => {
    setOwnPresenceStore(presence)
    localStorage.setItem('waifutxt_presence', presence)
    if (myUserId) updatePresence(myUserId, presence)
    setShowPresenceMenu(false)
    await setOwnPresence(presence)
  }

  const canCreate = activeSpaceId ? canUserCreateRoom(activeSpaceId) : false

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isCreatingRoom || !newRoomName.trim() || !activeSpaceId) return
    setCreateRoomError(null)
    setIsCreatingRoom(true)
    try {
      const roomId = await createRoom(newRoomName.trim(), {
        topic: newRoomTopic.trim() || undefined,
        visibility: newRoomType,
        parentSpaceId: activeSpaceId,
      })
      setActiveRoom(roomId)
      setShowCreateRoomModal(false)
      setNewRoomName('')
      setNewRoomTopic('')
      setNewRoomType('private')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Impossible de créer le salon'
      setCreateRoomError(message)
    } finally {
      setIsCreatingRoom(false)
    }
  }

  // ── Invitations ──────────────────────────────────────────────────────────
  const [pendingInvites, setPendingInvites] = useState<Set<string>>(new Set())

  const handleAcceptInvite = async (roomId: string) => {
    setPendingInvites((s) => new Set(s).add(roomId))
    try { await joinRoom(roomId); setActiveRoom(roomId) }
    finally { setPendingInvites((s) => { const n = new Set(s); n.delete(roomId); return n }) }
  }
  const handleDeclineInvite = async (roomId: string) => {
    setPendingInvites((s) => new Set(s).add(roomId))
    try { await declineInvite(roomId); setMobileMenuOpen(false) }
    finally { setPendingInvites((s) => { const n = new Set(s); n.delete(roomId); return n }) }
  }

  // ── Category collapse ────────────────────────────────────────────────────
  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      localStorage.setItem('waifutxt_collapsed_categories', JSON.stringify([...next]))
      return next
    })
  }, [])

  // ── Drag & drop ──────────────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggingId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverId(id)
  }, [])

  const handleDragEnd = useCallback(() => { setDraggingId(null); setDragOverId(null) }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetId: string, spaceKey: string, currentLayout: LayoutItem[]) => {
    e.preventDefault()
    if (!draggingId || draggingId === targetId) { handleDragEnd(); return }
    const newList = reorderList(currentLayout, draggingId, targetId)
    const newSidebarLayout = { ...sidebarLayout, [spaceKey]: newList }
    setSidebarLayout(newSidebarLayout)
    saveLayout(newSidebarLayout)
    handleDragEnd()
  }, [draggingId, sidebarLayout, handleDragEnd])

  // Drop at end of list (after all items)
  const handleDropAtEnd = useCallback((e: React.DragEvent, spaceKey: string, currentLayout: LayoutItem[]) => {
    e.preventDefault()
    if (!draggingId) { handleDragEnd(); return }
    const without = currentLayout.filter((i) => i.id !== draggingId)
    const moved = currentLayout.find((i) => i.id === draggingId)
    if (!moved) { handleDragEnd(); return }
    const newList = [...without, moved]
    const newSidebarLayout = { ...sidebarLayout, [spaceKey]: newList }
    setSidebarLayout(newSidebarLayout)
    saveLayout(newSidebarLayout)
    handleDragEnd()
  }, [draggingId, sidebarLayout, handleDragEnd])

  // ── Main data computation ─────────────────────────────────────────────────
  const { displayItems, layoutItems, spaceKey, invitedRooms, allDisplayedRooms } = useMemo(() => {
    const allRooms = Array.from(rooms.values())
    const joinedOnly = allRooms.filter((r) => r.membership !== 'invite')

    // Build a global map: invitedRoomId → spaceId that claims it as a child
    const allSpaceChildIds = new Set<string>()
    const inviteToSpace = new Map<string, string>()
    for (const r of allRooms) {
      if (!r.isSpace) continue
      for (const childId of r.children) {
        allSpaceChildIds.add(childId)
        inviteToSpace.set(childId, r.roomId)
      }
    }

    const roomMap = new Map(joinedOnly.map((r) => [r.roomId, r]))

    if (activeSpaceId === null) {
      // "Messages" view: DMs + private group rooms not belonging to any space
      // Invites: only those that don't belong to any space
      const key = '_flat'
      const spaceChildIds = new Set<string>()
      for (const r of joinedOnly) {
        if (r.isSpace) for (const id of r.children) spaceChildIds.add(id)
      }
      const flatRooms = joinedOnly
        .filter((r) => !r.isSpace && (r.isDirect || !spaceChildIds.has(r.roomId)))
        .sort((a, b) => b.lastMessageTs - a.lastMessageTs)
      const invited = allRooms.filter((r) => r.membership === 'invite' && !allSpaceChildIds.has(r.roomId))
      const natural: LayoutItem[] = flatRooms.map((r) => ({ t: 'r', id: r.roomId }))
      const ordered = applyStoredLayout(sidebarLayout[key], natural)
      const display: DisplayItem[] = ordered
        .map((item) => {
          const room = roomMap.get(item.id)
          return room ? ({ kind: 'room', room, indented: false } as DisplayItem) : null
        })
        .filter((x): x is DisplayItem => x !== null)
      return { displayItems: display, layoutItems: ordered, spaceKey: key, invitedRooms: invited, allDisplayedRooms: flatRooms }
    }

    // Hierarchical mode: space is active
    // Invites: only those that are children of this space
    const invited = allRooms.filter((r) => r.membership === 'invite' && inviteToSpace.get(r.roomId) === activeSpaceId)
    const space = rooms.get(activeSpaceId)
    if (!space) return { displayItems: [], layoutItems: [], spaceKey: activeSpaceId, invitedRooms: invited, allDisplayedRooms: [] }

    const key = activeSpaceId
    const catMap = new Map<string, { id: string; name: string; rooms: RoomSummary[] }>()
    const uncatRooms: RoomSummary[] = []

    for (const childId of space.children) {
      const child = rooms.get(childId)
      if (!child || child.membership === 'invite') continue
      if (child.isSpace) {
        const catRooms = child.children
          .map((id) => rooms.get(id))
          .filter((r): r is RoomSummary => !!r && !r.isSpace && r.membership !== 'invite')
          .sort((a, b) => b.lastMessageTs - a.lastMessageTs)
        catMap.set(child.roomId, { id: child.roomId, name: child.name, rooms: catRooms })
      } else {
        uncatRooms.push(child)
      }
    }
    uncatRooms.sort((a, b) => b.lastMessageTs - a.lastMessageTs)

    const natural = buildNaturalOrder(uncatRooms, Array.from(catMap.values()))
    const ordered = applyStoredLayout(sidebarLayout[key], natural)
    const display = buildDisplay(ordered, catMap, roomMap, collapsed, activeSpaceId)

    const allShown = display
      .filter((d): d is DisplayItem & { kind: 'room' } => d.kind === 'room')
      .map((d) => d.room)

    return { displayItems: display, layoutItems: ordered, spaceKey: key, invitedRooms: invited, allDisplayedRooms: allShown }
  }, [rooms, activeSpaceId, sidebarLayout, collapsed])

  // ── Search ────────────────────────────────────────────────────────────────
  const searchResults = useMemo(() => {
    if (!search) return null
    const q = search.toLowerCase()
    return allDisplayedRooms.filter((r) => r.name.toLowerCase().includes(q))
  }, [search, allDisplayedRooms])

  // ── Voice profile fetching ────────────────────────────────────────────────
  const voiceScanRooms = searchResults ?? allDisplayedRooms
  useEffect(() => {
    const voiceUsers = new Map<string, string>()
    for (const room of voiceScanRooms) {
      if (!isVoiceRoom(room)) continue
      if ((room.voiceParticipants || []).length > 0 && !membersByRoom.get(room.roomId) && !loadedVoiceMembersRef.current.has(room.roomId)) {
        loadedVoiceMembersRef.current.add(room.roomId)
        loadRoomMembers(room.roomId).catch(() => loadedVoiceMembersRef.current.delete(room.roomId))
      }
      for (const p of room.voiceParticipants || []) {
        if (!p.userId || p.avatarUrl) continue
        voiceUsers.set(p.userId, room.roomId)
      }
    }
    const toFetch = [...voiceUsers.entries()].filter(([id]) => !(id in voiceProfileMap))
    if (!toFetch.length) return
    let cancelled = false
    Promise.all(toFetch.map(async ([userId, roomId]) => ({
      userId,
      profile: await (async () => {
        const p = await getRoomMemberProfileBasics(roomId, userId, 24)
        return p.avatarUrl ? p : getUserProfileBasics(userId, 24)
      })(),
    }))).then((items) => {
      if (cancelled) return
      setVoiceProfileMap((prev) => { const next = { ...prev }; for (const i of items) next[i.userId] = i.profile; return next })
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [voiceScanRooms, voiceProfileMap, membersByRoom])

  useEffect(() => {
    if (!isVoiceDebugEnabled()) return
    console.debug('[VoiceDebug] RoomSidebar', voiceScanRooms.filter((r) => isVoiceRoom(r) && (r.voiceParticipants || []).length > 0))
  }, [voiceScanRooms, membersByRoom, voiceProfileMap])

  const spaceName = activeSpaceId ? rooms.get(activeSpaceId)?.name || 'Space' : 'Messages'
  const speakingUsers = useVoiceStore((s) => s.speakingUsers)
  const voiceStoreJoinedRoom = useVoiceStore((s) => s.joinedRoomId)
  const joinedVoiceRoomId = useMemo(() => {
    if (voiceStoreJoinedRoom) return voiceStoreJoinedRoom
    for (const r of rooms.values()) { if (isVoiceRoom(r) && r.voiceJoinedByMe) return r.roomId }
    return null
  }, [rooms, voiceStoreJoinedRoom])

  const [voiceError, setVoiceError] = useState<string | null>(null)
  const handleVoiceJoinLeave = async (roomId: string, joined: boolean) => {
    if (voiceActionRoomId) return
    setVoiceActionRoomId(roomId)
    setVoiceError(null)
    try {
      if (joined) await leaveVoiceRoom(roomId)
      else { await joinVoiceRoom(roomId); setActiveRoom(roomId) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Voice] join/leave failed:', msg)
      setVoiceError(msg)
      setTimeout(() => setVoiceError(null), 5000)
    } finally { setVoiceActionRoomId(null) }
  }

  // ── Grip icon SVG ─────────────────────────────────────────────────────────
  const GripIcon = () => (
    <svg className="w-2.5 h-2.5" viewBox="0 0 10 16" fill="currentColor">
      <circle cx="2.5" cy="2" r="1.5" /><circle cx="7.5" cy="2" r="1.5" />
      <circle cx="2.5" cy="7" r="1.5" /><circle cx="7.5" cy="7" r="1.5" />
      <circle cx="2.5" cy="12" r="1.5" /><circle cx="7.5" cy="12" r="1.5" />
    </svg>
  )

  // ── Room item ─────────────────────────────────────────────────────────────
  const renderRoomItem = (room: RoomSummary, indented: boolean) => {
    const isVoice = isVoiceRoom(room)
    const isJoinedVoice = joinedVoiceRoomId === room.roomId
    const participants = room.voiceParticipants || []
    const roomMembers = membersByRoom.get(room.roomId) || []
    const isDragging = draggingId === room.roomId
    const isDropTarget = dragOverId === room.roomId

    return (
      <div
        key={room.roomId}
        className={`space-y-1 transition-opacity ${isDragging ? 'opacity-40' : ''}`}
        draggable
        onDragStart={(e) => handleDragStart(e, room.roomId)}
        onDragOver={(e) => handleDragOver(e, room.roomId)}
        onDrop={(e) => handleDrop(e, room.roomId, spaceKey, layoutItems)}
        onDragEnd={handleDragEnd}
      >
        {isDropTarget && !isDragging && <div className="h-0.5 rounded-full bg-accent-pink mx-2 mb-0.5" />}
        <button
          onClick={() => setActiveRoom(room.roomId)}
          className={`w-full flex items-center px-2 py-1.5 rounded-md transition-colors text-left cursor-pointer group ${
            indented ? 'pl-5' : ''
          } ${
            activeRoomId === room.roomId
              ? 'bg-bg-hover text-text-primary'
              : room.unreadCount > 0
                ? 'text-text-primary hover:bg-bg-hover/50'
                : 'text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary'
          }`}
        >
          <span className="mr-1 text-text-muted/0 group-hover:text-text-muted/40 shrink-0 transition-colors cursor-grab active:cursor-grabbing" aria-hidden>
            <GripIcon />
          </span>
          <span className="mr-1.5 text-text-muted/90 shrink-0" aria-hidden>
            {isVoice ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 14a3 3 0 003-3V7a3 3 0 10-6 0v4a3 3 0 003 3z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 11-14 0m7 7v3" />
              </svg>
            ) : <span className="text-base leading-none">#</span>}
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
                      isJoinedVoice ? 'text-danger bg-danger/12 hover:bg-danger/20' : 'text-success bg-success/12 hover:bg-success/20'
                    } ${voiceActionRoomId === room.roomId ? 'opacity-60 cursor-wait' : ''}`}
                    title={isJoinedVoice ? 'Quitter le vocal' : 'Rejoindre le vocal'}
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
            {participants.map((p) => {
              const m = roomMembers.find((mem) => mem.userId === p.userId)
              const displayName = m?.displayName || voiceProfileMap[p.userId]?.displayName || p.displayName
              const avatarUrl = m?.avatarUrl || p.avatarUrl || voiceProfileMap[p.userId]?.avatarUrl || null
              const isSpeaking = speakingUsers.has(p.userId)
              return (
                <button key={`${room.roomId}:${p.userId}`} onClick={() => setActiveRoom(room.roomId)}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-text-muted hover:text-text-primary hover:bg-bg-hover/40 transition-colors cursor-pointer"
                  title={p.userId}>
                  <div className={`shrink-0 rounded-full transition-[box-shadow,box-shadow] duration-200 ${isSpeaking ? 'ring-2 ring-accent-pink shadow-[0_0_6px_2px_rgba(255,45,120,0.5)]' : ''}`}>
                    <Avatar src={avatarUrl} name={displayName} size={18} />
                  </div>
                  <span className={`text-xs truncate ${isSpeaking ? 'text-text-primary' : ''}`}>{displayName}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="w-60 bg-bg-secondary flex flex-col border-r border-border">
      <div className="h-12 px-3 flex items-center justify-between border-b border-border shrink-0">
        <h2 className="font-semibold text-text-primary truncate text-sm">{spaceName}</h2>
        {activeSpaceId && canCreate && (
          <button
            onClick={() => setShowCreateRoomModal(true)}
            className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title="Créer un salon"
            aria-label="Créer un salon"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m7-7H5" />
            </svg>
          </button>
        )}
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

      {voiceError && (
        <div className="mx-2 mb-1 px-2.5 py-1.5 rounded-md bg-danger/10 border border-danger/30 text-xs text-danger">
          {voiceError}
        </div>
      )}

      <div
        className="flex-1 overflow-y-auto px-2 space-y-0.5"
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null) }}
      >
        {/* Invitations */}
        {invitedRooms.length > 0 && (
          <div className="mb-1">
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Invitations ({invitedRooms.length})
            </p>
            {invitedRooms.map((room) => (
              <div key={room.roomId} className="flex items-center px-2 py-2 rounded-md bg-bg-tertiary/60 mb-0.5 gap-1.5">
                <span className="text-text-muted/90 shrink-0 text-base leading-none">#</span>
                <span className="flex-1 min-w-0 text-sm font-medium text-text-secondary truncate">{room.name}</span>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => handleAcceptInvite(room.roomId)} disabled={pendingInvites.has(room.roomId)}
                    className="px-2.5 py-1 text-xs font-semibold rounded bg-accent-pink text-white hover:bg-accent-pink-hover transition-colors disabled:opacity-50 cursor-pointer min-h-[28px]"
                    title="Accepter l'invitation">Oui</button>
                  <button onClick={() => handleDeclineInvite(room.roomId)} disabled={pendingInvites.has(room.roomId)}
                    className="px-2.5 py-1 text-xs font-semibold rounded bg-bg-hover text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50 cursor-pointer min-h-[28px]"
                    title="Refuser l'invitation">Non</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Search mode */}
        {searchResults !== null ? (
          <>
            {searchResults.map((r) => renderRoomItem(r, false))}
            {searchResults.length === 0 && <div className="text-center text-text-muted text-xs py-8">Aucun salon trouvé</div>}
          </>
        ) : (
          /* Normal mode: flat list with mixed rooms and categories */
          <>
            {displayItems.map((item) => {
              if (item.kind === 'room') {
                return renderRoomItem(item.room, item.indented)
              }
              // Category header
              const isDraggingCat = draggingId === item.id
              const isDropTargetCat = dragOverId === item.id
              return (
                <div
                  key={item.id}
                  className={`mt-1 transition-opacity ${isDraggingCat ? 'opacity-40' : ''}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, item.id)}
                  onDragOver={(e) => handleDragOver(e, item.id)}
                  onDrop={(e) => handleDrop(e, item.id, spaceKey, layoutItems)}
                  onDragEnd={handleDragEnd}
                >
                  {isDropTargetCat && !isDraggingCat && <div className="h-0.5 rounded-full bg-accent-pink mx-1 mb-1" />}
                  <div className="flex items-center gap-1 px-1 py-0.5 group rounded transition-colors hover:bg-bg-hover/30">
                    <span className="text-text-muted/0 group-hover:text-text-muted/40 shrink-0 transition-colors cursor-grab active:cursor-grabbing" aria-hidden>
                      <GripIcon />
                    </span>
                    <button onClick={() => toggleCollapse(item.collapseKey)}
                      className="flex items-center gap-1 flex-1 min-w-0 cursor-pointer" aria-expanded={!item.isCollapsed}>
                      <svg
                        className={`w-3 h-3 text-text-muted shrink-0 transition-transform duration-150 ${item.isCollapsed ? '-rotate-90' : ''}`}
                        fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                      <span className="flex-1 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted group-hover:text-text-secondary truncate">
                        {item.name}
                      </span>
                    </button>
                    {item.isCollapsed && (item.totalMentions > 0 ? (
                      <span className="shrink-0 flex items-center justify-center rounded-full min-w-[16px] h-[16px] px-1 text-[10px] font-bold text-white bg-accent-pink">
                        {item.totalMentions > 99 ? '99+' : item.totalMentions}
                      </span>
                    ) : item.totalUnread > 0 ? (
                      <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-pink" />
                    ) : null)}
                  </div>
                </div>
              )
            })}

            {/* Drop zone at the very end */}
            {draggingId && (
              <div
                className="h-8 rounded-md border-2 border-dashed border-accent-pink/30 hover:border-accent-pink/60 transition-colors mt-1"
                onDragOver={(e) => { e.preventDefault(); setDragOverId('__end__') }}
                onDrop={(e) => handleDropAtEnd(e, spaceKey, layoutItems)}
              />
            )}

            {displayItems.length === 0 && <div className="text-center text-text-muted text-xs py-8">Aucun salon</div>}
          </>
        )}
      </div>

      <VoicePanel />

      {showCreateRoomModal && activeSpaceId && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="w-full max-w-[480px] rounded-2xl border border-border bg-bg-secondary shadow-2xl p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-semibold text-text-primary">Créer un salon</h3>
                <p className="mt-1.5 text-sm text-text-secondary">
                  Le salon sera ajouté à <span className="font-medium text-text-primary">{spaceName}</span>.
                </p>
              </div>
              <button
                onClick={() => {
                  if (isCreatingRoom) return
                  setShowCreateRoomModal(false)
                  setNewRoomName('')
                  setNewRoomTopic('')
                  setNewRoomType('private')
                  setCreateRoomError(null)
                }}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                aria-label="Fermer"
              >
                ×
              </button>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setNewRoomType('private')}
                className={`flex-1 rounded-lg border p-3 text-left transition-colors cursor-pointer ${
                  newRoomType === 'private'
                    ? 'border-accent-pink bg-accent-pink/10'
                    : 'border-border bg-bg-primary/40 hover:bg-bg-hover'
                }`}
              >
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2.25m-4.5 0h9A2.25 2.25 0 0018.75 15V9.75A2.25 2.25 0 0016.5 7.5h-9A2.25 2.25 0 005.25 9.75V15A2.25 2.25 0 007.5 17.25zM9 7.5V6a3 3 0 016 0v1.5" />
                  </svg>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">Privé</p>
                    <p className="text-xs text-text-muted">Sur invitation</p>
                  </div>
                </div>
              </button>
              <button
                onClick={() => setNewRoomType('public')}
                className={`flex-1 rounded-lg border p-3 text-left transition-colors cursor-pointer ${
                  newRoomType === 'public'
                    ? 'border-accent-pink bg-accent-pink/10'
                    : 'border-border bg-bg-primary/40 hover:bg-bg-hover'
                }`}
              >
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18" />
                  </svg>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">Public</p>
                    <p className="text-xs text-text-muted">Ouvert à tous</p>
                  </div>
                </div>
              </button>
            </div>

            <form onSubmit={handleCreateRoom} className="mt-4 space-y-3">
              <div>
                <label className="block text-sm text-text-secondary mb-1" htmlFor="new-room-name">
                  Nom du salon
                </label>
                <input
                  id="new-room-name"
                  type="text"
                  value={newRoomName}
                  onChange={(e) => {
                    setNewRoomName(e.target.value)
                    if (createRoomError) setCreateRoomError(null)
                  }}
                  placeholder="nouveau-salon"
                  disabled={isCreatingRoom}
                  autoFocus
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm text-text-secondary mb-1" htmlFor="new-room-topic">
                  Description <span className="text-text-muted">(optionnel)</span>
                </label>
                <input
                  id="new-room-topic"
                  type="text"
                  value={newRoomTopic}
                  onChange={(e) => setNewRoomTopic(e.target.value)}
                  placeholder="À quoi sert ce salon ?"
                  disabled={isCreatingRoom}
                  className="w-full"
                />
              </div>
              {createRoomError && (
                <p className="text-xs text-danger">{createRoomError}</p>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    if (isCreatingRoom) return
                    setShowCreateRoomModal(false)
                    setNewRoomName('')
                    setNewRoomTopic('')
                    setNewRoomType('private')
                    setCreateRoomError(null)
                  }}
                  className="px-3 py-2 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                  disabled={isCreatingRoom}
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={isCreatingRoom || !newRoomName.trim()}
                  className="px-3 py-2 text-sm rounded-md bg-accent-pink text-white hover:bg-accent-pink-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {isCreatingRoom ? 'Création...' : 'Créer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="relative -left-[72px] w-[calc(100%+72px)] min-h-[3.25rem] py-2 pl-[80px] pr-2 flex items-center justify-between gap-2 bg-bg-tertiary/95 border-t border-border">
         {showPresenceMenu && (
          <div
            ref={presenceMenuRef}
            className="absolute bottom-16 left-[80px] w-44 bg-bg-tertiary border border-border rounded-lg shadow-xl p-1 z-50"
          >
            {PRESENCE_OPTIONS.map(({ value, label, color }) => (
              <button key={value} onClick={() => handleSetPresence(value)}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer">
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
          className="flex min-w-0 flex-1 basis-0 items-center justify-start gap-2 overflow-x-hidden rounded-md px-1.5 py-0.5 text-left hover:bg-bg-hover/70 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-pink"
          title="Changer de statut"
          aria-label="Changer de statut"
        >
          <div className={`rounded-full shrink-0 transition-[box-shadow] duration-200 ${myUserId && speakingUsers.has(myUserId) ? 'ring-2 ring-accent-pink shadow-[0_0_8px_3px_rgba(255,45,120,0.45)]' : ''}`}>
            <Avatar
              src={displayedOwnAvatarUrl}
              name={session?.userId || '?'}
              size={32}
              status={ownPresence}
            />
          </div>
          <div className="min-w-0 flex-1 overflow-hidden text-left">
            <div className="text-sm font-semibold truncate text-text-primary leading-tight">
              {session?.userId?.split(':')[0]?.replace('@', '') || ''}
            </div>
            <div
              className={`text-[11px] truncate leading-tight ${
                ownStatusPhrase ? 'font-semibold text-text-secondary' : 'text-text-muted'
              }`}
              title={ownStatusPhrase || undefined}
            >
              {ownStatusPhrase ||
                (PRESENCE_OPTIONS.find((o) => o.value === ownPresence)?.label ?? 'Hors-ligne')}
            </div>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => setVoiceMuted(!isMuted)}
            disabled={!voiceStoreJoinedRoom}
            className={`p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
              isMuted
                ? 'text-danger bg-danger/10 hover:bg-danger/20'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover/80'
            }`}
            title={isMuted ? 'Activer le micro' : 'Couper le micro'}
            aria-label={isMuted ? 'Activer le micro' : 'Couper le micro'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              {isMuted
                ? <><path strokeLinecap="round" strokeLinejoin="round" d="M9 9v3a3 3 0 006 0V9m-3 8v3m-4-3a7 7 0 008 0M3 3l18 18" /></>
                : <><path strokeLinecap="round" strokeLinejoin="round" d="M12 14a3 3 0 003-3V7a3 3 0 10-6 0v4a3 3 0 003 3z" /><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 11-14 0m7 7v3" /></>}
            </svg>
          </button>

          <button onClick={() => setVoiceDeafened(!isDeafened)}
            disabled={!voiceStoreJoinedRoom}
            className={`p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${isDeafened ? 'text-danger bg-danger/10 hover:bg-danger/20' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover/80'}`}
            title={isDeafened ? "Activer l'audio" : "Désactiver l'audio"}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              {isDeafened
                ? <><path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" /><path strokeLinecap="round" strokeLinejoin="round" d="M10 8.5L7.5 11H5v2h2.5l3.5 3.5V8.5zM16 8a5 5 0 012 4 5 5 0 01-.6 2.4" /></>
                : <><path strokeLinecap="round" strokeLinejoin="round" d="M11 5L6 9H3v6h3l5 4V5z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15.5 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" /></>}
            </svg>
          </button>

          <button onClick={() => setSettingsModal(true)}
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover/80 transition-colors cursor-pointer"
            title="Paramètres utilisateur">
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
