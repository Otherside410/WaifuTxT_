import { useEffect, useRef, useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { useVoiceStore, volumeKey } from '../../stores/voiceStore'
import { useAuthStore } from '../../stores/authStore'
import { joinVoiceRoom, leaveVoiceRoom, getOwnAvatarUrl, getUserProfileBasics } from '../../lib/matrix'
import { setVoiceMuted, setVoiceDeafened, setUserVolume, toggleCamera, toggleScreenShare } from '../../lib/voice'
import { Avatar } from '../common/Avatar'
import { RoomHeader } from '../chat/RoomHeader'
import type { RoomSummary } from '../../types/matrix'

// ── Tile model ────────────────────────────────────────────────────────────────

interface TileModel {
  id: string
  userId: string
  displayName: string
  avatarUrl: string | null
  kind: 'user' | 'screen'
  stream: MediaStream | null
  isSelf: boolean
  isSpeaking: boolean
  isMuted?: boolean
  /** Remote tiles only: which audio this tile's volume slider controls. */
  volumeSource?: 'mic' | 'screen'
}

// ── Video element ─────────────────────────────────────────────────────────────

function StreamVideo({
  stream,
  videoRef,
  mirrored,
  fit,
}: {
  stream: MediaStream
  videoRef: React.RefObject<HTMLVideoElement | null>
  mirrored: boolean
  fit: 'cover' | 'contain'
}) {
  useEffect(() => {
    const el = videoRef.current
    if (el && el.srcObject !== stream) el.srcObject = stream
  }, [stream, videoRef])

  // Audio is played by separate elements (see lib/voice.ts), so the video itself stays muted.
  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className={[
        'w-full h-full bg-black',
        fit === 'cover' ? 'object-cover' : 'object-contain',
        mirrored ? '-scale-x-100' : '',
      ].join(' ')}
    />
  )
}

// ── Tile toolbar button ───────────────────────────────────────────────────────

function TileBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="w-7 h-7 flex items-center justify-center rounded-md bg-bg-primary/80 backdrop-blur-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent-pink"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">{children}</svg>
    </button>
  )
}

// ── Media tile (participant or screen share) ──────────────────────────────────

function MediaTile({
  tile,
  pinned,
  compact,
  onTogglePin,
}: {
  tile: TileModel
  pinned: boolean
  compact: boolean
  onTogglePin: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isPip, setIsPip] = useState(false)
  const volume = useVoiceStore((s) =>
    tile.volumeSource ? s.volumes[volumeKey(tile.userId, tile.volumeSource)] ?? 1 : 1,
  )

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const onEnter = () => setIsPip(true)
    const onLeave = () => setIsPip(false)
    el.addEventListener('enterpictureinpicture', onEnter)
    el.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      el.removeEventListener('enterpictureinpicture', onEnter)
      el.removeEventListener('leavepictureinpicture', onLeave)
    }
  }, [tile.stream])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    } else {
      void containerRef.current?.requestFullscreen().catch((err) => console.error('[voice] fullscreen failed', err))
    }
  }, [])

  const togglePip = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (document.pictureInPictureElement === el) {
      void document.exitPictureInPicture().catch(() => {})
    } else {
      void el.requestPictureInPicture().catch((err) => console.error('[voice] PiP failed', err))
    }
  }, [])

  const hasVideo = !!tile.stream
  const canPip = hasVideo && typeof document !== 'undefined' && document.pictureInPictureEnabled
  const isScreen = tile.kind === 'screen'
  const label = isScreen ? (tile.isSelf ? 'Ton écran' : `Écran de ${tile.displayName}`) : tile.displayName

  const onDoubleClick = (e: ReactMouseEvent) => {
    e.stopPropagation()
    if (hasVideo) toggleFullscreen()
  }

  return (
    <div
      ref={containerRef}
      onClick={onTogglePin}
      onDoubleClick={onDoubleClick}
      className={[
        'group relative w-full h-full overflow-hidden bg-bg-secondary select-none cursor-pointer',
        isFullscreen ? '' : 'rounded-xl',
        tile.isSpeaking && !isScreen
          ? 'ring-4 ring-accent-pink shadow-[0_0_20px_4px_var(--color-accent-pink-dim)]'
          : 'ring-1 ring-border',
        'transition-shadow duration-200',
      ].join(' ')}
    >
      {hasVideo && tile.stream ? (
        <StreamVideo
          stream={tile.stream}
          videoRef={videoRef}
          mirrored={tile.isSelf && !isScreen}
          fit={isScreen || pinned || isFullscreen ? 'contain' : 'cover'}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Avatar
            src={tile.avatarUrl}
            name={tile.displayName || tile.userId}
            size={compact ? 40 : 88}
            shape="rounded"
          />
        </div>
      )}

      {isPip && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-secondary/90 text-xs text-text-secondary">
          Lecture en image dans l&apos;image
        </div>
      )}

      {/* Own screen share: make the broadcast state explicit and stoppable from the tile */}
      {tile.isSelf && isScreen && !compact && (
        <div
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute top-1.5 left-1.5 flex items-center gap-2 bg-bg-primary/80 backdrop-blur-sm rounded-md pl-2 pr-1 py-1 border border-accent-pink/40"
        >
          <span className="w-2 h-2 rounded-full bg-accent-pink" aria-hidden />
          <span className="text-xs font-medium text-text-primary">Tu partages ton écran</span>
          <button
            onClick={() => { void toggleScreenShare().catch((err) => console.error('[voice] stop share failed', err)) }}
            className="px-2 py-0.5 rounded bg-danger/20 hover:bg-danger/40 text-danger text-xs font-medium cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent-pink"
          >
            Arrêter
          </button>
        </div>
      )}

      {/* Name / status */}
      <div className="absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] flex items-center gap-1 bg-bg-primary/80 backdrop-blur-sm rounded-md px-1.5 py-0.5">
        {tile.isMuted && (
          <svg className="w-3 h-3 shrink-0 text-danger" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <line x1="2" y1="2" x2="22" y2="22" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.89 13.23A7.12 7.12 0 0019 12v-2M5 10v2a7 7 0 0012 4.9M15 9.34V5a3 3 0 00-5.94-.6M9 9v3a3 3 0 005.12 2.12" />
          </svg>
        )}
        {isScreen && (
          <svg className="w-3 h-3 shrink-0 text-info" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8M12 17v4" />
          </svg>
        )}
        <span className={`${compact ? 'text-[10px]' : 'text-xs'} font-medium text-text-primary truncate`}>
          {label}
          {tile.isSelf && !isScreen && <span className="ml-1 text-text-muted">(vous)</span>}
        </span>
      </div>

      {/* Hover toolbar */}
      {!compact && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <TileBtn label={pinned ? 'Désépingler' : 'Épingler'} onClick={onTogglePin}>
            {pinned ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4h6v5l3 4H6l3-4zM12 13v8M3 3l18 18" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4h6v5l3 4H6l3-4zM12 13v8" />
            )}
          </TileBtn>
          {canPip && (
            <TileBtn label={isPip ? 'Quitter l\'image dans l\'image' : 'Image dans l\'image'} onClick={togglePip}>
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <rect x="12" y="11" width="7" height="6" rx="1" />
            </TileBtn>
          )}
          {hasVideo && (
            <TileBtn label={isFullscreen ? 'Quitter le plein écran' : 'Plein écran'} onClick={toggleFullscreen}>
              {isFullscreen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
              )}
            </TileBtn>
          )}
        </div>
      )}

      {/* Volume */}
      {!compact && tile.volumeSource && (
        <div
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute bottom-1.5 right-1.5 flex items-center gap-1.5 bg-bg-primary/80 backdrop-blur-sm rounded-md px-1.5 py-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
        >
          <button
            title={volume === 0 ? 'Rétablir le son' : 'Couper le son'}
            aria-label={volume === 0 ? 'Rétablir le son' : 'Couper le son'}
            onClick={() => setUserVolume(tile.userId, tile.volumeSource!, volume === 0 ? 1 : 0)}
            className="text-text-secondary hover:text-text-primary cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-accent-pink"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5L6 9H2v6h4l5 4V5z" />
              {volume === 0 ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M23 9l-6 6M17 9l6 6" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" />
              )}
            </svg>
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(volume * 100)}
            onChange={(e) => setUserVolume(tile.userId, tile.volumeSource!, Number(e.target.value) / 100)}
            aria-label={`Volume de ${label}`}
            className="w-20 accent-accent-pink cursor-pointer"
          />
          <span className="w-8 text-right text-[10px] tabular-nums text-text-secondary">{Math.round(volume * 100)}%</span>
        </div>
      )}
    </div>
  )
}

// ── Tile layouts ──────────────────────────────────────────────────────────────

function TileGrid({ tiles, onTogglePin }: { tiles: TileModel[]; onTogglePin: (id: string) => void }) {
  const cols = tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : tiles.length <= 9 ? 3 : 4
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-4 sm:p-6 overflow-auto">
      <div
        className="grid gap-3 w-full max-w-6xl"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {tiles.map((t) => (
          <div key={t.id} className="aspect-video">
            <MediaTile tile={t} pinned={false} compact={false} onTogglePin={() => onTogglePin(t.id)} />
          </div>
        ))}
      </div>
    </div>
  )
}

function StageLayout({
  pinned,
  others,
  onTogglePin,
}: {
  pinned: TileModel
  others: TileModel[]
  onTogglePin: (id: string) => void
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 p-3 sm:p-4">
      <div className="flex-1 min-h-0">
        <MediaTile tile={pinned} pinned compact={false} onTogglePin={() => onTogglePin(pinned.id)} />
      </div>
      {others.length > 0 && (
        <div className="shrink-0 flex gap-2 overflow-x-auto p-1.5">
          {others.map((t) => (
            <div key={t.id} className="shrink-0 h-24 aspect-video">
              <MediaTile tile={t} pinned={false} compact onTogglePin={() => onTogglePin(t.id)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Control button ────────────────────────────────────────────────────────────

interface ControlBtnProps {
  label: string
  /** Tooltip describing what a click does; defaults to the label. */
  title?: string
  active?: boolean
  danger?: boolean
  /**
   * Broadcast toggles (camera, screen share) are neutral when off and use the accent while
   * something is being sent. Mic/sound keep the red "off" state since muting is the unusual case.
   */
  broadcast?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}

function ControlBtn({ label, title, active = true, danger, broadcast, disabled, onClick, children }: ControlBtnProps) {
  return (
    <button
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={danger ? undefined : broadcast ? active : !active}
      className={[
        'flex flex-col items-center gap-1.5 min-w-14 px-3 py-2 rounded-xl transition-colors duration-150 cursor-pointer',
        'outline-none focus-visible:ring-2 focus-visible:ring-accent-pink',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        danger
          ? 'bg-danger/20 hover:bg-danger/40 text-danger'
          : broadcast
          ? active
            ? 'bg-accent-pink-dim hover:bg-accent-pink/30 text-accent-pink'
            : 'bg-bg-hover hover:bg-bg-active text-text-primary'
          : active
          ? 'bg-bg-hover hover:bg-bg-active text-text-primary'
          : 'bg-danger/15 hover:bg-danger/30 text-danger',
      ].join(' ')}
    >
      <div className="w-6 h-6">{children}</div>
      <span className="text-[10px] font-medium leading-none">{label}</span>
    </button>
  )
}

// ── Join overlay (not yet in the call) ───────────────────────────────────────

function JoinOverlay({ room, onJoin }: { room: RoomSummary; onJoin: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3">
        <div className="w-16 h-16 rounded-2xl bg-bg-secondary flex items-center justify-center">
          <svg className="w-8 h-8 text-text-muted" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-text-primary">{room.name}</h3>
        <p className="text-sm text-text-muted">Salon vocal</p>
      </div>

      {room.voiceParticipants && room.voiceParticipants.length > 0 && (
        <div className="flex -space-x-2">
          {room.voiceParticipants.slice(0, 5).map((p) => (
            <div key={p.userId} title={p.displayName} className="ring-2 ring-bg-primary rounded-full">
              <Avatar src={p.avatarUrl} name={p.displayName || p.userId} size={32} shape="circle" />
            </div>
          ))}
          {room.voiceParticipants.length > 5 && (
            <div className="w-8 h-8 rounded-full bg-bg-tertiary ring-2 ring-bg-primary flex items-center justify-center">
              <span className="text-[10px] text-text-muted">+{room.voiceParticipants.length - 5}</span>
            </div>
          )}
        </div>
      )}

      <button
        onClick={onJoin}
        className="flex items-center gap-2 px-6 py-2.5 bg-success/20 hover:bg-success/30 text-success font-semibold rounded-xl transition-colors cursor-pointer"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
        </svg>
        Rejoindre le vocal
      </button>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function VoiceRoomView() {
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const rooms = useRoomStore((s) => s.rooms)
  const session = useAuthStore((s) => s.session)

  const joinedRoomId = useVoiceStore((s) => s.joinedRoomId)
  const isMuted = useVoiceStore((s) => s.isMuted)
  const isDeafened = useVoiceStore((s) => s.isDeafened)
  const isCameraOn = useVoiceStore((s) => s.isCameraOn)
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing)
  const speakingUsers = useVoiceStore((s) => s.speakingUsers)
  const localCameraStream = useVoiceStore((s) => s.localCameraStream)
  const localScreenStream = useVoiceStore((s) => s.localScreenStream)
  const remoteMedia = useVoiceStore((s) => s.remoteMedia)

  const room = activeRoomId ? rooms.get(activeRoomId) : null
  const isJoined = !!activeRoomId && joinedRoomId === activeRoomId
  const myUserId = session?.userId ?? ''

  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)

  // Own avatar
  const [ownAvatarUrl, setOwnAvatarUrl] = useState<string | null>(() => getOwnAvatarUrl())
  useEffect(() => {
    const url = getOwnAvatarUrl()
    if (url) setOwnAvatarUrl(url)
  }, [rooms])

  // Fetch missing participant avatars
  const [extraProfiles, setExtraProfiles] = useState<Record<string, { displayName: string | null; avatarUrl: string | null }>>({})
  useEffect(() => {
    if (!room) return
    const missing = (room.voiceParticipants ?? []).filter((p) => p.userId !== myUserId && !p.avatarUrl && !(p.userId in extraProfiles))
    if (!missing.length) return
    let cancelled = false
    Promise.all(
      missing.map(async (p) => ({ userId: p.userId, profile: await getUserProfileBasics(p.userId, 64) }))
    ).then((items) => {
      if (cancelled) return
      setExtraProfiles((prev) => {
        const next = { ...prev }
        for (const i of items) next[i.userId] = i.profile
        return next
      })
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [room, myUserId, extraProfiles])

  useEffect(() => {
    if (!mediaError) return
    const t = setTimeout(() => setMediaError(null), 6000)
    return () => clearTimeout(t)
  }, [mediaError])

  const handleJoin = useCallback(async () => {
    if (!activeRoomId) return
    try { await joinVoiceRoom(activeRoomId) } catch (err) { console.error('[voice] join failed', err) }
  }, [activeRoomId])

  const handleLeave = useCallback(async () => {
    if (!activeRoomId) return
    setPinnedId(null)
    try { await leaveVoiceRoom(activeRoomId) } catch (err) { console.error('[voice] leave failed', err) }
  }, [activeRoomId])

  const handleToggleMic = useCallback(() => {
    void setVoiceMuted(!isMuted)
  }, [isMuted])

  const handleToggleDeafen = useCallback(() => {
    setVoiceDeafened(!isDeafened)
  }, [isDeafened])

  const handleToggleCamera = useCallback(async () => {
    try {
      await toggleCamera()
    } catch (err) {
      console.error('[voice] camera toggle failed', err)
      setMediaError(err instanceof Error && err.name === 'NotAllowedError'
        ? 'Accès à la caméra refusé.'
        : 'Impossible d\'activer la caméra.')
    }
  }, [])

  const handleToggleScreenShare = useCallback(async () => {
    try {
      await toggleScreenShare()
    } catch (err) {
      console.error('[voice] screenshare toggle failed', err)
      setMediaError('Impossible de partager l\'écran.')
    }
  }, [])

  const handleTogglePin = useCallback((id: string) => {
    setPinnedId((prev) => (prev === id ? null : id))
  }, [])

  if (!room) return null

  // Participants from room state, excluding self
  const participantById = new Map<string, { displayName: string; avatarUrl: string | null }>()
  for (const p of room.voiceParticipants ?? []) {
    if (p.userId === myUserId) continue
    participantById.set(p.userId, {
      avatarUrl: p.avatarUrl || extraProfiles[p.userId]?.avatarUrl || null,
      displayName: p.displayName || extraProfiles[p.userId]?.displayName || p.userId,
    })
  }
  // Someone may publish media before their membership shows up in room state.
  for (const m of remoteMedia) {
    if (m.userId !== myUserId && !participantById.has(m.userId)) {
      participantById.set(m.userId, { displayName: m.userId, avatarUrl: null })
    }
  }

  const myName = session?.userId?.split(':')[0]?.replace('@', '') ?? 'Moi'
  const tiles: TileModel[] = [
    {
      id: 'self',
      userId: myUserId,
      displayName: myName,
      avatarUrl: ownAvatarUrl,
      kind: 'user',
      stream: localCameraStream,
      isSelf: true,
      isSpeaking: speakingUsers.has(myUserId),
      isMuted,
    },
  ]
  if (localScreenStream) {
    tiles.push({
      id: 'self:screen',
      userId: myUserId,
      displayName: myName,
      avatarUrl: ownAvatarUrl,
      kind: 'screen',
      stream: localScreenStream,
      isSelf: true,
      isSpeaking: false,
    })
  }
  for (const [userId, p] of participantById) {
    const camera = remoteMedia.find((m) => m.userId === userId && m.source === 'camera' && !m.muted)
    tiles.push({
      id: `user:${userId}`,
      userId,
      displayName: p.displayName,
      avatarUrl: p.avatarUrl,
      kind: 'user',
      stream: camera?.stream ?? null,
      isSelf: false,
      isSpeaking: speakingUsers.has(userId),
      volumeSource: 'mic',
    })
  }
  for (const m of remoteMedia) {
    if (m.source !== 'screen' || m.muted) continue
    const p = participantById.get(m.userId)
    tiles.push({
      id: `screen:${m.id}`,
      userId: m.userId,
      displayName: p?.displayName ?? m.userId,
      avatarUrl: p?.avatarUrl ?? null,
      kind: 'screen',
      stream: m.stream,
      isSelf: false,
      isSpeaking: false,
      volumeSource: 'screen',
    })
  }

  const pinnedTile = pinnedId ? tiles.find((t) => t.id === pinnedId) ?? null : null

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      <RoomHeader />

      {isJoined ? (
        <>
          {pinnedTile ? (
            <StageLayout
              pinned={pinnedTile}
              others={tiles.filter((t) => t.id !== pinnedTile.id)}
              onTogglePin={handleTogglePin}
            />
          ) : (
            <TileGrid tiles={tiles} onTogglePin={handleTogglePin} />
          )}

          {participantById.size === 0 && (
            <p className="shrink-0 pb-3 text-center text-sm text-text-muted">Personne d&apos;autre pour l&apos;instant...</p>
          )}

          {mediaError && (
            <div role="alert" className="shrink-0 mx-auto mb-2 px-3 py-1.5 rounded-lg bg-danger/15 text-danger text-sm">
              {mediaError}
            </div>
          )}

          {/* Control bar */}
          <div className="shrink-0 flex items-center justify-center gap-2 px-6 py-4 bg-bg-secondary border-t border-border">
            <ControlBtn label={isMuted ? 'Micro coupé' : 'Micro'} active={!isMuted} onClick={handleToggleMic}>
              {isMuted ? (
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-6 h-6">
                  <line x1="2" y1="2" x2="22" y2="22" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.89 13.23A7.12 7.12 0 0019 12v-2M5 10v2a7 7 0 0012 4.9M15 9.34V5a3 3 0 00-5.94-.6M9 9v3a3 3 0 005.12 2.12" />
                </svg>
              ) : (
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-6 h-6">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
                </svg>
              )}
            </ControlBtn>

            <ControlBtn label={isDeafened ? 'Son coupé' : 'Son'} active={!isDeafened} onClick={handleToggleDeafen}>
              {isDeafened ? (
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-6 h-6">
                  <line x1="2" y1="2" x2="22" y2="22" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 5.464A5 5 0 0119 10v4M5 10v4a7 7 0 0011.9 5.1M3 3l18 18" />
                </svg>
              ) : (
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-6 h-6">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 5.05a9 9 0 010 13.9M6.343 6.343A8 8 0 1017.657 17.657" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </ControlBtn>

            <ControlBtn
              label="Caméra"
              title={isCameraOn ? 'Couper la caméra' : 'Activer la caméra'}
              active={isCameraOn}
              broadcast
              onClick={handleToggleCamera}
            >
              {isCameraOn ? (
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-6 h-6">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.361a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                </svg>
              ) : (
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-6 h-6">
                  <line x1="2" y1="2" x2="22" y2="22" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.68 5H17a2 2 0 012 2v6.34l1 1 .553-.276A1 1 0 0122 13.82V8.18a1 1 0 00-1.447-.894L16 9.5M3 8a2 2 0 00-2 2v6a2 2 0 002 2h10.5" />
                </svg>
              )}
            </ControlBtn>

            <ControlBtn
              label="Écran"
              title={isScreenSharing ? 'Arrêter le partage d\'écran' : 'Partager ton écran'}
              active={isScreenSharing}
              broadcast
              onClick={handleToggleScreenShare}
            >
              <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-6 h-6">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8M12 17v4" />
                {isScreenSharing
                  ? <path strokeLinecap="round" strokeLinejoin="round" d="M9 8l6 4-6 4V8z" />
                  : <path strokeLinecap="round" strokeLinejoin="round" d="M12 14V7M9 10l3-3 3 3" />}
              </svg>
            </ControlBtn>

            <div className="w-px h-8 bg-border mx-1" />

            <ControlBtn label="Quitter" danger onClick={handleLeave}>
              <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
              </svg>
            </ControlBtn>
          </div>
        </>
      ) : (
        <JoinOverlay room={room} onJoin={handleJoin} />
      )}
    </div>
  )
}
