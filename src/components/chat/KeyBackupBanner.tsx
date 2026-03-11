import { useState } from 'react'
import { restoreKeyBackup } from '../../lib/matrix'

export function KeyBackupBanner() {
  const [showInput, setShowInput] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem('waifutxt_backup_dismissed') === '1',
  )

  const handleDismiss = () => {
    setDismissed(true)
    sessionStorage.setItem('waifutxt_backup_dismissed', '1')
  }

  if (dismissed || status === 'success') return null

  const handleRestore = async () => {
    if (!recoveryKey.trim()) return
    setStatus('loading')
    setMessage('')
    try {
      const result = await restoreKeyBackup(recoveryKey)
      setStatus('success')
      setMessage(`${result.imported} / ${result.total} clés restaurées !`)
      setTimeout(() => handleDismiss(), 4000)
    } catch (err) {
      setStatus('error')
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[WaifuTxT] Key backup restore error:', err)
      setMessage(msg)
    }
  }

  return (
    <div className="mx-4 mt-2 bg-accent-pink/10 border border-accent-pink/30 rounded-lg p-3 shrink-0">
      <div className="flex items-start gap-3">
        <svg className="w-5 h-5 text-accent-pink mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text-primary font-medium">
            Déchiffrer les anciens messages
          </p>
          <p className="text-xs text-text-secondary mt-0.5">
            Entrez votre clé de récupération pour lire l'historique des salons chiffrés.
          </p>

          {showInput ? (
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                placeholder="EsTc aAEH i4aD rWPx..."
                className="flex-1 !text-xs !py-1.5 !px-2 font-mono"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleRestore()}
              />
              <button
                onClick={handleRestore}
                disabled={status === 'loading' || !recoveryKey.trim()}
                className="px-3 py-1.5 bg-accent-pink text-white text-xs rounded-md hover:bg-accent-pink-hover disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0"
              >
                {status === 'loading' ? '...' : 'Restaurer'}
              </button>
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => setShowInput(true)}
                className="px-3 py-1 bg-accent-pink text-white text-xs rounded-md hover:bg-accent-pink-hover transition-colors cursor-pointer"
              >
                Entrer la clé de récupération
              </button>
              <button
                onClick={handleDismiss}
                className="px-3 py-1 text-text-muted text-xs hover:text-text-secondary transition-colors cursor-pointer"
              >
                Plus tard
              </button>
            </div>
          )}

          {message && (
            <p className={`text-xs mt-1.5 ${status === 'error' ? 'text-danger' : 'text-success'}`}>
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
