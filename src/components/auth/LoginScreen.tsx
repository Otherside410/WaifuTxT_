import { useState, type FormEvent } from 'react'
import { Button } from '../common/Button'
import { Input } from '../common/Input'
import { useAuthStore } from '../../stores/authStore'
import { login, initClient } from '../../lib/matrix'

export function LoginScreen() {
  const [homeserver, setHomeserver] = useState('https://matrix.org')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const { isLoading, error, setLoading, setError } = useAuthStore()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password.trim()) {
      setError('Veuillez remplir tous les champs')
      return
    }

    setLoading(true)
    setError(null)

    try {
      console.log('[WaifuTxT] Logging in...')
      const session = await login(homeserver, username, password)
      console.log('[WaifuTxT] Login successful, initializing client...')

      await initClient(session)
      console.log('[WaifuTxT] Client initialized, setting session...')

      if (remember) {
        useAuthStore.getState().setSession(session)
      } else {
        useAuthStore.setState({ session, isLoggedIn: true, isLoading: false })
      }
      console.log('[WaifuTxT] Ready!')
    } catch (err) {
      console.error('[WaifuTxT] Login error:', err)
      const message = err instanceof Error ? err.message : 'Erreur de connexion'
      if (message.includes('403') || message.includes('Invalid') || message.includes('Forbidden')) {
        setError('Nom d\'utilisateur ou mot de passe incorrect')
      } else if (message.includes('fetch') || message.includes('network') || message.includes('Failed')) {
        setError('Impossible de contacter le serveur')
      } else {
        setError(message)
      }
    }
  }

  return (
    <div className="h-screen w-screen flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 bg-bg-primary">
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-accent-pink/5 rounded-full blur-[120px] -translate-y-1/2 translate-x-1/3" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-purple-600/5 rounded-full blur-[120px] translate-y-1/3 -translate-x-1/4" />
        <div className="absolute top-1/2 left-1/2 w-[300px] h-[300px] bg-blue-600/3 rounded-full blur-[80px] -translate-x-1/2 -translate-y-1/2" />
      </div>

      <div className="relative z-10 w-full max-w-md px-6">
        <div className="mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-accent-pink to-accent-pink-hover bg-clip-text text-transparent mb-1">
            ワイフ
          </h1>
          <h2 className="text-2xl font-bold text-text-primary">WaifuTxT</h2>
          <p className="text-sm text-text-muted mt-0.5">Matrix Client</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Homeserver"
            value={homeserver}
            onChange={(e) => setHomeserver(e.target.value)}
            placeholder="https://matrix.org"
          />
          <Input
            label="Nom d'utilisateur"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="votre_username"
            autoComplete="username"
          />
          <Input
            label="Mot de passe"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
          />

          <div className="pt-2">
            <Button type="submit" size="lg" isLoading={isLoading} className="w-full">
              Se connecter
            </Button>
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-4 h-4 rounded border-border bg-bg-tertiary accent-accent-pink cursor-pointer"
            />
            <span className="text-sm text-text-secondary">Se souvenir de moi</span>
          </label>

          {error && (
            <div className="bg-danger/10 border border-danger/30 rounded-md px-4 py-2.5 text-sm text-danger">
              {error}
            </div>
          )}
        </form>

        <div className="mt-8 border-t border-border pt-4 flex items-center justify-between">
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Statut système</span>
            <p className="text-xs text-text-secondary">Tous les systèmes sont opérationnels</p>
          </div>
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Conseil du jour</span>
            <p className="text-xs text-text-secondary italic">Utilisez le chiffrement de bout en bout.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
