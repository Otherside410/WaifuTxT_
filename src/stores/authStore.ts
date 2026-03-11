import { create } from 'zustand'
import type { MatrixSession } from '../types/matrix'

interface AuthState {
  session: MatrixSession | null
  isLoggedIn: boolean
  isLoading: boolean
  error: string | null

  setSession: (session: MatrixSession) => void
  setLoggedIn: (loggedIn: boolean) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  logout: () => void
  restoreSession: () => MatrixSession | null
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  isLoggedIn: false,
  isLoading: false,
  error: null,

  setSession: (session) => {
    localStorage.setItem('waifutxt_session', JSON.stringify(session))
    set({ session, isLoggedIn: true, isLoading: false, error: null })
  },

  setLoggedIn: (isLoggedIn) => set({ isLoggedIn }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error, isLoading: false }),

  logout: () => {
    localStorage.removeItem('waifutxt_session')
    set({ session: null, isLoggedIn: false, isLoading: false, error: null })
  },

  restoreSession: () => {
    const stored = localStorage.getItem('waifutxt_session')
    if (stored) {
      try {
        const session = JSON.parse(stored) as MatrixSession
        set({ session })
        return session
      } catch {
        localStorage.removeItem('waifutxt_session')
      }
    }
    return null
  },
}))
