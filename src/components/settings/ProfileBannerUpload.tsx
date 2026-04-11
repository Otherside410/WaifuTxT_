import { useEffect, useRef, useState } from 'react'
import {
  getOwnBannerUrl,
  uploadProfileBanner,
  removeProfileBanner,
} from '../../lib/matrix'

type Props = { disabled?: boolean }

export function ProfileBannerUpload({ disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const previewBlobRef = useRef<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(() => getOwnBannerUrl())
  const [uploading, setUploading] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (previewBlobRef.current) URL.revokeObjectURL(previewBlobRef.current)
    }
  }, [])

  const busy = uploading || removing

  const openPicker = () => {
    setError(null)
    inputRef.current?.click()
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    void handleUpload(file)
  }

  const handleUpload = async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      const { httpUrl } = await uploadProfileBanner(file)
      if (previewBlobRef.current) URL.revokeObjectURL(previewBlobRef.current)
      if (httpUrl) {
        setPreviewUrl(httpUrl)
      } else {
        const blobUrl = URL.createObjectURL(file)
        previewBlobRef.current = blobUrl
        setPreviewUrl(blobUrl)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'envoi.")
    } finally {
      setUploading(false)
    }
  }

  const handleRemove = async () => {
    setRemoving(true)
    setError(null)
    try {
      await removeProfileBanner()
      if (previewBlobRef.current) URL.revokeObjectURL(previewBlobRef.current)
      previewBlobRef.current = null
      setPreviewUrl(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de la suppression.')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="rounded-lg border border-border/80 bg-bg-secondary/40 p-3 space-y-2">
      <p className="text-sm font-medium text-text-primary">Bannière de carte profil</p>
      <p className="text-xs text-text-muted leading-relaxed">
        Image affichée en haut de ta carte quand quelqu'un clique sur ton avatar. PNG ou GIF animé, max 8 Mo.
        Stockée comme champ de profil Matrix public (<span className="font-mono text-text-secondary">io.waifu.banner</span>).
      </p>

      {previewUrl && (
        <div className="relative w-full h-20 rounded-md overflow-hidden border border-border">
          <img
            src={previewUrl}
            alt="Aperçu de la bannière"
            className="w-full h-full object-cover"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/gif,image/jpeg,image/webp"
          className="hidden"
          onChange={onFileChange}
        />
        <button
          type="button"
          disabled={disabled || busy}
          onClick={openPicker}
          className="inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium bg-bg-hover text-text-primary border border-border hover:bg-bg-hover/80 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {uploading ? 'Envoi en cours…' : previewUrl ? 'Changer la bannière…' : 'Choisir une bannière…'}
        </button>
        {previewUrl && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void handleRemove()}
            className="inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium bg-bg-hover text-danger border border-danger/30 hover:bg-danger/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {removing ? 'Suppression…' : 'Supprimer'}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
