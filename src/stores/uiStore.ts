import { create } from 'zustand'

interface UiState {
  showMemberPanel: boolean
  showSettingsModal: boolean
  isMobileMenuOpen: boolean
  pendingMention: string | null

  toggleMemberPanel: () => void
  toggleSettingsModal: () => void
  setSettingsModal: (open: boolean) => void
  toggleMobileMenu: () => void
  setPendingMention: (mention: string | null) => void
}

export const useUiStore = create<UiState>((set) => ({
  showMemberPanel: true,
  showSettingsModal: false,
  isMobileMenuOpen: false,
  pendingMention: null,

  toggleMemberPanel: () => set((s) => ({ showMemberPanel: !s.showMemberPanel })),
  toggleSettingsModal: () => set((s) => ({ showSettingsModal: !s.showSettingsModal })),
  setSettingsModal: (open) => set({ showSettingsModal: open }),
  toggleMobileMenu: () => set((s) => ({ isMobileMenuOpen: !s.isMobileMenuOpen })),
  setPendingMention: (mention) => set({ pendingMention: mention }),
}))
