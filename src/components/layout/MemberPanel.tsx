import { useEffect, useRef, useState } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { useUiStore } from '../../stores/uiStore'
import { Avatar } from '../common/Avatar'
import { getOrCreateDmRoom } from '../../lib/matrix'
import type { RoomMember } from '../../types/matrix'

const CARD_WIDTH = 300

// ---------------------------------------------------------------------------
// Mini profile popup shown to the left of the panel
// ---------------------------------------------------------------------------

function MemberCard({
  member,
  anchorRef,
  onClose,
}: {
  member: RoomMember
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const [dmLoading, setDmLoading] = useState(false)
  const setPendingMention = useUiStore((s) => s.setPendingMention)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)

  useEffect(() => {
    const updateCoords = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const cardHeight = cardRef.current?.offsetHeight ?? 240
      const margin = 8
      const left = Math.max(margin, rect.left - CARD_WIDTH - 8)
      const spaceBelow = window.innerHeight - rect.top - margin
      const top = spaceBelow >= cardHeight
        ? rect.top
        : Math.max(margin, rect.bottom - cardHeight)
      setCoords({ top, left })
    }

    updateCoords()
    const raf = requestAnimationFrame(updateCoords)

    const onClickOutside = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }

    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onEsc)
    window.addEventListener('resize', updateCoords)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', onClickOutside)
      document.removeEventListener('keydown', onEsc)
      window.removeEventListener('resize', updateCoords)
    }
  }, [anchorRef, onClose])

  const handleDm = async () => {
    setDmLoading(true)
    try {
      const roomId = await getOrCreateDmRoom(member.userId)
      setActiveRoom(roomId)
      onClose()
    } catch (err) {
      console.error('[WaifuTxT] DM failed:', err)
    } finally {
      setDmLoading(false)
    }
  }

  const handleMention = () => {
    const localpart = member.userId.split(':')[0]?.replace('@', '') ?? member.userId
    setPendingMention(`@${localpart}`)
    onClose()
  }

  const role = member.powerLevel >= 100 ? 'Admin' : member.powerLevel >= 50 ? 'Modérateur' : 'Membre'
  const statusLabel = member.presence === 'online' ? 'En ligne' : member.presence === 'unavailable' ? 'Absent' : 'Hors ligne'

  return (
    <div
      ref={cardRef}
      className="fixed z-50 rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden"
      style={coords
        ? { top: coords.top, left: coords.left, width: CARD_WIDTH }
        : { visibility: 'hidden', top: -9999, left: -9999, width: CARD_WIDTH }}
    >
      <div className="h-12 bg-gradient-to-r from-purple-500/80 to-accent-pink/70" />
      <div className="px-3 pb-3">
        <div className="-mt-6 mb-2">
          <Avatar src={member.avatarUrl} name={member.displayName} size={48} />
        </div>
        <p className="text-base font-bold leading-tight text-text-primary">{member.displayName}</p>
        <p className="text-[11px] text-text-muted font-mono truncate mt-0.5">{member.userId}</p>
        <div className="mt-2 flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full shrink-0 ${
            member.presence === 'online' ? 'bg-success' : member.presence === 'unavailable' ? 'bg-warning' : 'bg-text-muted'
          }`} />
          <span className="text-xs text-text-secondary">{statusLabel}</span>
          <span className="text-xs text-text-muted">·</span>
          <span className="text-xs text-text-secondary">{role}</span>
        </div>
        <div className="mt-2.5 flex gap-1.5">
          <button
            onClick={handleDm}
            disabled={dmLoading}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium bg-accent-pink text-white hover:bg-accent-pink-hover disabled:opacity-50 transition-colors cursor-pointer"
          >
            {dmLoading ? (
              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            )}
            Message privé
          </button>
          <button
            onClick={handleMention}
            className="flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
            title="Mentionner dans le chat"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zm0 0c0 1.657 1.007 3 2.25 3S21 13.657 21 12a9 9 0 10-2.636 6.364M16.5 12V8.25" />
            </svg>
            @
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single member row
// ---------------------------------------------------------------------------

function MemberRow({ member }: { member: RoomMember }) {
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)

  return (
    <>
      <div
        ref={rowRef}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2.5 px-2 py-1 rounded-md hover:bg-bg-hover/50 transition-colors cursor-pointer select-none"
      >
        <Avatar src={member.avatarUrl} name={member.displayName} size={32} status={member.presence} />
        <div className="min-w-0">
          <div className="text-sm truncate text-text-primary">{member.displayName}</div>
        </div>
      </div>
      {open && (
        <MemberCard
          member={member}
          anchorRef={rowRef as React.RefObject<HTMLElement | null>}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function MemberPanel() {
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const members = useRoomStore((s) => (activeRoomId ? s.members.get(activeRoomId) : undefined))

  if (!members) return null

  const admins  = members.filter((m) => m.powerLevel >= 100)
  const mods    = members.filter((m) => m.powerLevel >= 50 && m.powerLevel < 100)
  const regular = members.filter((m) => m.powerLevel < 50)

  const renderGroup = (title: string, list: RoomMember[]) => {
    if (list.length === 0) return null
    return (
      <div className="mb-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted px-2 mb-1">
          {title} — {list.length}
        </h3>
        {list.map((member) => <MemberRow key={member.userId} member={member} />)}
      </div>
    )
  }

  return (
    <div className="w-60 bg-bg-secondary border-l border-border flex flex-col">
      <div className="h-12 px-4 flex items-center border-b border-border shrink-0">
        <h2 className="text-sm font-semibold text-text-primary">Membres — {members.length}</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {renderGroup('Admins', admins)}
        {renderGroup('Modérateurs', mods)}
        {renderGroup('Membres', regular)}
      </div>
    </div>
  )
}
