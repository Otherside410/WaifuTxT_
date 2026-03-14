import { useEffect, useState } from 'react'
import { restoreKeyBackup, shouldShowKeyBackupBanner } from '../../lib/matrix'
import { startSelfVerification } from '../../lib/verification'
import { useVerificationStore } from '../../stores/verificationStore'

type Mode = 'choice' | 'key-input'

export function KeyBackupBanner() {
  const [mode, setMode] = useState<Mode>('choice')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [keyMessage, setKeyMessage] = useState('')
  const [isRelevant, setIsRelevant] = useState<boolean | null>(null)
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem('waifutxt_backup_dismissed') === '1',
  )

  const verificationPhase = useVerificationStore((s) => s.phase)

  const checkRelevance = () => {
    shouldShowKeyBackupBanner()
      .then(setIsRelevant)
      .catch(() => setIsRelevant(true))
  }

  useEffect(() => {
    checkRelevance()
  }, [])

  // Re-check banner necessity after a successful device verification.
  useEffect(() => {
    if (verificationPhase === 'done') {
      checkRelevance()
    }
  }, [verificationPhase])

  const handleDismiss = () => {
    setDismissed(true)
    sessionStorage.setItem('waifutxt_backup_dismissed', '1')
  }

  const handleRestoreKey = async () => {
    if (!recoveryKey.trim()) return
    setKeyStatus('loading')
    setKeyMessage('')
    try {
      const result = await restoreKeyBackup(recoveryKey)
      setKeyStatus('success')
      setKeyMessage(`${result.imported} / ${result.total} clés restaurées !`)
      setTimeout(() => handleDismiss(), 3000)
    } catch (err) {
      setKeyStatus('error')
      setKeyMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const handleVerify = async () => {
    await startSelfVerification()
    // VerificationModal takes over from here; banner stays visible
    // and will auto-hide when verificationPhase === 'done' re-checks the banner.
  }

  if (isRelevant === null) return null
  if (!isRelevant || dismissed || keyStatus === 'success') return null

  const isVerifying =
    verificationPhase === 'ready' || verificationPhase === 'sas' || verificationPhase === 'incoming'

  return (
    <div className="mx-4 mt-2 shrink-0">
      <div className="bg-accent-pink/10 border border-accent-pink/30 rounded-lg p-3">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <svg
            className="w-5 h-5 text-accent-pink mt-0.5 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
            />
          </svg>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary">Déchiffrer les anciens messages</p>
            <p className="text-xs text-text-secondary mt-0.5">
              {mode === 'key-input'
                ? 'Collez votre clé de récupération (format EsTc aAEH…).'
                : "Prouvez votre identité pour accéder à l'historique des salons chiffrés."}
            </p>

            {/* ── Choice mode: two options ── */}
            {mode === 'choice' && !isVerifying && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button
                  onClick={() => setMode('key-input')}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-accent-pink text-white text-xs rounded-md hover:bg-accent-pink-hover transition-colors cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                  </svg>
                  Clé de récupération
                </button>

                <button
                  onClick={handleVerify}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-accent-pink/50 text-accent-pink text-xs rounded-md hover:bg-accent-pink/10 transition-colors cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 8.25h3m-3 3.75h3M6.75 20.25v.75" />
                  </svg>
                  Vérifier avec un autre appareil
                </button>

                <button
                  onClick={handleDismiss}
                  className="px-3 py-1.5 text-text-muted text-xs hover:text-text-secondary transition-colors cursor-pointer"
                >
                  Plus tard
                </button>
              </div>
            )}

            {/* ── Verification in progress indicator ── */}
            {mode === 'choice' && isVerifying && (
              <div className="mt-2.5 flex items-center gap-2">
                <svg className="animate-spin w-4 h-4 text-accent-pink shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-xs text-text-secondary">
                  Vérification en cours — suivez les instructions dans la fenêtre ouverte.
                </span>
              </div>
            )}

            {/* ── Recovery key input mode ── */}
            {mode === 'key-input' && (
              <>
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    value={recoveryKey}
                    onChange={(e) => setRecoveryKey(e.target.value)}
                    placeholder="EsTc aAEH i4aD rWPx…"
                    className="flex-1 !text-xs !py-1.5 !px-2 font-mono"
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && handleRestoreKey()}
                  />
                  <button
                    onClick={handleRestoreKey}
                    disabled={keyStatus === 'loading' || !recoveryKey.trim()}
                    className="px-3 py-1.5 bg-accent-pink text-white text-xs rounded-md hover:bg-accent-pink-hover disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0"
                  >
                    {keyStatus === 'loading' ? '…' : 'Restaurer'}
                  </button>
                  <button
                    onClick={() => { setMode('choice'); setKeyMessage(''); setKeyStatus('idle') }}
                    className="px-2 py-1.5 text-text-muted text-xs hover:text-text-secondary transition-colors cursor-pointer shrink-0"
                    title="Retour"
                  >
                    ✕
                  </button>
                </div>
                {keyMessage && (
                  <p className={`text-xs mt-1.5 ${keyStatus === 'error' ? 'text-danger' : 'text-success'}`}>
                    {keyMessage}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Dismiss ✕ (only in choice mode) */}
          {mode === 'choice' && !isVerifying && (
            <button
              onClick={handleDismiss}
              className="p-1 rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer shrink-0"
              aria-label="Ignorer"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
