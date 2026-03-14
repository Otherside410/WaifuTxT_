import { create } from 'zustand'

export type PresenceValue = 'online' | 'unavailable' | 'offline'

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
  ownPresence: PresenceValue

  toggleMemberPanel: () => void
  toggleSettingsModal: () => void
  setSettingsModal: (open: boolean) => void
  toggleMobileMenu: () => void
  setOwnPresence: (presence: PresenceValue) => void
}

export const useUiStore = create<UiState>((set) => ({
  showMemberPanel: true,
  showSettingsModal: false,
  isMobileMenuOpen: false,
  ownPresence: loadStoredPresence(),

  toggleMemberPanel: () => set((s) => ({ showMemberPanel: !s.showMemberPanel })),
  toggleSettingsModal: () => set((s) => ({ showSettingsModal: !s.showSettingsModal })),
  setSettingsModal: (open) => set({ showSettingsModal: open }),
  toggleMobileMenu: () => set((s) => ({ isMobileMenuOpen: !s.isMobileMenuOpen })),
  setOwnPresence: (presence) => {
    localStorage.setItem(PRESENCE_STORAGE_KEY, presence)
    set({ ownPresence: presence })
  },
}))
