import { useState } from 'react'
import { getStoredOwnStatusMessage, MAX_PRESENCE_STATUS_MSG_LEN, setOwnStatusMessage } from '../../lib/matrix'

type ProfileStatusSettingsProps = {
  disabled?: boolean
}

export function ProfileStatusSettings({ disabled }: ProfileStatusSettingsProps) {
  const [value, setValue] = useState(() => getStoredOwnStatusMessage())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  const handleSave = async () => {
    setError(null)
    setSaving(true)
    try {
      await setOwnStatusMessage(value)
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de l’enregistrement.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-border/80 bg-bg-secondary/40 p-3 space-y-2">
      <p className="text-sm font-medium text-text-primary">Phrase de statut</p>
      <p className="text-xs text-text-muted leading-relaxed">
        Visible en bas à gauche sur ton profil et sur la carte profil des autres (présence Matrix). Certains homeservers
        limitent ou désactivent la diffusion de la présence.
      </p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, MAX_PRESENCE_STATUS_MSG_LEN))}
        disabled={disabled || saving}
        rows={2}
        placeholder="Ex. En train de coder…"
        className="w-full text-sm rounded-md border border-border bg-bg-primary px-3 py-2 text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:ring-2 focus:ring-accent-pink/40 disabled:opacity-50"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-text-muted">
          {value.length}/{MAX_PRESENCE_STATUS_MSG_LEN}
        </span>
        <button
          type="button"
          disabled={disabled || saving}
          onClick={() => void handleSave()}
          className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium bg-accent-pink text-white hover:bg-accent-pink-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Enregistrement…' : savedFlash ? 'Enregistré ✓' : 'Enregistrer le statut'}
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
