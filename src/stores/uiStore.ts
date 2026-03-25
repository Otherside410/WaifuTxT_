import { create } from 'zustand'

export type PresenceValue = 'online' | 'unavailable' | 'offline'
export type WaifuId = 'miku' | 'airi'
export type TypingIndicatorStyle = 'dots' | 'waifu'
export interface PendingReply {
  roomId: string
  eventId: string
  senderName: string
  preview: string
}

const PRESENCE_STORAGE_KEY = 'waifutxt_presence'

function loadStoredPresence(): PresenceValue {
  const stored = localStorage.getItem(PRESENCE_STORAGE_KEY)
  if (stored === 'online' || stored === 'unavailable' || stored === 'offline') return stored
  return 'online'
}

interface UiState {
  showMemberPanel: boolean
  showSettingsModal: boolean
  isMobileMenuOpen: boolean
  showRoomMessagePreview: boolean
  showUnreadDot: boolean
  showMentionBadge: boolean
  pendingMention: string | null
  pendingReply: PendingReply | null
  waifuOptIn: boolean
  selectedWaifuId: WaifuId
  typingIndicatorStyle: TypingIndicatorStyle

  toggleMemberPanel: () => void
  toggleSettingsModal: () => void
  setSettingsModal: (open: boolean) => void
  toggleMobileMenu: () => void
  toggleRoomMessagePreview: () => void
  setRoomMessagePreview: (show: boolean) => void
  setShowUnreadDot: (show: boolean) => void
  setShowMentionBadge: (show: boolean) => void
  setPendingMention: (mention: string | null) => void
  setPendingReply: (reply: PendingReply | null) => void
  setWaifuOptIn: (enabled: boolean) => void
  setSelectedWaifuId: (waifuId: WaifuId) => void
  setTypingIndicatorStyle: (style: TypingIndicatorStyle) => void
  editTargetEventId: string | null
  setEditTargetEventId: (id: string | null) => void
  roomSearchFocusBump: number
  bumpRoomSearchFocus: () => void
  chatInputFocusBump: number
  bumpChatInputFocus: () => void
}

const ROOM_PREVIEW_STORAGE_KEY = 'waifutxt_show_room_message_preview'
const UNREAD_DOT_STORAGE_KEY = 'waifutxt_show_unread_dot'
const MENTION_BADGE_STORAGE_KEY = 'waifutxt_show_mention_badge'
const WAIFU_OPT_IN_STORAGE_KEY = 'waifutxt_waifu_opt_in'
const WAIFU_SELECTED_STORAGE_KEY = 'waifutxt_waifu_selected'
const TYPING_INDICATOR_STYLE_STORAGE_KEY = 'waifutxt_typing_indicator_style'

function readRoomPreviewPreference(): boolean {
  if (typeof window === 'undefined') return true
  const saved = window.localStorage.getItem(ROOM_PREVIEW_STORAGE_KEY)
  if (saved == null) return true
  return saved === 'true'
}

function persistRoomPreviewPreference(show: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ROOM_PREVIEW_STORAGE_KEY, String(show))
}

function readUnreadDot(): boolean {
  if (typeof window === 'undefined') return true
  const saved = window.localStorage.getItem(UNREAD_DOT_STORAGE_KEY)
  if (saved == null) return true
  return saved === 'true'
}

function persistUnreadDot(show: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(UNREAD_DOT_STORAGE_KEY, String(show))
}

function readMentionBadge(): boolean {
  if (typeof window === 'undefined') return true
  const saved = window.localStorage.getItem(MENTION_BADGE_STORAGE_KEY)
  if (saved == null) return true
  return saved === 'true'
}

function persistMentionBadge(show: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(MENTION_BADGE_STORAGE_KEY, String(show))
}

function readWaifuOptIn(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(WAIFU_OPT_IN_STORAGE_KEY) === 'true'
}

function persistWaifuOptIn(enabled: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(WAIFU_OPT_IN_STORAGE_KEY, String(enabled))
}

function readSelectedWaifuId(): WaifuId {
  if (typeof window === 'undefined') return 'miku'
  const saved = window.localStorage.getItem(WAIFU_SELECTED_STORAGE_KEY)
  if (saved === 'miku' || saved === 'airi') return saved
  return 'miku'
}

function persistSelectedWaifuId(waifuId: WaifuId): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(WAIFU_SELECTED_STORAGE_KEY, waifuId)
}

function readTypingIndicatorStyle(): TypingIndicatorStyle {
  if (typeof window === 'undefined') return 'dots'
  const saved = window.localStorage.getItem(TYPING_INDICATOR_STYLE_STORAGE_KEY)
  if (saved === 'waifu' || saved === 'dots') return saved
  return 'dots'
}

function persistTypingIndicatorStyle(style: TypingIndicatorStyle): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(TYPING_INDICATOR_STYLE_STORAGE_KEY, style)
}

export const useUiStore = create<UiState>((set) => ({
  showMemberPanel: true,
  showSettingsModal: false,
  isMobileMenuOpen: false,
  showRoomMessagePreview: readRoomPreviewPreference(),
  showUnreadDot: readUnreadDot(),
  showMentionBadge: readMentionBadge(),
  pendingMention: null,
  pendingReply: null,
  waifuOptIn: readWaifuOptIn(),
  selectedWaifuId: readSelectedWaifuId(),
  typingIndicatorStyle: readTypingIndicatorStyle(),

  toggleMemberPanel: () => set((s) => ({ showMemberPanel: !s.showMemberPanel })),
  toggleSettingsModal: () => set((s) => ({ showSettingsModal: !s.showSettingsModal })),
  setSettingsModal: (open) => set({ showSettingsModal: open }),
  toggleMobileMenu: () => set((s) => ({ isMobileMenuOpen: !s.isMobileMenuOpen })),
  toggleRoomMessagePreview: () =>
    set((s) => {
      const next = !s.showRoomMessagePreview
      persistRoomPreviewPreference(next)
      return { showRoomMessagePreview: next }
    }),
  setRoomMessagePreview: (show) => {
    persistRoomPreviewPreference(show)
    set({ showRoomMessagePreview: show })
  },
  setShowUnreadDot: (show) => {
    persistUnreadDot(show)
    set({ showUnreadDot: show })
  },
  setShowMentionBadge: (show) => {
    persistMentionBadge(show)
    set({ showMentionBadge: show })
  },
  setPendingMention: (mention) => set({ pendingMention: mention }),
  setPendingReply: (reply) => set({ pendingReply: reply }),
  setWaifuOptIn: (enabled) => {
    persistWaifuOptIn(enabled)
    set({ waifuOptIn: enabled })
  },
  setSelectedWaifuId: (waifuId) => {
    persistSelectedWaifuId(waifuId)
    set({ selectedWaifuId: waifuId })
  },
  setTypingIndicatorStyle: (style) => {
    persistTypingIndicatorStyle(style)
    set({ typingIndicatorStyle: style })
  },
  editTargetEventId: null,
  setEditTargetEventId: (id) => set({ editTargetEventId: id }),
  roomSearchFocusBump: 0,
  bumpRoomSearchFocus: () => set((s) => ({ roomSearchFocusBump: s.roomSearchFocusBump + 1 })),
  chatInputFocusBump: 0,
  bumpChatInputFocus: () => set((s) => ({ chatInputFocusBump: s.chatInputFocusBump + 1 })),
}))
