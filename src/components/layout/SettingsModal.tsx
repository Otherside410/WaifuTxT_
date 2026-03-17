import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { useUiStore } from '../../stores/uiStore'
import { useRoomStore } from '../../stores/roomStore'
import { Avatar } from '../common/Avatar'
import { getSessions, getOwnAvatarUrl, isSessionVerified, logout, renameSession, deleteSession } from '../../lib/matrix'
import type { DeviceInfo } from '../../lib/matrix'
import { startSelfVerification } from '../../lib/verification'
import { AccentColorPicker } from '../settings/AccentColorPicker'
import { ThemePicker } from '../settings/ThemePicker'
import { WAIFU_OPTIONS, getWaifuById } from '../../lib/waifu'

const SETTINGS_SECTIONS = [
  { id: 'profile', label: 'Profil' },
  { id: 'security', label: 'Sécurité' },
  { id: 'appearance', label: 'Apparence' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'shortcuts', label: 'Raccourcis' },
  { id: 'account', label: 'Compte' },
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-text-secondary">{label}</span>
      <div className="flex items-center gap-1 shrink-0">
        {keys.map((key, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-text-muted text-xs">+</span>}
            <kbd className="px-1.5 py-0.5 rounded-md text-xs font-mono bg-bg-secondary border border-border text-text-primary">
              {key}
            </kbd>
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLastSeen(ts: number | null): string {
  if (!ts) return 'Jamais'
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return "À l'instant"
  if (minutes < 60) return `Il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Il y a ${hours} h`
  const days = Math.floor(hours / 24)
  return `Il y a ${days} j`
}

// ---------------------------------------------------------------------------
// Password confirmation modal (for session deletion)
// ---------------------------------------------------------------------------

function PasswordModal({
  deviceName,
  onConfirm,
  onCancel,
}: {
  deviceName: string
  onConfirm: (password: string) => void
  onCancel: () => void
}) {
  const [password, setPassword] = useState('')
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <button className="absolute inset-0 bg-black/65 backdrop-blur-[2px]" onClick={onCancel} />
      <div className="relative w-[380px] max-w-[92vw] rounded-xl border border-border bg-bg-secondary shadow-2xl p-6 space-y-4">
        <h3 className="text-base font-semibold text-text-primary">Confirmer la déconnexion</h3>
        <p className="text-sm text-text-secondary">
          Déconnecter <span className="text-text-primary font-medium">{deviceName}</span> nécessite
          de confirmer votre mot de passe.
        </p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Mot de passe"
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && password && onConfirm(password)}
          className="w-full !text-sm !py-2 !px-3"
        />
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-md text-sm border border-border text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            Annuler
          </button>
          <button
            onClick={() => password && onConfirm(password)}
            disabled={!password}
            className="flex-1 py-2 rounded-md text-sm bg-danger text-white hover:bg-danger/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            Déconnecter
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------

function SessionRow({
  device,
  onDelete,
}: {
  device: DeviceInfo
  onDelete: (device: DeviceInfo) => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(device.displayName)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleRename = async () => {
    if (!name.trim() || name === device.displayName) { setEditing(false); return }
    setSaving(true)
    try {
      await renameSession(device.deviceId, name.trim())
      device.displayName = name.trim()
    } catch {
      setName(device.displayName)
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
      device.isCurrentDevice
        ? 'border-accent-pink/40 bg-accent-pink/5'
        : 'border-border bg-bg-primary/40'
    }`}>
      {/* Icon */}
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
        device.isCurrentDevice ? 'bg-accent-pink/15' : 'bg-bg-tertiary'
      }`}>
        <svg className={`w-4 h-4 ${device.isCurrentDevice ? 'text-accent-pink' : 'text-text-muted'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0H3" />
        </svg>
      </div>

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') { setName(device.displayName); setEditing(false) } }}
            className="w-full !text-xs !py-0.5 !px-1.5"
          />
        ) : (
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-text-primary truncate">{name}</p>
            {device.isCurrentDevice && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-pink/15 text-accent-pink font-medium shrink-0">Cette session</span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          {device.lastSeenIp && (
            <span className="text-xs text-text-muted font-mono">{device.lastSeenIp}</span>
          )}
          {device.lastSeenIp && device.lastSeenTs && (
            <span className="text-xs text-text-muted">·</span>
          )}
          {device.lastSeenTs && (
            <span className="text-xs text-text-muted">{formatLastSeen(device.lastSeenTs)}</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {!editing && !saving && (
          <button
            onClick={() => setEditing(true)}
            className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title="Renommer"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
            </svg>
          </button>
        )}
        {saving && (
          <svg className="animate-spin w-3.5 h-3.5 text-accent-pink" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        <button
          onClick={() => onDelete(device)}
          className="p-1.5 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition-colors cursor-pointer"
          title={device.isCurrentDevice ? 'Se déconnecter' : 'Déconnecter cette session'}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
          </svg>
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Security section
// ---------------------------------------------------------------------------

function SecuritySection({ onClose }: { onClose: () => void }) {
  const [isStarting, setIsStarting] = useState(false)
  const [verified, setVerified] = useState<boolean | null>(null)
  const [sessions, setSessions] = useState<DeviceInfo[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [pendingDelete, setPendingDelete] = useState<DeviceInfo | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const authLogout = useAuthStore((s) => s.logout)

  useEffect(() => {
    isSessionVerified().then(setVerified).catch(() => setVerified(false))
    getSessions()
      .then((list) => setSessions(list.sort((a, b) => (b.isCurrentDevice ? 1 : 0) - (a.isCurrentDevice ? 1 : 0))))
      .catch(() => setSessions([]))
      .finally(() => setSessionsLoading(false))
  }, [])

  const handleVerify = async () => {
    setIsStarting(true)
    try {
      await startSelfVerification()
      onClose()
    } finally {
      setIsStarting(false)
    }
  }

  const handleDeleteRequest = (device: DeviceInfo) => {
    setDeleteError(null)
    setPendingDelete(device)
  }

  const handleDeleteConfirm = async (password: string) => {
    if (!pendingDelete) return
    try {
      if (pendingDelete.isCurrentDevice) {
        await logout()
        authLogout()
        return
      }
      await deleteSession(pendingDelete.deviceId, password)
      setSessions((prev) => prev.filter((s) => s.deviceId !== pendingDelete.deviceId))
      setPendingDelete(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Erreur lors de la déconnexion')
      setPendingDelete(null)
    }
  }

  return (
    <>
      {pendingDelete && (
        <PasswordModal
          deviceName={pendingDelete.displayName}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      <div className="mt-6 space-y-4">
        {/* Verification status */}
        <div className="p-4 rounded-lg border border-border bg-bg-primary/40 space-y-3">
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${verified ? 'bg-success/15' : 'bg-accent-pink/15'}`}>
              <svg className={`w-4 h-4 ${verified ? 'text-success' : 'text-accent-pink'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.955 11.955 0 003 10c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.572-.598-3.75h-.152c-3.196 0-6.1-1.249-8.25-3.286z" />
              </svg>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">Vérifier cette session</p>
              {verified ? (
                <p className="text-xs text-success mt-0.5">Cette session est vérifiée.</p>
              ) : (
                <p className="text-xs text-text-secondary mt-0.5">
                  Confirmez l'identité de ce client depuis votre téléphone, un autre navigateur
                  ou un client Matrix (Element, Cinny, Comet…).
                </p>
              )}
            </div>
          </div>
          {!verified && (
            <button
              onClick={handleVerify}
              disabled={isStarting}
              className="w-full py-2 rounded-md text-sm font-medium bg-accent-pink text-white hover:bg-accent-pink-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {isStarting ? 'Envoi de la demande…' : 'Vérifier avec un autre appareil'}
            </button>
          )}
        </div>

        {/* Sessions list */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wide px-0.5">Sessions actives</p>
          {deleteError && (
            <p className="text-xs text-danger bg-danger/10 rounded-md px-3 py-2">{deleteError}</p>
          )}
          {sessionsLoading ? (
            <div className="flex items-center gap-2 py-4 justify-center text-text-muted text-sm">
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Chargement…
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-text-muted py-3 text-center">Aucune session trouvée.</p>
          ) : (
            sessions.map((device) => (
              <SessionRow key={device.deviceId} device={device} onDelete={handleDeleteRequest} />
            ))
          )}
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Account section
// ---------------------------------------------------------------------------

function AccountSection() {
  const session = useAuthStore((s) => s.session)
  const authLogout = useAuthStore((s) => s.logout)
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  const handleLogout = async () => {
    setIsLoggingOut(true)
    try {
      await logout()
    } finally {
      authLogout()
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="p-4 rounded-lg border border-border bg-bg-primary/40 space-y-3">
        <div>
          <p className="text-sm font-medium text-text-primary">Compte connecté</p>
          <p className="text-xs text-text-muted mt-0.5 font-mono">{session?.userId}</p>
          <p className="text-xs text-text-muted mt-0.5">Serveur : {session?.homeserver}</p>
        </div>
      </div>

      <div className="p-4 rounded-lg border border-danger/30 bg-danger/5 space-y-3">
        <div>
          <p className="text-sm font-medium text-text-primary">Déconnexion</p>
          <p className="text-xs text-text-secondary mt-0.5">
            Déconnecte cette session. Votre compte et vos messages restent sur le serveur.
            Vous devrez vous réauthentifier et re-vérifier la session pour lire les messages chiffrés.
          </p>
        </div>
        <button
          onClick={handleLogout}
          disabled={isLoggingOut}
          className="w-full py-2 rounded-md text-sm font-medium bg-danger text-white hover:bg-danger/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          {isLoggingOut ? 'Déconnexion…' : 'Se déconnecter'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root modal
// ---------------------------------------------------------------------------

export function SettingsModal() {
  const session = useAuthStore((s) => s.session)
  const setSettingsModal = useUiStore((s) => s.setSettingsModal)
  const showRoomMessagePreview = useUiStore((s) => s.showRoomMessagePreview)
  const setRoomMessagePreview = useUiStore((s) => s.setRoomMessagePreview)
  const showUnreadDot = useUiStore((s) => s.showUnreadDot)
  const setShowUnreadDot = useUiStore((s) => s.setShowUnreadDot)
  const showMentionBadge = useUiStore((s) => s.showMentionBadge)
  const setShowMentionBadge = useUiStore((s) => s.setShowMentionBadge)
  const waifuOptIn = useUiStore((s) => s.waifuOptIn)
  const selectedWaifuId = useUiStore((s) => s.selectedWaifuId)
  const setWaifuOptIn = useUiStore((s) => s.setWaifuOptIn)
  const setSelectedWaifuId = useUiStore((s) => s.setSelectedWaifuId)
  const typingIndicatorStyle = useUiStore((s) => s.typingIndicatorStyle)
  const setTypingIndicatorStyle = useUiStore((s) => s.setTypingIndicatorStyle)
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('profile')
  const [ownAvatarUrl, setOwnAvatarUrl] = useState<string | null>(null)
  const avatarFetched = useRef(false)
  const rooms = useRoomStore((s) => s.rooms)

  useEffect(() => {
    if (avatarFetched.current) return
    const url = getOwnAvatarUrl()
    if (url) {
      setOwnAvatarUrl(url)
      avatarFetched.current = true
    }
  }, [rooms])

  const username = useMemo(
    () => session?.userId?.split(':')[0]?.replace('@', '') || 'Utilisateur',
    [session?.userId],
  )
  const displayedOwnAvatarUrl = useMemo(() => {
    if (waifuOptIn) return getWaifuById(selectedWaifuId).imageUrl
    return ownAvatarUrl
  }, [ownAvatarUrl, selectedWaifuId, waifuOptIn])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
        aria-label="Fermer les paramètres"
        onClick={() => setSettingsModal(false)}
      />

      <div className="relative w-[900px] max-w-[92vw] h-[620px] max-h-[88vh] rounded-xl overflow-hidden border border-border bg-bg-secondary shadow-2xl flex">
        <div className="w-60 border-r border-border bg-bg-primary/60 p-3">
          <h2 className="text-xs uppercase tracking-wide text-text-muted px-2 py-2">Paramètres</h2>
          <div className="space-y-1">
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`w-full px-2.5 py-2 rounded-md text-left text-sm transition-colors cursor-pointer ${
                  activeSection === section.id
                    ? 'bg-bg-hover text-text-primary'
                    : 'text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary'
                }`}
              >
                {section.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-w-0 p-6 overflow-y-auto">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-semibold text-text-primary">
                {SETTINGS_SECTIONS.find((s) => s.id === activeSection)?.label}
              </h3>
              <p className="text-sm text-text-secondary mt-1">
                Cette section est la base des futurs paramètres customisables.
              </p>
            </div>
            <button
              onClick={() => setSettingsModal(false)}
              className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              aria-label="Fermer"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {activeSection === 'profile' && (
            <div className="mt-6 space-y-4">
              <div className="p-4 rounded-lg border border-border bg-bg-primary/40 flex items-center gap-4">
                <Avatar src={displayedOwnAvatarUrl} name={session?.userId || '?'} size={56} status="online" />
                <div className="min-w-0">
                  <p className="text-lg font-semibold text-text-primary truncate">{username}</p>
                  <p className="text-sm text-text-muted truncate">{session?.userId || 'Non connecté'}</p>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'security' && (
            <SecuritySection onClose={() => setSettingsModal(false)} />
          )}

          {activeSection === 'appearance' && (
            <div className="mt-6 space-y-3">
              {/* Message preview toggle */}
              <div className="p-4 rounded-lg border border-border bg-bg-primary/40 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-text-primary">Aperçu des messages des salons</p>
                  <p className="text-xs text-text-secondary mt-1">
                    Affiche ou masque la ligne de prévisualisation sous le nom du salon dans la sidebar.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showRoomMessagePreview}
                  onClick={() => setRoomMessagePreview(!showRoomMessagePreview)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                    showRoomMessagePreview ? 'bg-accent-pink' : 'bg-bg-hover'
                  }`}
                  title="Activer ou désactiver l'aperçu des messages"
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      showRoomMessagePreview ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Theme picker */}
              <div className="p-4 rounded-lg border border-border bg-bg-primary/40">
                <p className="text-sm font-medium text-text-primary mb-1">Thème</p>
                <p className="text-xs text-text-secondary mb-4">
                  Change l'apparence globale de l'interface. S'applique immédiatement.
                </p>
                <ThemePicker />
              </div>

              {/* Accent color picker */}
              <div className="p-4 rounded-lg border border-border bg-bg-primary/40">
                <p className="text-sm font-medium text-text-primary mb-1">Couleur d'accent</p>
                <p className="text-xs text-text-secondary mb-4">
                  Personnalise la couleur principale utilisée dans les boutons, badges et éléments actifs.
                </p>
                <AccentColorPicker />
              </div>

              {/* Waifu personalization */}
              <div className="p-4 rounded-lg border border-border bg-bg-primary/40 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-text-primary">Personnalisation waifu (opt-in)</p>
                    <p className="text-xs text-text-secondary mt-1">
                      Remplace localement votre avatar par une waifu dans l'interface WaifuTxT_.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={waifuOptIn}
                    onClick={() => setWaifuOptIn(!waifuOptIn)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                      waifuOptIn ? 'bg-accent-pink' : 'bg-bg-hover'
                    }`}
                    title="Activer ou désactiver la personnalisation waifu"
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        waifuOptIn ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {WAIFU_OPTIONS.map((waifu) => {
                    const selected = selectedWaifuId === waifu.id
                    return (
                      <button
                        key={waifu.id}
                        onClick={() => setSelectedWaifuId(waifu.id)}
                        disabled={!waifuOptIn}
                        className={`text-left rounded-lg border transition-colors overflow-hidden ${
                          selected
                            ? 'border-accent-pink bg-accent-pink/10'
                            : 'border-border bg-bg-tertiary/40 hover:border-accent-pink/40'
                        } ${waifuOptIn ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                      >
                        <img src={waifu.imageUrl} alt={waifu.name} className="w-full h-28 object-cover" />
                        <div className="p-2.5">
                          <p className="text-sm font-semibold text-text-primary">{waifu.name}</p>
                          <p className="text-xs text-text-secondary mt-0.5">{waifu.tagline}</p>
                        </div>
                      </button>
                    )
                  })}
                </div>

                <div className="pt-1">
                  <p className="text-sm font-medium text-text-primary mb-1">Indicateur "est en train d'écrire"</p>
                  <p className="text-xs text-text-secondary mb-3">
                    Choisissez d'afficher la waifu ou les trois points animés.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setTypingIndicatorStyle('waifu')}
                      className={`px-3 py-1.5 rounded-md text-xs border transition-colors cursor-pointer ${
                        typingIndicatorStyle === 'waifu'
                          ? 'border-accent-pink bg-accent-pink/10 text-accent-pink'
                          : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                      }`}
                    >
                      Waifu
                    </button>
                    <button
                      onClick={() => setTypingIndicatorStyle('dots')}
                      className={`px-3 py-1.5 rounded-md text-xs border transition-colors cursor-pointer ${
                        typingIndicatorStyle === 'dots'
                          ? 'border-accent-pink bg-accent-pink/10 text-accent-pink'
                          : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                      }`}
                    >
                      3 points
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'notifications' && (
            <div className="mt-6 space-y-3">
              <div className="p-4 rounded-lg border border-border bg-bg-primary/40 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-text-primary">Point messages non-lus</p>
                  <p className="text-xs text-text-secondary mt-1">
                    Affiche un petit point coloré à côté du nom du salon lorsqu'il contient des messages non-lus.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showUnreadDot}
                  onClick={() => setShowUnreadDot(!showUnreadDot)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                    showUnreadDot ? 'bg-accent-pink' : 'bg-bg-hover'
                  }`}
                  title="Activer ou désactiver le point de messages non-lus"
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      showUnreadDot ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
              <div className="p-4 rounded-lg border border-border bg-bg-primary/40 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-text-primary">Badge de mentions non-lues</p>
                  <p className="text-xs text-text-secondary mt-1">
                    Affiche un compteur à côté du nom du salon lorsque vous avez été mentionné et n'avez pas encore lu.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showMentionBadge}
                  onClick={() => setShowMentionBadge(!showMentionBadge)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                    showMentionBadge ? 'bg-accent-pink' : 'bg-bg-hover'
                  }`}
                  title="Activer ou désactiver le badge de mentions"
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      showMentionBadge ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          )}

          {activeSection === 'shortcuts' && (
            <div className="mt-6 space-y-3">
              <div className="p-4 rounded-lg border border-border bg-bg-primary/40 space-y-3">
                <h3 className="text-sm font-medium text-text-primary">Navigation</h3>
                <ShortcutRow keys={['Alt', '↑ / ↓']} label="Naviguer entre les salons" />
                <ShortcutRow keys={['Ctrl', 'K']} label="Rechercher un salon" />
                <ShortcutRow keys={['Ctrl', ',']} label="Ouvrir / fermer les paramètres" />
                <ShortcutRow keys={['Ctrl', 'Shift', 'M']} label="Afficher / masquer les membres" />
                <ShortcutRow keys={['Échap']} label="Fermer un panneau ouvert" />
              </div>
              <div className="p-4 rounded-lg border border-border bg-bg-primary/40 space-y-3">
                <h3 className="text-sm font-medium text-text-primary">Messages</h3>
                <ShortcutRow keys={['↑']} label="Modifier le dernier message envoyé" />
                <ShortcutRow keys={['Entrée']} label="Envoyer un message" />
                <ShortcutRow keys={['Maj', 'Entrée']} label="Saut de ligne" />
                <ShortcutRow keys={['Échap']} label="Annuler la réponse en cours" />
                <ShortcutRow keys={['Échap']} label="Annuler une modification" />
              </div>
              <div className="p-4 rounded-lg border border-border bg-bg-primary/40 space-y-3">
                <h3 className="text-sm font-medium text-text-primary">Mentions</h3>
                <ShortcutRow keys={['@']} label="Ouvrir les suggestions de membres" />
                <ShortcutRow keys={['↑ / ↓']} label="Naviguer dans les suggestions" />
                <ShortcutRow keys={['Tab', 'Entrée']} label="Sélectionner une suggestion" />
                <ShortcutRow keys={['Échap']} label="Fermer les suggestions" />
              </div>
            </div>
          )}

          {activeSection === 'account' && (
            <AccountSection />
          )}
        </div>
      </div>
    </div>
  )
}
