import { create } from 'zustand'
import type { MessageEvent, TypingState } from '../types/matrix'

interface MessageState {
  messages: Map<string, MessageEvent[]>
  typing: Map<string, string[]>
  isLoadingHistory: boolean
  receiptsVersion: number

  addMessage: (roomId: string, message: MessageEvent) => void
  replaceMessage: (roomId: string, eventId: string, message: MessageEvent) => void
  setMessages: (roomId: string, messages: MessageEvent[]) => void
  prependMessages: (roomId: string, messages: MessageEvent[]) => void
  setTyping: (typing: TypingState) => void
  bumpReceiptsVersion: () => void
  setLoadingHistory: (loading: boolean) => void
  getMessages: (roomId: string) => MessageEvent[]
  getTypingUsers: (roomId: string) => string[]
  reset: () => void
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: new Map(),
  typing: new Map(),
  isLoadingHistory: false,
  receiptsVersion: 0,

  addMessage: (roomId, message) => {
    const allMessages = new Map(get().messages)
    const roomMessages = allMessages.get(roomId) || []
    const exists = roomMessages.some((m) => m.eventId === message.eventId)
    if (!exists) {
      allMessages.set(roomId, [...roomMessages, message])
      set({ messages: allMessages })
    }
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

  setLoadingHistory: (isLoadingHistory) => set({ isLoadingHistory }),

  getMessages: (roomId) => get().messages.get(roomId) || [],

  getTypingUsers: (roomId) => get().typing.get(roomId) || [],

  reset: () => set({ messages: new Map(), typing: new Map(), receiptsVersion: 0 }),
}))
