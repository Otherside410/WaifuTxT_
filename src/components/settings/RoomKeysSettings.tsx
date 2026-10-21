import { useRef, useState } from 'react'
import { exportRoomKeysToFile, importRoomKeysFromFile } from '../../lib/matrix'

type Status = { tone: 'ok' | 'error'; text: string } | null

export function RoomKeysSettings() {
  const [passphrase, setPassphrase] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleExport = async () => {
    if (!passphrase) return
    setBusy('export')
    setStatus(null)
    try {
      const content = await exportRoomKeysToFile(passphrase)
      const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'waifuchat-keys.txt'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setStatus({ tone: 'ok', text: 'Clés exportées. Conservez le fichier et la phrase secrète en lieu sûr.' })
    } catch (err) {
      setStatus({ tone: 'error', text: err instanceof Error ? err.message : "Échec de l'export des clés." })
    } finally {
      setBusy(null)
    }
  }

  const handleImport = async () => {
    if (!file || !passphrase) return
    setBusy('import')
    setStatus(null)
    try {
      const content = await file.text()
      await importRoomKeysFromFile(content, passphrase)
      setStatus({ tone: 'ok', text: 'Clés importées. Les messages concernés seront déchiffrés.' })
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err) {
      setStatus({ tone: 'error', text: err instanceof Error ? err.message : "Échec de l'import des clés." })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="p-4 rounded-lg border border-border bg-bg-primary/40 space-y-3">
      <div>
        <p className="text-sm font-medium text-text-primary">Clés de chiffrement des salons</p>
        <p className="text-xs text-text-secondary mt-0.5">
          Exportez vos clés dans un fichier protégé par une phrase secrète, ou importez un fichier
          exporté depuis WaifuChat ou Element.
        </p>
      </div>
      <input
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Phrase secrète"
        autoComplete="off"
        className="w-full !text-sm !py-2 !px-3"
      />
      <div className="flex flex-col sm:flex-row gap-2">
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={!passphrase || busy !== null}
          className="flex-1 py-2 rounded-md text-sm font-medium bg-accent-pink text-white hover:bg-accent-pink-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          {busy === 'export' ? 'Export en cours…' : 'Exporter les clés'}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setStatus(null)
          }}
          className="flex-1 min-w-0 text-xs text-text-secondary"
        />
        <button
          type="button"
          onClick={() => void handleImport()}
          disabled={!file || !passphrase || busy !== null}
          className="shrink-0 px-3 py-1.5 rounded-md text-sm border border-accent-pink/50 text-accent-pink hover:bg-accent-pink/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          {busy === 'import' ? 'Import en cours…' : 'Importer'}
        </button>
      </div>
      {status && (
        <p
          className={`text-xs rounded-md px-3 py-2 ${
            status.tone === 'ok' ? 'text-success bg-success/10' : 'text-danger bg-danger/10'
          }`}
        >
          {status.text}
        </p>
      )}
    </div>
  )
}
