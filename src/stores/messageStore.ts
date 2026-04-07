import { create } from 'zustand'
import type { MessageEvent, TypingState } from '../types/matrix'

interface MessageState {
  messages: Map<string, MessageEvent[]>
  typing: Map<string, string[]>
  /** RoomIds for which loadInitialMessages has completed this session (in-memory only). */
  loadedRooms: Set<string>
  isLoadingHistory: boolean
  receiptsVersion: number
  reactionsVersion: number
  pinnedEventIds: Map<string, string[]>
  pinnedVersion: number
  threadMessages: Map<string, MessageEvent[]>
  threadsVersion: number

  getThreadMessages: (threadRootId: string) => MessageEvent[]
  addThreadMessage: (threadRootId: string, message: MessageEvent) => void
  setThreadMessages: (threadRootId: string, messages: MessageEvent[]) => void
  updateThreadRootInfo: (roomId: string, threadRootId: string, info: {
    replyCount: number
    lastReplyTs: number
    lastReplierAvatar: string | null
    lastReplierName: string
  }) => void

  addMessage: (roomId: string, message: MessageEvent) => void
  removeMessage: (roomId: string, eventId: string) => void
  replaceMessage: (roomId: string, eventId: string, message: MessageEvent) => void
  setMessages: (roomId: string, messages: MessageEvent[]) => void
  prependMessages: (roomId: string, messages: MessageEvent[]) => void
  setTyping: (typing: TypingState) => void
  bumpReceiptsVersion: () => void
  bumpReactionsVersion: () => void
  setLoadingHistory: (loading: boolean) => void
  getMessages: (roomId: string) => MessageEvent[]
  getTypingUsers: (roomId: string) => string[]
  setPinnedEventIds: (roomId: string, ids: string[]) => void
  getPinnedEventIds: (roomId: string) => string[]
  bumpPinnedVersion: () => void
  markRoomLoaded: (roomId: string) => void
  isRoomLoaded: (roomId: string) => boolean
  reset: () => void
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: new Map(),
  typing: new Map(),
  loadedRooms: new Set(),
  isLoadingHistory: false,
  receiptsVersion: 0,
  reactionsVersion: 0,
  pinnedEventIds: new Map(),
  pinnedVersion: 0,
  threadMessages: new Map(),
  threadsVersion: 0,

  addMessage: (roomId, message) => {
    const allMessages = new Map(get().messages)
    const roomMessages = allMessages.get(roomId) || []
    const exists = roomMessages.some((m) => m.eventId === message.eventId)
    if (!exists) {
      allMessages.set(roomId, [...roomMessages, message])
      set({ messages: allMessages })
    }
  },

  removeMessage: (roomId, eventId) => {
    const allMessages = new Map(get().messages)
    const roomMessages = allMessages.get(roomId)
    if (!roomMessages) return
    const filtered = roomMessages.filter((m) => m.eventId !== eventId)
    if (filtered.length === roomMessages.length) return
    allMessages.set(roomId, filtered)
    set({ messages: allMessages })
  },

  replaceMessage: (roomId, eventId, message) => {
    const allMessages = new Map(get().messages)
    const roomMessages = allMessages.get(roomId)
    if (!roomMessages) return
    const idx = roomMessages.findIndex((m) => m.eventId === eventId)
    if (idx === -1) {
      allMessages.set(roomId, [...roomMessages, message])
    } else {
      const updated = [...roomMessages]
      updated[idx] = message
      allMessages.set(roomId, updated)
    }
    set({ messages: allMessages })
  },

  setMessages: (roomId, messages) => {
    const allMessages = new Map(get().messages)
    allMessages.set(roomId, messages)
    set({ messages: allMessages })
  },

  prependMessages: (roomId, messages) => {
    const allMessages = new Map(get().messages)
    const existing = allMessages.get(roomId) || []
    const newIds = new Set(messages.map((m) => m.eventId))
    const filtered = existing.filter((m) => !newIds.has(m.eventId))
    allMessages.set(roomId, [...messages, ...filtered])
    set({ messages: allMessages })
  },

  setTyping: ({ roomId, userIds }) => {
    const typing = new Map(get().typing)
    typing.set(roomId, userIds)
    set({ typing })
  },

  bumpReceiptsVersion: () => set((state) => ({ receiptsVersion: state.receiptsVersion + 1 })),
  bumpReactionsVersion: () => set((state) => ({ reactionsVersion: state.reactionsVersion + 1 })),

  setLoadingHistory: (isLoadingHistory) => set({ isLoadingHistory }),

  getMessages: (roomId) => get().messages.get(roomId) || [],

  getTypingUsers: (roomId) => get().typing.get(roomId) || [],

  setPinnedEventIds: (roomId, ids) => {
    const pinnedEventIds = new Map(get().pinnedEventIds)
    pinnedEventIds.set(roomId, ids)
    set({ pinnedEventIds, pinnedVersion: get().pinnedVersion + 1 })
  },

  getPinnedEventIds: (roomId) => get().pinnedEventIds.get(roomId) || [],

  bumpPinnedVersion: () => set((state) => ({ pinnedVersion: state.pinnedVersion + 1 })),

  markRoomLoaded: (roomId) => {
    const loadedRooms = new Set(get().loadedRooms)
    loadedRooms.add(roomId)
    set({ loadedRooms })
  },

  isRoomLoaded: (roomId) => get().loadedRooms.has(roomId),

  getThreadMessages: (threadRootId) => get().threadMessages.get(threadRootId) || [],

  addThreadMessage: (threadRootId, message) => {
    const threadMessages = new Map(get().threadMessages)
    const existing = threadMessages.get(threadRootId) || []
    const alreadyExists = existing.some((m) => m.eventId === message.eventId)
    if (!alreadyExists) {
      threadMessages.set(threadRootId, [...existing, message])
      set({ threadMessages, threadsVersion: get().threadsVersion + 1 })
    }
  },

  setThreadMessages: (threadRootId, messages) => {
    const threadMessages = new Map(get().threadMessages)
    threadMessages.set(threadRootId, messages)
    set({ threadMessages, threadsVersion: get().threadsVersion + 1 })
  },

  updateThreadRootInfo: (roomId, threadRootId, info) => {
    const allMessages = new Map(get().messages)
    const roomMessages = allMessages.get(roomId)
    if (!roomMessages) return
    const idx = roomMessages.findIndex((m) => m.eventId === threadRootId)
    if (idx === -1) return
    const updated = [...roomMessages]
    updated[idx] = {
      ...updated[idx],
      threadInfo: {
        replyCount: info.replyCount,
        lastReplyTs: info.lastReplyTs,
        lastReplierAvatar: info.lastReplierAvatar,
        lastReplierName: info.lastReplierName,
      },
    }
    allMessages.set(roomId, updated)
    set({ messages: allMessages })
  },

  reset: () =>
    set({
      messages: new Map(),
      typing: new Map(),
      loadedRooms: new Set(),
      receiptsVersion: 0,
      reactionsVersion: 0,
      pinnedEventIds: new Map(),
      pinnedVersion: 0,
      threadMessages: new Map(),
      threadsVersion: 0,
    }),
}))
