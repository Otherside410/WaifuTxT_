import { create } from 'zustand'
import type { RoomSummary, RoomMember } from '../types/matrix'
import type { PresenceValue } from './uiStore'

interface RoomState {
  rooms: Map<string, RoomSummary>
  activeRoomId: string | null
  activeSpaceId: string | null
  members: Map<string, RoomMember[]>
  presenceMap: Record<string, PresenceValue>
  /** Custom status from Matrix presence (status_msg); key absent = unknown / none */
  statusMessageMap: Record<string, string>

  setRooms: (rooms: Map<string, RoomSummary>) => void
  updateRoom: (roomId: string, update: Partial<RoomSummary>) => void
  setActiveRoom: (roomId: string | null) => void
  setActiveSpace: (spaceId: string | null) => void
  setMembers: (roomId: string, members: RoomMember[]) => void
  updatePresence: (userId: string, presence: PresenceValue) => void
  setStatusMessage: (userId: string, message: string | null) => void
  getSpaces: () => RoomSummary[]
  getRoomsForSpace: (spaceId: string | null) => RoomSummary[]
  getDirectMessages: () => RoomSummary[]
  reset: () => void
}

export const useRoomStore = create<RoomState>((set, get) => ({
  rooms: new Map(),
  activeRoomId: null,
  activeSpaceId: null,
  members: new Map(),
  presenceMap: {},
  statusMessageMap: {},

  setRooms: (rooms) => set({ rooms }),

  updateRoom: (roomId, update) => {
    const rooms = new Map(get().rooms)
    const existing = rooms.get(roomId)
    if (existing) {
      rooms.set(roomId, { ...existing, ...update })
      set({ rooms })
    }
  },

  setActiveRoom: (roomId) => set({ activeRoomId: roomId }),
  setActiveSpace: (spaceId) => set({ activeSpaceId: spaceId }),

  setMembers: (roomId, members) => {
    const allMembers = new Map(get().members)
    allMembers.set(roomId, members)
    set({ members: allMembers })
  },

  updatePresence: (userId, presence) => {
    set({ presenceMap: { ...get().presenceMap, [userId]: presence } })
  },

  setStatusMessage: (userId, message) => {
    set((state) => {
      const next = { ...state.statusMessageMap }
      if (message === null || message === '') {
        delete next[userId]
      } else {
        next[userId] = message
      }
      return { statusMessageMap: next }
    })
  },

  getSpaces: () => {
    const { rooms } = get()
    return Array.from(rooms.values()).filter((r) => r.isSpace)
  },

  getRoomsForSpace: (spaceId) => {
    const { rooms } = get()
    if (!spaceId) {
      return Array.from(rooms.values())
        .filter((r) => !r.isSpace && !r.isDirect)
        .sort((a, b) => b.lastMessageTs - a.lastMessageTs)
    }
    const space = rooms.get(spaceId)
    if (!space) return []
    return space.children
      .map((id) => rooms.get(id))
      .filter((r): r is RoomSummary => !!r && !r.isSpace)
      .sort((a, b) => b.lastMessageTs - a.lastMessageTs)
  },

  getDirectMessages: () => {
    const { rooms } = get()
    return Array.from(rooms.values())
      .filter((r) => r.isDirect)
      .sort((a, b) => b.lastMessageTs - a.lastMessageTs)
  },

  reset: () =>
    set({
      rooms: new Map(),
      activeRoomId: null,
      activeSpaceId: null,
      members: new Map(),
      presenceMap: {},
      statusMessageMap: {},
    }),
}))
