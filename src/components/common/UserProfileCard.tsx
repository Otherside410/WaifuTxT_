import { useEffect, useRef, useState, type RefObject } from 'react'
import { Avatar } from './Avatar'
import { useUiStore } from '../../stores/uiStore'
import { useRoomStore } from '../../stores/roomStore'
import { getOrCreateDmRoom, getUserBannerUrl, getUserStatusMessage } from '../../lib/matrix'

const CARD_WIDTH = 320

export function UserProfileCard({
  open,
  anchorRef,
  onClose,
  displayName,
  userId,
  avatarUrl,
  presence,
  powerLevel,
  statusMessage,
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  displayName: string
  userId: string
  avatarUrl: string | null
  presence: 'online' | 'offline' | 'unavailable'
  powerLevel: number
  /** Matrix presence status_msg when known */
  statusMessage?: string | null
}) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const [dmLoading, setDmLoading] = useState(false)
  const [bannerUrl, setBannerUrl] = useState<string | null>(null)
  const [profileStatusMsg, setProfileStatusMsg] = useState<string | null>(null)
  const setPendingMention = useUiStore((s) => s.setPendingMention)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)

  useEffect(() => {
    if (!open) return
    setBannerUrl(null)
    setProfileStatusMsg(null)
    getUserBannerUrl(userId).then(setBannerUrl).catch(() => null)
    getUserStatusMessage(userId).then(setProfileStatusMsg).catch(() => null)
  }, [open, userId])

  useEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const margin = 12
      const cardHeight = cardRef.current?.offsetHeight ?? 280

      const spaceBelow = window.innerHeight - rect.bottom - margin
      const top =
        spaceBelow >= cardHeight
          ? rect.bottom + 8
          : Math.max(margin, rect.top - cardHeight - 8)

      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - CARD_WIDTH - margin))
      setCoords({ top, left })
    }

    const handleDocumentClick = (e: MouseEvent) => {
      if (
        !cardRef.current?.contains(e.target as Node) &&
        !anchorRef.current?.contains(e.target as Node)
      )
        onClose()
    }
    const handleEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    updatePosition()
    const raf = requestAnimationFrame(updatePosition)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    document.addEventListener('mousedown', handleDocumentClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('mousedown', handleDocumentClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open, anchorRef, onClose])

  const handleDm = async () => {
    setDmLoading(true)
    try {
      const roomId = await getOrCreateDmRoom(userId)
      setActiveRoom(roomId)
      onClose()
    } catch (err) {
      console.error('[WaifuTxT] DM creation failed:', err)
    } finally {
      setDmLoading(false)
    }
  }

  const handleMention = () => {
    const localpart = userId.split(':')[0]?.replace('@', '') ?? userId
    setPendingMention(`@${localpart}`)
    onClose()
  }

  if (!open || !coords) return null

  const role = powerLevel >= 100 ? 'Admin' : powerLevel >= 50 ? 'Modérateur' : 'Membre'
  const statusLabel =
    presence === 'online' ? 'En ligne' : presence === 'unavailable' ? 'Absent' : 'Hors ligne'

  return (
    <div
      ref={cardRef}
      className="fixed z-50 rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden"
      style={{ top: coords.top, left: coords.left, width: CARD_WIDTH }}
    >
      {/* Banner */}
      {bannerUrl ? (
        <div className="h-20 overflow-hidden">
          <img src={bannerUrl} alt="" className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className="h-16 bg-gradient-to-r from-purple-500/80 to-accent-pink/70" />
      )}

      {/* Body */}
      <div className="px-4 pb-4">
        <div className="-mt-8 mb-3">
          <Avatar src={avatarUrl} name={displayName} size={64} />
        </div>
        <p className="text-xl font-bold leading-tight text-text-primary">{displayName}</p>
        <p className="text-xs text-text-muted mt-0.5 font-mono truncate">{userId}</p>

        <div className="mt-2.5 flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              presence === 'online'
                ? 'bg-success'
                : presence === 'unavailable'
                  ? 'bg-warning'
                  : 'bg-text-muted'
            }`}
          />
          <span className="text-xs text-text-secondary">{statusLabel}</span>
          <span className="text-xs text-text-muted">·</span>
          <span className="text-xs text-text-secondary">{role}</span>
        </div>

        {(statusMessage?.trim() || profileStatusMsg) ? (
          <p className="mt-2 text-xs font-semibold text-text-secondary leading-snug line-clamp-3 border-t border-border/60 pt-2">
            {statusMessage?.trim() || profileStatusMsg}
          </p>
        ) : null}

        {/* Actions */}
        <div className="mt-3 flex gap-2">
          <button
            onClick={handleDm}
            disabled={dmLoading}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium bg-accent-pink text-white hover:bg-accent-pink-hover disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-wait"
          >
            {dmLoading ? (
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            )}
            Message privé
          </button>

          <button
            onClick={handleMention}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
            title="Mentionner dans le chat"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zm0 0c0 1.657 1.007 3 2.25 3S21 13.657 21 12a9 9 0 10-2.636 6.364M16.5 12V8.25" />
            </svg>
            Mentionner
          </button>
        </div>
      </div>
    </div>
  )
}
