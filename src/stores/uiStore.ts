import { create } from 'zustand'

interface UiState {
  showMemberPanel: boolean
  showSettingsModal: boolean
  isMobileMenuOpen: boolean
  showRoomMessagePreview: boolean

  toggleMemberPanel: () => void
  toggleSettingsModal: () => void
  setSettingsModal: (open: boolean) => void
  toggleMobileMenu: () => void
  toggleRoomMessagePreview: () => void
  setRoomMessagePreview: (show: boolean) => void
}

const ROOM_PREVIEW_STORAGE_KEY = 'waifutxt_show_room_message_preview'

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

export const useUiStore = create<UiState>((set) => ({
  showMemberPanel: true,
  showSettingsModal: false,
  isMobileMenuOpen: false,
  showRoomMessagePreview: readRoomPreviewPreference(),

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
}))
