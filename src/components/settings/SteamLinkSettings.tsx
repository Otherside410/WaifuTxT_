import { useEffect, useState } from 'react'
import { useAuthStore } from '../../stores/authStore'
import {
  getOwnSteamLink,
  startSteamLink,
  unlinkSteam,
  type SteamLinkInfo,
} from '../../lib/steamPresence'

type Flash = { kind: 'success' | 'error'; message: string } | null

function consumeCallbackFlash(): Flash {
  const params = new URLSearchParams(window.location.search)
  const status = params.get('steam')
  if (!status) return null

  params.delete('steam')
  params.delete('reason')
  const qs = params.toString()
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
  window.history.replaceState(null, '', url)

  if (status === 'linked') return { kind: 'success', message: 'Compte Steam lié.' }
  const reason = new URLSearchParams(window.location.search).get('reason') ?? ''
  return { kind: 'error', message: `Échec de la liaison Steam${reason ? ` (${reason})` : ''}.` }
}

export function SteamLinkSettings({ disabled }: { disabled?: boolean }) {
  const session = useAuthStore((s) => s.session)
  const [info, setInfo] = useState<SteamLinkInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [flash, setFlash] = useState<Flash>(() => consumeCallbackFlash())

  useEffect(() => {
    if (!session) {
      setLoading(false)
      return
    }
    let cancelled = false
    getOwnSteamLink(session.accessToken)
      .then((i) => {
        if (!cancelled) setInfo(i)
      })
      .catch(() => {
        if (!cancelled) setInfo({ linked: false, steamId: null, linkedAt: null })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [session])

  const handleLink = async () => {
    if (!session) return
    setWorking(true)
    setFlash(null)
    try {
      const url = await startSteamLink(session.accessToken)
      window.location.href = url
    } catch (err) {
      setFlash({ kind: 'error', message: err instanceof Error ? err.message : 'Erreur' })
      setWorking(false)
    }
  }

  const handleUnlink = async () => {
    if (!session) return
    setWorking(true)
    setFlash(null)
    try {
      await unlinkSteam(session.accessToken)
      setInfo({ linked: false, steamId: null, linkedAt: null })
      setFlash({ kind: 'success', message: 'Compte Steam délié.' })
    } catch (err) {
      setFlash({ kind: 'error', message: err instanceof Error ? err.message : 'Erreur' })
    } finally {
      setWorking(false)
    }
  }

  const isDisabled = disabled || !session || loading || working

  return (
    <div className="rounded-lg border border-border/80 bg-bg-secondary/40 p-3 space-y-2">
      <p className="text-sm font-medium text-text-primary">Steam</p>
      <p className="text-xs text-text-muted leading-relaxed">
        Liez votre compte Steam pour afficher le jeu en cours dans votre profil. La liaison utilise
        OpenID Steam et ne transmet pas votre mot de passe à WaifuTxT.
      </p>

      {info?.linked ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-text-secondary font-mono truncate">
            SteamID : {info.steamId}
          </span>
          <button
            type="button"
            disabled={isDisabled}
            onClick={() => void handleUnlink()}
            className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {working ? '…' : 'Délier'}
          </button>
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={isDisabled}
            onClick={() => void handleLink()}
            className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium bg-accent-pink text-white hover:bg-accent-pink-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Chargement…' : working ? 'Redirection…' : 'Lier un compte Steam'}
          </button>
        </div>
      )}

      {flash && (
        <p className={`text-xs ${flash.kind === 'success' ? 'text-success' : 'text-danger'}`}>
          {flash.message}
        </p>
      )}
    </div>
  )
}
