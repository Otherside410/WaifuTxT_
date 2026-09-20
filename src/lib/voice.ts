import {
  BaseKeyProvider,
  createKeyMaterialFromBuffer,
  Room as LivekitRoom,
  RoomEvent,
  ScreenSharePresets,
  Track,
  VideoPresets,
  type Participant,
  type RemoteTrack,
  type TrackPublication,
} from 'livekit-client'
import E2EEWorker from 'livekit-client/e2ee-worker?worker'
import { useVoiceStore, volumeKey } from '../stores/voiceStore'
import { useAuthStore } from '../stores/authStore'
import { playJoinOther, playLeaveOther } from './voiceNotifications'

// Media for voice rooms goes through LiveKit, like Element Call: MatrixRTC (in matrix.ts) announces the
// membership, the LiveKit SFU carries audio/video, and per-participant E2EE keys come from the RTC session.

let activeLivekitRoom: LivekitRoom | null = null
let activeSessionCleanup: (() => void) | null = null
let activeResolveUserId: ((identity: string) => string | null) | null = null
const remoteAudioElements = new Map<string, HTMLMediaElement>()
const remoteAudioVolumeKeys = new Map<string, string>()

// ── Local VAD (Web Audio API) ────────────────────────────────────────────────
let vadCtx: AudioContext | null = null
let vadInterval: ReturnType<typeof setInterval> | null = null
const VAD_INTERVAL_MS = 80
const VAD_THRESHOLD_DB = -48 // dB RMS — raise if too sensitive, lower if not sensitive enough

function startLocalVAD(stream: MediaStream): void {
  stopLocalVAD()
  const myUserId = useAuthStore.getState().session?.userId
  if (!myUserId) return
  try {
    vadCtx = new AudioContext()
    const src = vadCtx.createMediaStreamSource(stream)
    const analyser = vadCtx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.4
    src.connect(analyser)
    const data = new Float32Array(analyser.frequencyBinCount)
    let speaking = false
    vadInterval = setInterval(() => {
      if (useVoiceStore.getState().isMuted) {
        if (speaking) {
          speaking = false
          useVoiceStore.getState().setSpeaking(myUserId, false)
        }
        return
      }
      analyser.getFloatFrequencyData(data)
      // Compute RMS in linear scale then convert to dB
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const linear = Math.pow(10, data[i] / 20)
        sum += linear * linear
      }
      const rmsDb = 10 * Math.log10((sum / data.length) || 1e-12)
      const nowSpeaking = rmsDb > VAD_THRESHOLD_DB
      if (nowSpeaking !== speaking) {
        speaking = nowSpeaking
        useVoiceStore.getState().setSpeaking(myUserId, speaking)
      }
    }, VAD_INTERVAL_MS)
    voiceLog('startLocalVAD', { threshold: VAD_THRESHOLD_DB })
  } catch (err) {
    voiceLog('startLocalVAD failed', err)
  }
}

function stopLocalVAD(): void {
  if (vadInterval) { clearInterval(vadInterval); vadInterval = null }
  if (vadCtx) { vadCtx.close().catch(() => {}); vadCtx = null }
  const myUserId = useAuthStore.getState().session?.userId
  if (myUserId) useVoiceStore.getState().setSpeaking(myUserId, false)
}

// ── Output device helper ─────────────────────────────────────────────────────
function applyOutputDevice(el: HTMLMediaElement): void {
  const deviceId = useVoiceStore.getState().outputDeviceId
  if (!deviceId) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elAny = el as any
  if (typeof elAny.setSinkId === 'function') {
    elAny.setSinkId(deviceId).catch(() => voiceLog('setSinkId failed', { deviceId }))
  }
}

export function applyOutputDeviceToAll(): void {
  for (const el of remoteAudioElements.values()) applyOutputDevice(el)
}

function voiceLog(msg: string, extra?: unknown) {
  try {
    if (localStorage.getItem('waifutxt_debug_voice') !== '1') return
  } catch { return }
  if (extra !== undefined) console.log(`[voice] ${msg}`, extra)
  else console.log(`[voice] ${msg}`)
}

// ── E2EE key bridge (MatrixRTC → LiveKit) ────────────────────────────────────
// Same parameters as Element Call's MatrixKeyProvider so both clients derive identical frame keys.
class MatrixKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ ratchetWindowSize: 10, keyringSize: 256 })
  }

  async setMatrixKey(key: Uint8Array, keyIndex: number, participantIdentity: string): Promise<void> {
    const material = await createKeyMaterialFromBuffer(new Uint8Array(key).buffer)
    this.onSetEncryptionKey(material, participantIdentity, keyIndex)
    voiceLog('e2ee key set', { participantIdentity, keyIndex })
  }
}

// ── Remote tracks ────────────────────────────────────────────────────────────
function trackKey(participant: Participant, track: RemoteTrack): string {
  return `${participant.identity}:${track.sid ?? track.mediaStreamTrack.id}`
}

function effectiveVolume(volKey: string | undefined): number {
  const { isDeafened, volumes } = useVoiceStore.getState()
  if (isDeafened) return 0
  return volKey ? volumes[volKey] ?? 1 : 1
}

/** Re-applies deafen state and per-user volumes to every remote audio element. */
export function applyVolumes(): void {
  for (const [key, el] of remoteAudioElements) el.volume = effectiveVolume(remoteAudioVolumeKeys.get(key))
}

function attachRemoteAudio(track: RemoteTrack, participant: Participant): void {
  const key = trackKey(participant, track)
  if (remoteAudioElements.has(key)) return
  const userId = activeResolveUserId?.(participant.identity) ?? null
  const volKey = userId ? volumeKey(userId, track.source === Track.Source.ScreenShareAudio ? 'screen' : 'mic') : undefined
  const el = track.attach()
  el.setAttribute('data-voice-feed', key)
  el.style.display = 'none'
  document.body.appendChild(el)
  if (volKey) remoteAudioVolumeKeys.set(key, volKey)
  el.volume = effectiveVolume(volKey)
  applyOutputDevice(el)
  remoteAudioElements.set(key, el)
  voiceLog('playing remote audio', { identity: participant.identity, source: track.source })
}

function attachRemoteVideo(track: RemoteTrack, participant: Participant): void {
  const userId = activeResolveUserId?.(participant.identity)
  if (!userId || !track.sid) return
  useVoiceStore.getState().upsertRemoteMedia({
    id: track.sid,
    userId,
    source: track.source === Track.Source.ScreenShare ? 'screen' : 'camera',
    stream: new MediaStream([track.mediaStreamTrack]),
    muted: track.isMuted,
  })
  voiceLog('remote video', { identity: participant.identity, source: track.source })
}

function onTrackSubscribed(track: RemoteTrack, participant: Participant): void {
  if (track.kind === Track.Kind.Audio) attachRemoteAudio(track, participant)
  else if (track.kind === Track.Kind.Video) attachRemoteVideo(track, participant)
}

function onTrackUnsubscribed(track: RemoteTrack, participant: Participant): void {
  if (track.kind === Track.Kind.Video) {
    if (track.sid) useVoiceStore.getState().removeRemoteMedia(track.sid)
    return
  }
  const key = trackKey(participant, track)
  const el = remoteAudioElements.get(key)
  if (el) {
    track.detach(el)
    el.remove()
    remoteAudioElements.delete(key)
    remoteAudioVolumeKeys.delete(key)
  }
}

function onTrackMuteChanged(publication: TrackPublication, muted: boolean): void {
  if (publication.kind !== Track.Kind.Video || !publication.trackSid) return
  const store = useVoiceStore.getState()
  const media = store.remoteMedia.find((m) => m.id === publication.trackSid)
  if (media && media.muted !== muted) store.upsertRemoteMedia({ ...media, muted })
}

export interface VoiceMediaSession {
  /** MatrixRTC session of the room (matrix-js-sdk MatrixRTCSession). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rtcSession: any
  /** Maps a LiveKit participant identity to its Matrix user id. */
  resolveUserId: (identity: string) => string | null
}

/**
 * Prepares the E2EE key bridge. Must be called before joining the MatrixRTC session so that
 * no key emitted during the join is missed.
 */
export function prepareVoiceMedia(session: VoiceMediaSession, e2ee: boolean): LivekitRoom {
  cleanupVoiceStreams()
  const { inputDeviceId, outputDeviceId } = useVoiceStore.getState()

  let keyProvider: MatrixKeyProvider | null = null
  if (e2ee) {
    keyProvider = new MatrixKeyProvider()
    const onKey = (key: Uint8Array, keyIndex: number, _membership: unknown, rtcBackendIdentity: string) => {
      keyProvider?.setMatrixKey(key, keyIndex, rtcBackendIdentity).catch((err) => voiceLog('setMatrixKey failed', err))
    }
    session.rtcSession.on('encryption_key_changed', onKey)
    activeSessionCleanup = () => session.rtcSession.off('encryption_key_changed', onKey)
  }

  const room = new LivekitRoom({
    adaptiveStream: false,
    dynacast: false,
    audioCaptureDefaults: {
      deviceId: inputDeviceId ?? undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    audioOutput: outputDeviceId ? { deviceId: outputDeviceId } : undefined,
    e2ee: keyProvider ? { keyProvider, worker: new E2EEWorker() } : undefined,
  })

  activeResolveUserId = session.resolveUserId

  room
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => onTrackSubscribed(track, participant))
    .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => onTrackUnsubscribed(track, participant))
    .on(RoomEvent.TrackMuted, (pub, participant) => { if (participant !== room.localParticipant) onTrackMuteChanged(pub, true) })
    .on(RoomEvent.TrackUnmuted, (pub, participant) => { if (participant !== room.localParticipant) onTrackMuteChanged(pub, false) })
    // Covers the user stopping a screen share from the browser/OS UI.
    .on(RoomEvent.LocalTrackUnpublished, (pub) => syncLocalVideo(pub.source))
    .on(RoomEvent.ParticipantConnected, () => playJoinOther())
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      playLeaveOther()
      const userId = session.resolveUserId(participant.identity)
      if (userId) useVoiceStore.getState().setSpeaking(userId, false)
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const store = useVoiceStore.getState()
      const myUserId = useAuthStore.getState().session?.userId
      const speakingNow = new Set<string>()
      for (const p of speakers) {
        if (p === room.localParticipant) continue
        const userId = session.resolveUserId(p.identity)
        if (userId) speakingNow.add(userId)
      }
      for (const userId of store.speakingUsers) {
        if (userId !== myUserId && !speakingNow.has(userId)) store.setSpeaking(userId, false)
      }
      for (const userId of speakingNow) store.setSpeaking(userId, true)
    })
    .on(RoomEvent.EncryptionError, (err) => voiceLog('e2ee error', err))
    .on(RoomEvent.Disconnected, (reason) => voiceLog('livekit disconnected', { reason }))

  activeLivekitRoom = room
  return room
}

/** Connects the prepared LiveKit room to the SFU and publishes the microphone. */
export async function connectVoiceMedia(
  room: LivekitRoom,
  session: VoiceMediaSession,
  sfu: { url: string; jwt: string },
  e2ee: boolean,
): Promise<void> {
  if (e2ee) await room.setE2EEEnabled(true)
  await room.connect(sfu.url, sfu.jwt, { autoSubscribe: true })
  voiceLog('livekit connected', { url: sfu.url, e2ee })

  // Keys may have been received before the LiveKit room existed.
  if (e2ee) session.rtcSession.reemitEncryptionKeys?.()

  // Joining is triggered by a click, so the browser allows audio playback now.
  await room.startAudio().catch(() => voiceLog('startAudio blocked'))

  const store = useVoiceStore.getState()
  try {
    await room.localParticipant.setMicrophoneEnabled(!store.isMuted)
  } catch (err) {
    const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err)
    if (/permission|denied|not allowed|notallowed/i.test(msg)) {
      throw new Error('Accès au microphone refusé. Autorise le micro dans les paramètres de ton navigateur.')
    }
    throw err
  }
  refreshLocalStream()
}

function refreshLocalStream(): void {
  const track = activeLivekitRoom?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
  const stream = track?.mediaStream ?? null
  const store = useVoiceStore.getState()
  if (stream && stream !== store.localStream) {
    store.setLocalStream(stream)
    startLocalVAD(stream)
  }
}

export function cleanupVoiceStreams(): void {
  voiceLog('cleanupVoiceStreams')

  activeSessionCleanup?.()
  activeSessionCleanup = null
  activeResolveUserId = null

  if (activeLivekitRoom) {
    const room = activeLivekitRoom
    activeLivekitRoom = null
    room.removeAllListeners()
    room.disconnect().catch(() => {})
  }

  for (const el of remoteAudioElements.values()) {
    el.srcObject = null
    el.remove()
  }
  remoteAudioElements.clear()
  remoteAudioVolumeKeys.clear()

  stopLocalVAD()

  // LiveKit stops its own tracks on disconnect; this covers a stream left over from a failed join.
  const store = useVoiceStore.getState()
  if (store.localStream) {
    for (const track of store.localStream.getTracks()) track.stop()
  }

  stopLocalVideo()

  store.clearSpeaking()
  store.setLocalStream(null)
  for (const media of store.remoteMedia) store.removeRemoteMedia(media.id)
}

export async function setVoiceMuted(muted: boolean): Promise<void> {
  useVoiceStore.getState().setMuted(muted)
  if (!activeLivekitRoom) return
  try {
    await activeLivekitRoom.localParticipant.setMicrophoneEnabled(!muted)
    refreshLocalStream()
    voiceLog('setMicrophoneEnabled', { enabled: !muted })
  } catch (err) {
    voiceLog('setMicrophoneEnabled failed', err)
  }
}

export function setVoiceDeafened(deafened: boolean): void {
  useVoiceStore.getState().setDeafened(deafened)
  applyVolumes()
  voiceLog('setVoiceDeafened', { deafened })
}

/** Sets the playback volume (0–1) of a user's microphone or screen share audio. */
export function setUserVolume(userId: string, source: 'mic' | 'screen', volume: number): void {
  useVoiceStore.getState().setVolume(volumeKey(userId, source), volume)
  applyVolumes()
}

export function getActiveLivekitRoom(): LivekitRoom | null {
  return activeLivekitRoom
}

// ── Camera / screen share ────────────────────────────────────────────────────

function publishedVideoStream(source: Track.Source): MediaStream | null {
  const pub = activeLivekitRoom?.localParticipant.getTrackPublication(source)
  const track = pub?.track
  if (!track || pub.isMuted || track.mediaStreamTrack.readyState === 'ended') return null
  return new MediaStream([track.mediaStreamTrack])
}

/** Mirrors the local camera / screen share publications into the voice store. */
function syncLocalVideo(source?: Track.Source): void {
  const store = useVoiceStore.getState()
  if (source === undefined || source === Track.Source.Camera) {
    const stream = publishedVideoStream(Track.Source.Camera)
    store.setLocalCameraStream(stream)
    store.setCameraOn(!!stream)
  }
  if (source === undefined || source === Track.Source.ScreenShare) {
    const stream = publishedVideoStream(Track.Source.ScreenShare)
    store.setLocalScreenStream(stream)
    store.setScreenSharing(!!stream)
  }
}

function requireActiveRoom(): LivekitRoom {
  if (!activeLivekitRoom) throw new Error('Rejoins un salon vocal pour activer la vidéo.')
  return activeLivekitRoom
}

export async function toggleCamera(): Promise<void> {
  const room = requireActiveRoom()
  const enable = !useVoiceStore.getState().isCameraOn
  try {
    await room.localParticipant.setCameraEnabled(enable, {
      resolution: VideoPresets.h720.resolution,
    })
  } catch (err) {
    voiceLog('toggleCamera failed', err)
    throw err
  } finally {
    syncLocalVideo(Track.Source.Camera)
  }
}

export async function toggleScreenShare(): Promise<void> {
  const room = requireActiveRoom()
  const enable = !useVoiceStore.getState().isScreenSharing
  try {
    await room.localParticipant.setScreenShareEnabled(
      enable,
      {
        audio: true,
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        resolution: ScreenSharePresets.h1080fps30.resolution,
      },
      { screenShareEncoding: ScreenSharePresets.h1080fps30.encoding },
    )
  } catch (err) {
    // Cancelling the picker is not an error worth surfacing.
    if (err instanceof Error && err.name === 'NotAllowedError') voiceLog('screen share cancelled')
    else {
      voiceLog('toggleScreenShare failed', err)
      throw err
    }
  } finally {
    syncLocalVideo(Track.Source.ScreenShare)
  }
}

export function stopLocalVideo(): void {
  const room = activeLivekitRoom
  if (room) {
    room.localParticipant.setCameraEnabled(false).catch(() => {})
    room.localParticipant.setScreenShareEnabled(false).catch(() => {})
  }
  const store = useVoiceStore.getState()
  store.setCameraOn(false)
  store.setScreenSharing(false)
  store.setLocalCameraStream(null)
  store.setLocalScreenStream(null)
}
