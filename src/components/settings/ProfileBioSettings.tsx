import { useState } from 'react'
import { getOwnBio, MAX_BIO_LEN, setOwnBio } from '../../lib/matrix'

function matrixErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const o = err as { errcode?: unknown; message?: unknown }
  if (typeof o.message !== 'string') return null
  if (typeof o.errcode === 'string' && o.errcode) return `${o.message} (${o.errcode})`
  return o.message
}

type ProfileBioSettingsProps = {
  disabled?: boolean
}

export function ProfileBioSettings({ disabled }: ProfileBioSettingsProps) {
  const [value, setValue] = useState(() => getOwnBio())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  const handleSave = async () => {
    setError(null)
    setSaving(true)
    try {
      await setOwnBio(value)
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 2000)
    } catch (err) {
      const mx = matrixErrorMessage(err)
      setError(mx ?? (err instanceof Error ? err.message : "Échec de l'enregistrement."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-border/80 bg-bg-secondary/40 p-3 space-y-2">
      <p className="text-sm font-medium text-text-primary">Bio</p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, MAX_BIO_LEN))}
        disabled={disabled || saving}
        rows={3}
        placeholder="Parle de toi en quelques mots…"
        className="w-full text-sm rounded-md border border-border bg-bg-primary px-3 py-2 text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:ring-2 focus:ring-accent-pink/40 disabled:opacity-50"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-text-muted">
          {value.length}/{MAX_BIO_LEN}
        </span>
        <button
          type="button"
          disabled={disabled || saving}
          onClick={() => void handleSave()}
          className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium bg-accent-pink text-white hover:bg-accent-pink-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Enregistrement…' : savedFlash ? 'Enregistrée ✓' : 'Enregistrer la bio'}
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
