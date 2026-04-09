import { useMemo, useState, type FormEvent } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { useMessageStore } from '../../stores/messageStore'
import { useUiStore } from '../../stores/uiStore'
import { Avatar } from '../common/Avatar'
import { renameRoom, canUserRenameRoom, leaveRoom } from '../../lib/matrix'

export function RoomHeader() {
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const rooms = useRoomStore((s) => s.rooms)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const toggleMemberPanel = useUiStore((s) => s.toggleMemberPanel)
  const showMemberPanel = useUiStore((s) => s.showMemberPanel)
  const togglePinnedPanel = useUiStore((s) => s.togglePinnedPanel)
  const showPinnedPanel = useUiStore((s) => s.showPinnedPanel)
  const toggleMobileMenu = useUiStore((s) => s.toggleMobileMenu)
  const toggleThreadsListPanel = useUiStore((s) => s.toggleThreadsListPanel)
  const showThreadsListPanel = useUiStore((s) => s.showThreadsListPanel)
  const pinnedEventIds = useMessageStore((s) => s.pinnedEventIds)
  const pinnedVersion = useMessageStore((s) => s.pinnedVersion)

  const [showRenameModal, setShowRenameModal] = useState(false)
  const [newName, setNewName] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)

  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [isLeaving, setIsLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)

  const pinnedCount = useMemo(() => {
    if (!activeRoomId) return 0
    return (pinnedEventIds.get(activeRoomId) || []).length
  }, [activeRoomId, pinnedEventIds, pinnedVersion])

  if (!activeRoomId) return null

  const room = rooms.get(activeRoomId)
  if (!room) return null

  const canRename = canUserRenameRoom(activeRoomId)

  const handleRename = async (e: FormEvent) => {
    e.preventDefault()
    if (isRenaming || !newName.trim()) return
    setRenameError(null)
    setIsRenaming(true)
    try {
      await renameRoom(activeRoomId, newName.trim())
      setShowRenameModal(false)
      setNewName('')
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Impossible de renommer')
    } finally {
      setIsRenaming(false)
    }
  }

  const handleLeave = async () => {
    if (isLeaving) return
    setIsLeaving(true)
    setLeaveError(null)
    try {
      await leaveRoom(activeRoomId)
      setActiveRoom(null)
      setShowLeaveConfirm(false)
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : 'Impossible de quitter')
    } finally {
      setIsLeaving(false)
    }
  }

  return (
    <>
      <div className="h-12 px-4 flex items-center gap-3 border-b border-border bg-bg-primary/95 backdrop-blur-sm shrink-0 sticky top-0 z-10">
        <button
          onClick={toggleMobileMenu}
          className="lg:hidden p-1.5 rounded transition-colors cursor-pointer text-text-muted hover:text-text-primary shrink-0 self-center"
          title="Ouvrir la navigation"
          aria-label="Ouvrir la navigation"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        <Avatar src={room.avatarUrl} name={room.name} size={22} shape="rounded" />
        <h2 className="font-semibold text-text-primary text-sm">{room.name}</h2>
        {room.topic && (
          <>
            <div className="w-px h-5 bg-border" />
            <p className="text-xs text-text-muted truncate flex-1">{room.topic}</p>
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          {canRename && (
            <button
              onClick={() => { setNewName(room.name); setShowRenameModal(true) }}
              className="p-1.5 rounded transition-colors cursor-pointer text-text-muted hover:text-text-primary"
              title="Renommer le salon"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
              </svg>
            </button>
          )}
          <button
            onClick={togglePinnedPanel}
            className={`relative p-1.5 rounded transition-colors cursor-pointer ${
              showPinnedPanel ? 'text-text-primary bg-bg-hover' : 'text-text-muted hover:text-text-primary'
            }`}
            title="Messages épinglés"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
            </svg>
            {pinnedCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-accent-pink text-white text-[10px] font-bold px-1">
                {pinnedCount}
              </span>
            )}
          </button>
          <button
            onClick={toggleThreadsListPanel}
            className={`p-1.5 rounded transition-colors cursor-pointer ${
              showThreadsListPanel ? 'text-text-primary bg-bg-hover' : 'text-text-muted hover:text-text-primary'
            }`}
            title="Fils de discussion"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h8M8 8h5M8 16h6" />
              <rect x="3" y="3" width="18" height="18" rx="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={toggleMemberPanel}
            className={`hidden lg:block p-1.5 rounded transition-colors cursor-pointer ${
              showMemberPanel ? 'text-text-primary bg-bg-hover' : 'text-text-muted hover:text-text-primary'
            }`}
            title="Membres"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
            </svg>
          </button>
          <button
            onClick={toggleMemberPanel}
            className={`lg:hidden p-1.5 rounded transition-colors cursor-pointer ${
              showMemberPanel ? 'text-text-primary bg-bg-hover' : 'text-text-muted hover:text-text-primary'
            }`}
            title="Ouvrir les membres"
            aria-label="Ouvrir les membres"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          <button
            onClick={() => setShowLeaveConfirm(true)}
            className="p-1.5 rounded transition-colors cursor-pointer text-text-muted hover:text-danger"
            title="Quitter le salon"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
          </button>
        </div>
      </div>

      {showRenameModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4" onClick={() => { if (!isRenaming) setShowRenameModal(false) }}>
          <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-text-primary">Renommer le salon</h3>
            <form onSubmit={handleRename} className="mt-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => { setNewName(e.target.value); if (renameError) setRenameError(null) }}
                placeholder="Nouveau nom"
                disabled={isRenaming}
                autoFocus
                className="w-full"
              />
              {renameError && <p className="mt-2 text-xs text-danger">{renameError}</p>}
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowRenameModal(false)}
                  disabled={isRenaming}
                  className="px-3 py-1.5 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={isRenaming || !newName.trim() || newName.trim() === room.name}
                  className="px-3 py-1.5 text-sm rounded-md bg-accent-pink text-white hover:bg-accent-pink-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {isRenaming ? 'Renommage...' : 'Renommer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showLeaveConfirm && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4" onClick={() => { if (!isLeaving) setShowLeaveConfirm(false) }}>
          <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-text-primary">Quitter {room.isSpace ? 'cet espace' : 'ce salon'} ?</h3>
            <p className="mt-1.5 text-sm text-text-secondary">
              Tu quittes <span className="font-medium text-text-primary">{room.name}</span>. Tu pourras le rejoindre à nouveau si tu es invité.
            </p>
            {leaveError && <p className="mt-2 text-xs text-danger">{leaveError}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowLeaveConfirm(false)}
                disabled={isLeaving}
                className="px-3 py-1.5 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Annuler
              </button>
              <button
                onClick={handleLeave}
                disabled={isLeaving}
                className="px-3 py-1.5 text-sm rounded-md bg-danger text-white hover:bg-danger/80 disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                {isLeaving ? 'En cours...' : 'Quitter'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
