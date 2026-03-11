import { useEffect, useState, Component, type ReactNode } from 'react'
import { useAuthStore } from './stores/authStore'
import { initClient } from './lib/matrix'
import { LoginScreen } from './components/auth/LoginScreen'
import { AppShell } from './components/layout/AppShell'
import { useNotifications } from './hooks/useNotifications'

class ErrorBoundary extends Component<{ children: ReactNode; onReset: () => void }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[WaifuTxT] React crash:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen w-screen flex items-center justify-center bg-bg-primary">
          <div className="text-center max-w-md px-6">
            <h2 className="text-2xl font-bold text-accent-pink mb-2">ワイフ</h2>
            <p className="text-text-primary font-semibold mb-4">Une erreur est survenue</p>
            <pre className="text-xs text-danger bg-bg-tertiary rounded-md p-3 mb-4 text-left overflow-auto max-h-40">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => {
                this.setState({ error: null })
                this.props.onReset()
              }}
              className="px-4 py-2 bg-accent-pink text-white rounded-md hover:bg-accent-pink-hover transition-colors cursor-pointer"
            >
              Réessayer
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export function App() {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const [isRestoring, setIsRestoring] = useState(true)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  useNotifications()

  useEffect(() => {
    const restore = async () => {
      const session = useAuthStore.getState().restoreSession()
      if (session) {
        try {
          await initClient(session)
          useAuthStore.getState().setLoggedIn(true)
        } catch (err) {
          console.error('[WaifuTxT] Session restore failed:', err)
          const msg = err instanceof Error ? err.message : 'Erreur inconnue'
          setRestoreError(msg)
          useAuthStore.getState().logout()
        }
      }
      setIsRestoring(false)
    }
    restore()
  }, [])

  const handleReset = () => {
    useAuthStore.getState().logout()
    setRestoreError(null)
    setIsRestoring(false)
  }

  if (isRestoring) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-bg-primary">
        <div className="text-center">
          <div className="mb-4">
            <svg className="animate-spin h-8 w-8 text-accent-pink mx-auto" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-accent-pink">ワイフ</h2>
          <p className="text-text-muted text-sm mt-1">Connexion en cours...</p>
        </div>
      </div>
    )
  }

  if (restoreError) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-bg-primary">
        <div className="text-center max-w-md px-6">
          <h2 className="text-2xl font-bold text-accent-pink mb-2">ワイフ</h2>
          <p className="text-text-primary font-semibold mb-4">Session expirée</p>
          <pre className="text-xs text-danger bg-bg-tertiary rounded-md p-3 mb-4 text-left overflow-auto max-h-40">
            {restoreError}
          </pre>
          <button
            onClick={handleReset}
            className="px-4 py-2 bg-accent-pink text-white rounded-md hover:bg-accent-pink-hover transition-colors cursor-pointer"
          >
            Se reconnecter
          </button>
        </div>
      </div>
    )
  }

  return (
    <ErrorBoundary onReset={handleReset}>
      {isLoggedIn ? <AppShell /> : <LoginScreen />}
    </ErrorBoundary>
  )
}
