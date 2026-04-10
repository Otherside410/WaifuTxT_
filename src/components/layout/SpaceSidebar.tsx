import { useMemo, useState, type FormEvent } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { Avatar } from '../common/Avatar'
import { Tooltip } from '../common/Tooltip'
import { createSpace } from '../../lib/matrix'

function SpaceBadge({ mentions, unread, invites }: { mentions: number; unread: number; invites: number }) {
  if (mentions > 0) {
    return (
      <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-danger text-white text-[10px] font-bold leading-none z-10 ring-2 ring-bg-primary">
        {mentions > 99 ? '99+' : mentions}
      </span>
    )
  }
  if (invites > 0) {
    return (
      <span className="absolute -top-1 -right-1 w-[18px] h-[18px] flex items-center justify-center rounded-full bg-accent-pink text-white z-10 ring-2 ring-bg-primary">
        <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M2.003 5.884 10 9.882l7.997-3.998A2 2 0 0 0 16 4H4a2 2 0 0 0-1.997 1.884z" />
          <path d="m18 8.118-8 4-8-4V14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.118z" />
        </svg>
      </span>
    )
  }
  if (unread > 0) {
    return (
      <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-text-secondary z-10 ring-2 ring-bg-primary" />
    )
  }
  return null
}

export function SpaceSidebar() {
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [spaceType, setSpaceType] = useState<'public' | 'private'>('private')
  const [spaceName, setSpaceName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const rooms = useRoomStore((s) => s.rooms)
  const activeSpaceId = useRoomStore((s) => s.activeSpaceId)
  const setActiveSpace = useRoomStore((s) => s.setActiveSpace)

  // Only top-level spaces: exclude sub-spaces that are children of another space
  const spaces = useMemo(() => {
    const allSpaces = Array.from(rooms.values()).filter((r) => r.isSpace)
    const childSpaceIds = new Set<string>()
    for (const space of allSpaces) {
      for (const childId of space.children) {
        if (rooms.get(childId)?.isSpace) childSpaceIds.add(childId)
      }
    }
    return allSpaces.filter((s) => !childSpaceIds.has(s.roomId))
  }, [rooms])

  // Badge counts: mentions, unread, invitations — per space and for the home button
  const badges = useMemo(() => {
    const allRooms = Array.from(rooms.values())

    // Room IDs that belong to ANY space (all levels) — same logic as RoomSidebar
    const allSpacedRoomIds = new Set<string>()
    for (const r of allRooms) {
      if (!r.isSpace) continue
      for (const childId of r.children) allSpacedRoomIds.add(childId)
    }

    // Home = DMs + rooms not in any space (joined or invited)
    const homeRooms = allRooms.filter((r) => !r.isSpace && (r.isDirect || !allSpacedRoomIds.has(r.roomId)))
    const home = {
      mentions: homeRooms.filter((r) => r.membership === 'join').reduce((s, r) => s + r.mentionCount, 0),
      unread:   homeRooms.filter((r) => r.membership === 'join').reduce((s, r) => s + r.unreadCount, 0),
      invites:  homeRooms.filter((r) => r.membership === 'invite').length,
    }

    // Per space
    const spaceMap = new Map<string, { mentions: number; unread: number; invites: number }>()
    for (const space of spaces) {
      let mentions = 0, unread = 0, invites = 0
      for (const childId of space.children) {
        const r = rooms.get(childId)
        if (!r || r.isSpace) continue
        mentions += r.mentionCount
        unread   += r.unreadCount
        if (r.membership === 'invite') invites++
      }
      spaceMap.set(space.roomId, { mentions, unread, invites })
    }

    return { home, spaces: spaceMap }
  }, [rooms, spaces])

  const submitCreateSpace = async (e: FormEvent) => {
    e.preventDefault()
    if (isCreating || !spaceName.trim()) return
    setCreateError(null)
    setIsCreating(true)
    try {
      const roomId = await createSpace(spaceName.trim(), { visibility: spaceType })
      setActiveSpace(roomId)
      setShowCreateModal(false)
      setSpaceName('')
      setSpaceType('private')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Impossible de créer le serveur'
      setCreateError(message)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="w-[72px] bg-bg-primary flex flex-col items-center py-3 gap-2 overflow-y-auto border-r border-border">
      <Tooltip content="Messages directs">
        <button
          onMouseDown={(e) => {
            if (e.button === 0) setActiveSpace(null)
          }}
          onClick={() => setActiveSpace(null)}
          className={`relative w-12 h-12 flex items-center justify-center transition-[border-radius,background-color,color,box-shadow,transform] duration-100 ease-[cubic-bezier(0.22,1,0.36,1)] cursor-pointer ${
            activeSpaceId === null
              ? 'bg-accent-pink rounded-xl text-white'
              : 'bg-bg-tertiary text-text-secondary rounded-full hover:bg-accent-pink hover:text-white'
          }`}
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
          <SpaceBadge {...badges.home} />
        </button>
      </Tooltip>

      <div className="w-8 h-0.5 bg-border rounded-full my-1" />

      {spaces.map((space) => {
        const b = badges.spaces.get(space.roomId) ?? { mentions: 0, unread: 0, invites: 0 }
        return (
          <Tooltip key={space.roomId} content={space.name}>
            <button
              onMouseDown={(e) => {
                if (e.button === 0) setActiveSpace(space.roomId)
              }}
              onClick={() => setActiveSpace(space.roomId)}
              className={`relative w-12 h-12 flex items-center justify-center transition-[border-radius,box-shadow,transform] duration-100 ease-[cubic-bezier(0.22,1,0.36,1)] cursor-pointer overflow-visible ${
                activeSpaceId === space.roomId
                  ? 'rounded-xl ring-2 ring-accent-pink'
                  : 'rounded-full'
              }`}
            >
              <Avatar
                src={space.avatarUrl}
                name={space.name}
                size={48}
                shape={activeSpaceId === space.roomId ? 'rounded' : 'circle'}
              />
              <SpaceBadge {...b} />
            </button>
          </Tooltip>
        )
      })}

      <Tooltip content="Créer un serveur">
        <button
          onClick={() => setShowCreateModal(true)}
          disabled={isCreating}
          className="w-12 h-12 flex items-center justify-center rounded-full bg-bg-tertiary text-text-secondary hover:bg-accent-pink hover:text-white transition-[border-radius,background-color,color,box-shadow,transform] duration-100 ease-[cubic-bezier(0.22,1,0.36,1)] cursor-pointer disabled:opacity-60 disabled:cursor-wait"
          aria-label="Créer un serveur"
          title="Créer un serveur"
        >
          {isCreating ? (
            <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v3m0 12v3m9-9h-3M6 12H3m15.364 6.364l-2.121-2.121M7.757 7.757 5.636 5.636m12.728 0-2.121 2.121M7.757 16.243l-2.121 2.121" />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m7-7H5" />
            </svg>
          )}
        </button>
      </Tooltip>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="w-full max-w-[560px] rounded-2xl border border-border bg-bg-secondary shadow-2xl p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-2xl font-semibold text-text-primary">Créer un espace</h3>
                <p className="mt-2 text-text-secondary">
                  Les espaces regroupent des salons et des personnes. Tu peux choisir le type maintenant et le changer plus tard.
                </p>
              </div>
              <button
                onClick={() => {
                  if (isCreating) return
                  setShowCreateModal(false)
                  setSpaceName('')
                  setSpaceType('private')
                  setCreateError(null)
                }}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                aria-label="Fermer"
              >
                ×
              </button>
            </div>

            <div className="mt-5 space-y-3">
              <button
                onClick={() => setSpaceType('public')}
                className={`w-full rounded-xl border p-4 text-left transition-colors cursor-pointer ${
                  spaceType === 'public'
                    ? 'border-accent-pink bg-accent-pink/10'
                    : 'border-border bg-bg-primary/40 hover:bg-bg-hover'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full bg-bg-tertiary text-text-muted">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18" />
                    </svg>
                  </span>
                  <div>
                    <p className="text-xl font-semibold text-text-primary">Public</p>
                    <p className="text-text-secondary">Espace ouvert a tous, ideal pour les communautes.</p>
                  </div>
                </div>
              </button>

              <button
                onClick={() => setSpaceType('private')}
                className={`w-full rounded-xl border p-4 text-left transition-colors cursor-pointer ${
                  spaceType === 'private'
                    ? 'border-accent-pink bg-accent-pink/10'
                    : 'border-border bg-bg-primary/40 hover:bg-bg-hover'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full bg-bg-tertiary text-text-muted">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2.25m-4.5 0h9A2.25 2.25 0 0018.75 15V9.75A2.25 2.25 0 0016.5 7.5h-9A2.25 2.25 0 005.25 9.75V15A2.25 2.25 0 007.5 17.25zM9 7.5V6a3 3 0 016 0v1.5" />
                    </svg>
                  </span>
                  <div>
                    <p className="text-xl font-semibold text-text-primary">Prive</p>
                    <p className="text-text-secondary">Sur invitation, ideal pour toi ou ton equipe.</p>
                  </div>
                </div>
              </button>
            </div>

            <form onSubmit={submitCreateSpace} className="mt-5">
              <label className="block text-sm text-text-secondary mb-1.5" htmlFor="new-space-name">
                Nom de l&apos;espace
              </label>
              <input
                id="new-space-name"
                type="text"
                value={spaceName}
                onChange={(e) => {
                  setSpaceName(e.target.value)
                  if (createError) setCreateError(null)
                }}
                placeholder="Mon espace"
                disabled={isCreating}
                className="w-full"
              />
              {createError && (
                <p className="mt-2 text-xs text-danger">{createError}</p>
              )}
              <div className="mt-4 flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="rounded-full border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                >
                  Rechercher des espaces publics
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (isCreating) return
                      setShowCreateModal(false)
                      setSpaceName('')
                      setSpaceType('private')
                      setCreateError(null)
                    }}
                    className="px-3 py-2 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                    disabled={isCreating}
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    disabled={isCreating || !spaceName.trim()}
                    className="px-3 py-2 text-sm rounded-md bg-accent-pink text-white hover:bg-accent-pink-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    {isCreating ? 'Creation...' : 'Creer'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
