import { useEffect } from 'react'
import { useVerificationStore } from '../../stores/verificationStore'
import {
  acceptAndStartSas,
  declineIncoming,
  cancelVerification,
  startEmojiVerification,
} from '../../lib/verification'

// ---------------------------------------------------------------------------
// Phase: Incoming request
// ---------------------------------------------------------------------------

function PhaseIncoming({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="w-14 h-14 rounded-full bg-accent-pink/15 flex items-center justify-center">
        <svg className="w-7 h-7 text-accent-pink" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.955 11.955 0 003 10c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.572-.598-3.75h-.152c-3.196 0-6.1-1.249-8.25-3.286z" />
        </svg>
      </div>

      <div>
        <h3 className="text-lg font-semibold text-text-primary">Demande de vérification</h3>
        <p className="text-sm text-text-secondary mt-1">
          <span className="text-text-primary font-medium">{name}</span> souhaite vérifier
          votre identité.
        </p>
      </div>

      <p className="text-xs text-text-muted max-w-xs">
        Vérifiez uniquement si vous avez initié cette demande depuis un autre appareil ou client.
      </p>

      <div className="flex gap-3 w-full">
        <button
          onClick={declineIncoming}
          className="flex-1 py-2 rounded-md text-sm font-medium border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
        >
          Ignorer
        </button>
        <button
          onClick={acceptAndStartSas}
          className="flex-1 py-2 rounded-md text-sm font-medium bg-accent-pink text-white hover:bg-accent-pink-hover transition-colors cursor-pointer"
        >
          Vérifier
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phase: Waiting for other device (outgoing, ready state)
// ---------------------------------------------------------------------------

function PhaseReady() {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="w-14 h-14 rounded-full bg-bg-tertiary flex items-center justify-center">
        <svg className="animate-spin w-7 h-7 text-accent-pink" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>

      <div>
        <h3 className="text-lg font-semibold text-text-primary">En attente de votre autre appareil</h3>
        <p className="text-sm text-text-secondary mt-1">
          Une demande a été envoyée à vos autres sessions (téléphone, navigateur, Element…).
          Acceptez-la là-bas pour continuer.
        </p>
      </div>

      <div className="w-full border border-border rounded-lg p-4 bg-bg-primary/40 text-left space-y-2">
        <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">Sur votre autre appareil</p>
        <ol className="text-sm text-text-secondary space-y-1 list-decimal list-inside">
          <li>Ouvrez Element, Cinny ou votre autre client Matrix</li>
          <li>Acceptez la demande de vérification</li>
          <li>Comparez les emojis affichés des deux côtés</li>
        </ol>
      </div>

      <div className="flex flex-col gap-2 w-full">
        <button
          onClick={startEmojiVerification}
          className="w-full py-2 rounded-md text-sm font-medium bg-accent-pink text-white hover:bg-accent-pink-hover transition-colors cursor-pointer"
        >
          Lancer la comparaison d'emojis
        </button>
        <button
          onClick={cancelVerification}
          className="w-full py-2 rounded-md text-sm font-medium border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
        >
          Annuler
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phase: SAS emoji comparison
// ---------------------------------------------------------------------------

function PhaseSas({
  emojis,
  callbacks,
}: {
  emojis: { emoji: string; name: string }[]
  callbacks: { confirm: () => Promise<void>; mismatch: () => Promise<void> }
}) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div>
        <h3 className="text-lg font-semibold text-text-primary">Comparez les emojis</h3>
        <p className="text-sm text-text-secondary mt-1">
          Vérifiez que les 7 emojis sont <span className="text-text-primary font-medium">identiques</span> sur
          les deux appareils, dans le même ordre.
        </p>
      </div>

      <div className="grid grid-cols-4 gap-3 w-full">
        {emojis.map(({ emoji, name }, i) => (
          <div
            key={i}
            className="flex flex-col items-center gap-1 p-2 rounded-lg bg-bg-primary/60 border border-border"
          >
            <span className="text-3xl leading-none">{emoji}</span>
            <span className="text-[10px] text-text-muted truncate w-full text-center">{name}</span>
          </div>
        ))}
      </div>

      <div className="flex gap-3 w-full">
        <button
          onClick={() => callbacks.mismatch()}
          className="flex-1 py-2 rounded-md text-sm font-medium border border-danger/50 text-danger hover:bg-danger/10 transition-colors cursor-pointer"
        >
          Différents
        </button>
        <button
          onClick={() => callbacks.confirm()}
          className="flex-1 py-2 rounded-md text-sm font-medium bg-success/20 text-success border border-success/40 hover:bg-success/30 transition-colors cursor-pointer"
        >
          Identiques ✓
        </button>
      </div>

      <button
        onClick={cancelVerification}
        className="text-xs text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
      >
        Annuler la vérification
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phase: Done
// ---------------------------------------------------------------------------

function PhaseDone() {
  const reset = useVerificationStore((s) => s.reset)

  useEffect(() => {
    const t = setTimeout(reset, 3000)
    return () => clearTimeout(t)
  }, [reset])

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="w-16 h-16 rounded-full bg-success/15 flex items-center justify-center">
        <svg className="w-8 h-8 text-success" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.955 11.955 0 003 10c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.572-.598-3.75h-.152c-3.196 0-6.1-1.249-8.25-3.286z" />
        </svg>
      </div>
      <div>
        <h3 className="text-lg font-semibold text-success">Appareil vérifié !</h3>
        <p className="text-sm text-text-secondary mt-1">
          Votre identité a été vérifiée avec succès. Les messages chiffrés de cette session
          sont désormais marqués comme fiables.
        </p>
      </div>
      <button
        onClick={reset}
        className="w-full py-2 rounded-md text-sm font-medium bg-accent-pink text-white hover:bg-accent-pink-hover transition-colors cursor-pointer"
      >
        Fermer
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phase: Cancelled / error
// ---------------------------------------------------------------------------

function PhaseCancelled({ error }: { error: string | null }) {
  const reset = useVerificationStore((s) => s.reset)
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="w-14 h-14 rounded-full bg-danger/15 flex items-center justify-center">
        <svg className="w-7 h-7 text-danger" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
      </div>
      <div>
        <h3 className="text-lg font-semibold text-danger">Vérification annulée</h3>
        {error && (
          <p className="text-xs text-text-muted mt-2 bg-bg-primary/60 rounded-md px-3 py-2 max-w-xs">
            {error}
          </p>
        )}
      </div>
      <button
        onClick={reset}
        className="w-full py-2 rounded-md text-sm font-medium border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
      >
        Fermer
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root modal
// ---------------------------------------------------------------------------

export function VerificationModal() {
  const phase = useVerificationStore((s) => s.phase)
  const requesterName = useVerificationStore((s) => s.requesterName)
  const sasEmojis = useVerificationStore((s) => s.sasEmojis)
  const sasCallbacks = useVerificationStore((s) => s.sasCallbacks)
  const error = useVerificationStore((s) => s.error)

  if (phase === 'idle') return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <button
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
        aria-label="Fermer"
        onClick={phase === 'incoming' ? declineIncoming : cancelVerification}
      />

      <div className="relative w-[420px] max-w-[92vw] rounded-xl border border-border bg-bg-secondary shadow-2xl p-6">
        {phase === 'incoming' && requesterName && (
          <PhaseIncoming name={requesterName} />
        )}
        {phase === 'ready' && <PhaseReady />}
        {phase === 'sas' && sasEmojis && sasCallbacks && (
          <PhaseSas emojis={sasEmojis} callbacks={sasCallbacks} />
        )}
        {phase === 'done' && <PhaseDone />}
        {phase === 'cancelled' && <PhaseCancelled error={error} />}
      </div>
    </div>
  )
}
