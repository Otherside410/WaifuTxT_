import { create } from 'zustand'

interface UiState {
  showMemberPanel: boolean
  showSettingsModal: boolean
  isMobileMenuOpen: boolean

  toggleMemberPanel: () => void
  toggleSettingsModal: () => void
  toggleMobileMenu: () => void
}

export const useUiStore = create<UiState>((set) => ({
  showMemberPanel: true,
  showSettingsModal: false,
  isMobileMenuOpen: false,

  toggleMemberPanel: () => set((s) => ({ showMemberPanel: !s.showMemberPanel })),
  toggleSettingsModal: () => set((s) => ({ showSettingsModal: !s.showSettingsModal })),
  toggleMobileMenu: () => set((s) => ({ isMobileMenuOpen: !s.isMobileMenuOpen })),
}))
