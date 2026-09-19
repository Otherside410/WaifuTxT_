import { create } from 'zustand'

const LS_INPUT = 'waifutxt_audio_input_device'
const LS_OUTPUT = 'waifutxt_audio_output_device'
const LS_VOLUMES = 'waifutxt_voice_volumes'

/** A remote video published in the voice room (camera or screen share). */
export interface RemoteMedia {
  /** LiveKit track sid. */
  id: string
  userId: string
  source: 'camera' | 'screen'
  stream: MediaStream
  /** True when the publisher paused the track (e.g. camera turned off). */
  muted: boolean
}

/** Volume key for a user's microphone, or for the audio of their screen share. */
export function volumeKey(userId: string, source: 'mic' | 'screen'): string {
  return source === 'mic' ? userId : `${userId}#screen`
}

function loadVolumes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LS_VOLUMES)
    const parsed = raw ? JSON.parse(raw) as unknown : null
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {}
  } catch { return {} }
}
function saveVolumes(volumes: Record<string, number>): void {
  try { localStorage.setItem(LS_VOLUMES, JSON.stringify(volumes)) } catch { /* ignore */ }
}

function loadDeviceId(key: string): string | null {
  try { return localStorage.getItem(key) || null } catch { return null }
}
function saveDeviceId(key: string, id: string | null): void {
  try { id ? localStorage.setItem(key, id) : localStorage.removeItem(key) } catch { /* ignore */ }
}

interface VoiceState {
  joinedRoomId: string | null
  isMuted: boolean
  isDeafened: boolean
  isCameraOn: boolean
  isScreenSharing: boolean
  speakingUsers: Set<string>
  localStream: MediaStream | null
  localCameraStream: MediaStream | null
  localScreenStream: MediaStream | null
  remoteMedia: RemoteMedia[]
  /** Per-user playback volume (0–1), keyed by {@link volumeKey}. */
  volumes: Record<string, number>
  inputDeviceId: string | null
  outputDeviceId: string | null

  setJoinedRoom: (roomId: string | null) => void
  setMuted: (muted: boolean) => void
  setDeafened: (deafened: boolean) => void
  setCameraOn: (on: boolean) => void
  setScreenSharing: (sharing: boolean) => void
  setSpeaking: (userId: string, speaking: boolean) => void
  clearSpeaking: () => void
  setLocalStream: (stream: MediaStream | null) => void
  setLocalCameraStream: (stream: MediaStream | null) => void
  setLocalScreenStream: (stream: MediaStream | null) => void
  upsertRemoteMedia: (media: RemoteMedia) => void
  removeRemoteMedia: (id: string) => void
  setVolume: (key: string, volume: number) => void
  setInputDevice: (id: string | null) => void
  setOutputDevice: (id: string | null) => void
  reset: () => void
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  joinedRoomId: null,
  isMuted: false,
  isDeafened: false,
  isCameraOn: false,
  isScreenSharing: false,
  speakingUsers: new Set(),
  localStream: null,
  localCameraStream: null,
  localScreenStream: null,
  remoteMedia: [],
  volumes: loadVolumes(),
  inputDeviceId: loadDeviceId(LS_INPUT),
  outputDeviceId: loadDeviceId(LS_OUTPUT),

  setJoinedRoom: (roomId) => set({ joinedRoomId: roomId }),
  setMuted: (muted) => set({ isMuted: muted }),
  setDeafened: (deafened) => set({ isDeafened: deafened }),
  setCameraOn: (on) => set({ isCameraOn: on }),
  setScreenSharing: (sharing) => set({ isScreenSharing: sharing }),

  setSpeaking: (userId, speaking) => {
    const prev = get().speakingUsers
    const next = new Set(prev)
    if (speaking) next.add(userId)
    else next.delete(userId)
    if (next.size !== prev.size || !([...next].every((u) => prev.has(u)))) {
      set({ speakingUsers: next })
    }
  },

  clearSpeaking: () => set({ speakingUsers: new Set() }),
  setLocalStream: (stream) => set({ localStream: stream }),
  setLocalCameraStream: (stream) => set({ localCameraStream: stream }),
  setLocalScreenStream: (stream) => set({ localScreenStream: stream }),
  upsertRemoteMedia: (media) => {
    const list = get().remoteMedia
    const idx = list.findIndex((m) => m.id === media.id)
    if (idx === -1) set({ remoteMedia: [...list, media] })
    else set({ remoteMedia: list.map((m, i) => (i === idx ? media : m)) })
  },
  removeRemoteMedia: (id) => set({ remoteMedia: get().remoteMedia.filter((m) => m.id !== id) }),
  setVolume: (key, volume) => {
    const volumes = { ...get().volumes, [key]: Math.min(1, Math.max(0, volume)) }
    saveVolumes(volumes)
    set({ volumes })
  },

  setInputDevice: (id) => { saveDeviceId(LS_INPUT, id); set({ inputDeviceId: id }) },
  setOutputDevice: (id) => { saveDeviceId(LS_OUTPUT, id); set({ outputDeviceId: id }) },

  reset: () =>
    set({
      joinedRoomId: null,
      isMuted: false,
      isDeafened: false,
      isCameraOn: false,
      isScreenSharing: false,
      speakingUsers: new Set(),
      localStream: null,
      localCameraStream: null,
      localScreenStream: null,
      remoteMedia: [],
    }),
}))
