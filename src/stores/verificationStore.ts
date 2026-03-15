import { create } from 'zustand'

export type VerificationPhaseUI = 'idle' | 'incoming' | 'ready' | 'sas' | 'done' | 'cancelled'

export interface SasEmoji {
  emoji: string
  name: string
}

interface VerificationState {
  phase: VerificationPhaseUI
  requesterName: string | null
  initiatedByMe: boolean
  sasEmojis: SasEmoji[] | null
  sasCallbacks: { confirm: () => Promise<void>; mismatch: () => Promise<void> } | null
  error: string | null

  setIncoming: (name: string) => void
  setOutgoing: () => void
  setPhase: (phase: VerificationPhaseUI) => void
  setSas: (
    emojis: SasEmoji[],
    callbacks: { confirm: () => Promise<void>; mismatch: () => Promise<void> },
  ) => void
  setError: (error: string) => void
  reset: () => void
}

const initialState = {
  phase: 'idle' as VerificationPhaseUI,
  requesterName: null,
  initiatedByMe: false,
  sasEmojis: null,
  sasCallbacks: null,
  error: null,
}

export const useVerificationStore = create<VerificationState>((set) => ({
  ...initialState,

  setIncoming: (name) => set({ phase: 'incoming', requesterName: name, initiatedByMe: false }),
  setOutgoing: () => set({ phase: 'ready', initiatedByMe: true }),
  setPhase: (phase) => set({ phase }),
  setSas: (emojis, callbacks) => set({ sasEmojis: emojis, sasCallbacks: callbacks, phase: 'sas' }),
  setError: (error) => set({ error, phase: 'cancelled' }),
  reset: () => set(initialState),
}))
