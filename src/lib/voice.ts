import {
  BaseKeyProvider,
  createKeyMaterialFromBuffer,
  Room as LivekitRoom,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
} from 'livekit-client'
import E2EEWorker from 'livekit-client/e2ee-worker?worker'
import { useVoiceStore } from '../stores/voiceStore'
import { useAuthStore } from '../stores/authStore'
import { playJoinOther, playLeaveOther } from './voiceNotifications'

// Media for voice rooms goes through LiveKit, like Element Call: MatrixRTC (in matrix.ts) announces the
// membership, the LiveKit SFU carries the audio, and per-participant E2EE keys come from the RTC session.

let activeLivekitRoom: LivekitRoom | null = null
let activeSessionCleanup: (() => void) | null = null
const remoteAudioElements = new Map<string, HTMLMediaElement>()
let localCameraStream: MediaStream | null = null
let localScreenStream: MediaStream | null = null

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

// ── Remote audio ─────────────────────────────────────────────────────────────
function trackKey(participant: Participant, track: RemoteTrack): string {
  return `${participant.identity}:${track.sid ?? track.mediaStreamTrack.id}`
}

function attachRemoteAudio(track: RemoteTrack, participant: Participant): void {
  if (track.kind !== Track.Kind.Audio) return
  const key = trackKey(participant, track)
  if (remoteAudioElements.has(key)) return
  const el = track.attach()
  el.setAttribute('data-voice-feed', key)
  el.style.display = 'none'
  document.body.appendChild(el)
  el.volume = useVoiceStore.getState().isDeafened ? 0 : 1
  applyOutputDevice(el)
  remoteAudioElements.set(key, el)
  voiceLog('playing remote audio', { identity: participant.identity })
}

function detachRemoteAudio(track: RemoteTrack, participant: Participant): void {
  const key = trackKey(participant, track)
  const el = remoteAudioElements.get(key)
  if (el) {
    track.detach(el)
    el.remove()
    remoteAudioElements.delete(key)
  }
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

  room
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => attachRemoteAudio(track, participant))
    .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => detachRemoteAudio(track, participant))
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

  stopLocalVAD()

  // LiveKit stops its own tracks on disconnect; this covers a stream left over from a failed join.
  const store = useVoiceStore.getState()
  if (store.localStream) {
    for (const track of store.localStream.getTracks()) track.stop()
  }

  stopLocalVideo()

  store.clearSpeaking()
  store.setLocalStream(null)
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
  for (const el of remoteAudioElements.values()) {
    el.volume = deafened ? 0 : 1
  }
  voiceLog('setVoiceDeafened', { deafened })
}

export function getActiveLivekitRoom(): LivekitRoom | null {
  return activeLivekitRoom
}

export async function toggleCamera(): Promise<void> {
  const store = useVoiceStore.getState()
  if (store.isCameraOn) {
    if (localCameraStream) {
      for (const track of localCameraStream.getTracks()) track.stop()
      localCameraStream = null
    }
    store.setCameraOn(false)
    store.setLocalVideoStream(localScreenStream)
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (localScreenStream) {
        for (const track of localScreenStream.getTracks()) track.stop()
        localScreenStream = null
        store.setScreenSharing(false)
      }
      localCameraStream = stream
      store.setCameraOn(true)
      store.setLocalVideoStream(stream)
    } catch (err) {
      voiceLog('toggleCamera: getUserMedia failed', err)
      throw err
    }
  }
}

export async function toggleScreenShare(): Promise<void> {
  const store = useVoiceStore.getState()
  if (store.isScreenSharing) {
    if (localScreenStream) {
      for (const track of localScreenStream.getTracks()) track.stop()
      localScreenStream = null
    }
    store.setScreenSharing(false)
    store.setLocalVideoStream(localCameraStream)
  } else {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      if (localCameraStream) {
        for (const track of localCameraStream.getTracks()) track.stop()
        localCameraStream = null
        store.setCameraOn(false)
      }
      localScreenStream = stream
      store.setScreenSharing(true)
      store.setLocalVideoStream(stream)
      // Handle user stopping share via browser UI
      stream.getTracks()[0].addEventListener('ended', () => {
        localScreenStream = null
        useVoiceStore.getState().setScreenSharing(false)
        useVoiceStore.getState().setLocalVideoStream(null)
      })
    } catch (err) {
      voiceLog('toggleScreenShare: getDisplayMedia failed', err)
      throw err
    }
  }
}

export function stopLocalVideo(): void {
  if (localCameraStream) {
    for (const track of localCameraStream.getTracks()) track.stop()
    localCameraStream = null
  }
  if (localScreenStream) {
    for (const track of localScreenStream.getTracks()) track.stop()
    localScreenStream = null
  }
  const store = useVoiceStore.getState()
  store.setCameraOn(false)
  store.setScreenSharing(false)
  store.setLocalVideoStream(null)
}
