import { create } from 'zustand'
import type { RoomSummary, RoomMember } from '../types/matrix'

interface RoomState {
  rooms: Map<string, RoomSummary>
  activeRoomId: string | null
  activeSpaceId: string | null
  members: Map<string, RoomMember[]>

  setRooms: (rooms: Map<string, RoomSummary>) => void
  updateRoom: (roomId: string, update: Partial<RoomSummary>) => void
  setActiveRoom: (roomId: string | null) => void
  setActiveSpace: (spaceId: string | null) => void
  setMembers: (roomId: string, members: RoomMember[]) => void
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
    }),
}))
