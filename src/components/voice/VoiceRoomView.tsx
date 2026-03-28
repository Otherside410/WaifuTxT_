import { useEffect, useRef, useCallback, useState } from 'react'
import { useRoomStore } from '../../stores/roomStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { useAuthStore } from '../../stores/authStore'
import { joinVoiceRoom, leaveVoiceRoom, getOwnAvatarUrl, getUserProfileBasics } from '../../lib/matrix'
import { setVoiceMuted, setVoiceDeafened, toggleCamera, toggleScreenShare } from '../../lib/voice'
import { Avatar } from '../common/Avatar'
import { RoomHeader } from '../chat/RoomHeader'
import type { RoomSummary } from '../../types/matrix'

// ── Local video preview element ───────────────────────────────────────────────

function LocalVideoPreview({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream
    }
  }, [stream])

  return (
    <video
      ref={ref}
      autoPlay
      muted
      playsInline
      className="w-full h-full object-cover rounded-2xl"
    />
  )
}

// ── Single participant tile ───────────────────────────────────────────────────

interface ParticipantTileProps {
  userId: string
  displayName: string
  avatarUrl: string | null
  isSpeaking: boolean
  isSelf?: boolean
  localVideoStream?: MediaStream | null
  isScreenSharing?: boolean
  isMuted?: boolean
}

function ParticipantTile({
  userId,
  displayName,
  avatarUrl,
  isSpeaking,
  isSelf,
  localVideoStream,
  isScreenSharing,
  isMuted,
}: ParticipantTileProps) {
  const showVideo = isSelf && !!localVideoStream

  return (
    <div className="flex flex-col items-center gap-3 select-none">
      {/* Avatar / video wrapper */}
      <div
        className={[
          'relative flex items-center justify-center rounded-2xl overflow-hidden',
          'transition-all duration-200',
          showVideo ? 'w-48 h-36' : 'w-24 h-24',
          isSpeaking
            ? 'ring-4 ring-accent-pink shadow-[0_0_20px_4px_rgba(255,45,120,0.45)]'
            : 'ring-2 ring-border',
        ].join(' ')}
      >
        {showVideo ? (
          <LocalVideoPreview stream={localVideoStream} />
        ) : (
          <Avatar
            src={avatarUrl}
            name={displayName || userId}
            size={96}
            shape="rounded"
          />
        )}

        {/* Screen share badge */}
        {isSelf && isScreenSharing && (
          <div className="absolute bottom-1.5 right-1.5 bg-bg-primary/80 rounded px-1.5 py-0.5 flex items-center gap-1">
            <svg className="w-3 h-3 text-info" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8M12 17v4" />
            </svg>
            <span className="text-[10px] text-info font-medium">Partage</span>
          </div>
        )}

        {/* Muted badge */}
        {isMuted && (
          <div className="absolute bottom-1.5 left-1.5 bg-danger/90 rounded-full p-1">
            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <line x1="2" y1="2" x2="22" y2="22" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.89 13.23A7.12 7.12 0 0019 12v-2M5 10v2a7 7 0 0012 4.9M15 9.34V5a3 3 0 00-5.94-.6M9 9v3a3 3 0 005.12 2.12" />
            </svg>
          </div>
        )}
      </div>

      {/* Name */}
      <span className="text-sm font-medium text-text-primary truncate max-w-[10rem] text-center">
        {displayName || userId.split(':')[0]?.replace('@', '') || userId}
        {isSelf && <span className="ml-1 text-xs text-text-muted">(vous)</span>}
      </span>
    </div>
  )
}

// ── Control button ────────────────────────────────────────────────────────────

interface ControlBtnProps {
  label: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}

function ControlBtn({ label, active = true, danger, disabled, onClick, children }: ControlBtnProps) {
  return (
    <button
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex flex-col items-center gap-1.5 px-3 py-2 rounded-xl transition-all duration-150 cursor-pointer',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        danger
          ? 'bg-danger/20 hover:bg-danger/40 text-danger'
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
  const localVideoStream = useVoiceStore((s) => s.localVideoStream)

  const room = activeRoomId ? rooms.get(activeRoomId) : null
  const isJoined = !!activeRoomId && joinedRoomId === activeRoomId
  const myUserId = session?.userId ?? ''

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

  const handleJoin = useCallback(async () => {
    if (!activeRoomId) return
    try { await joinVoiceRoom(activeRoomId) } catch (err) { console.error('[voice] join failed', err) }
  }, [activeRoomId])

  const handleLeave = useCallback(async () => {
    if (!activeRoomId) return
    try { await leaveVoiceRoom(activeRoomId) } catch (err) { console.error('[voice] leave failed', err) }
  }, [activeRoomId])

  const handleToggleMic = useCallback(() => {
    void setVoiceMuted(!isMuted)
  }, [isMuted])

  const handleToggleDeafen = useCallback(() => {
    setVoiceDeafened(!isDeafened)
  }, [isDeafened])

  const handleToggleCamera = useCallback(async () => {
    try { await toggleCamera() } catch (err) { console.error('[voice] camera toggle failed', err) }
  }, [])

  const handleToggleScreenShare = useCallback(async () => {
    try { await toggleScreenShare() } catch (err) { console.error('[voice] screenshare toggle failed', err) }
  }, [])

  if (!room) return null

  // Participants from room state, excluding self
  const otherParticipants = (room.voiceParticipants ?? [])
    .filter((p) => p.userId !== myUserId)
    .map((p) => ({
      ...p,
      avatarUrl: p.avatarUrl || extraProfiles[p.userId]?.avatarUrl || null,
      displayName: p.displayName || extraProfiles[p.userId]?.displayName || p.userId,
    }))

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      <RoomHeader />

      {isJoined ? (
        <>
          {/* Participant grid */}
          <div className="flex-1 flex flex-wrap content-center items-center justify-center gap-8 p-8 overflow-auto">
            {/* Self tile */}
            <ParticipantTile
              userId={myUserId}
              displayName={session?.userId?.split(':')[0]?.replace('@', '') ?? 'Moi'}
              avatarUrl={ownAvatarUrl}
              isSpeaking={speakingUsers.has(myUserId)}
              isSelf
              localVideoStream={localVideoStream}
              isScreenSharing={isScreenSharing}
              isMuted={isMuted}
            />

            {/* Other participants */}
            {otherParticipants.map((p) => (
              <ParticipantTile
                key={p.userId}
                userId={p.userId}
                displayName={p.displayName}
                avatarUrl={p.avatarUrl}
                isSpeaking={speakingUsers.has(p.userId)}
              />
            ))}

            {otherParticipants.length === 0 && (
              <p className="text-sm text-text-muted">Personne d&apos;autre pour l&apos;instant...</p>
            )}
          </div>

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

            <ControlBtn label={isCameraOn ? 'Caméra on' : 'Caméra'} active={isCameraOn} onClick={handleToggleCamera}>
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

            <ControlBtn label={isScreenSharing ? 'Partage on' : 'Partager'} active={isScreenSharing} onClick={handleToggleScreenShare}>
              <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="w-6 h-6">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8M12 17v4" />
                {isScreenSharing && <path strokeLinecap="round" strokeLinejoin="round" d="M9 10l2 2 4-4" />}
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
