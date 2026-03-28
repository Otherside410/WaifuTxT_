import { create } from 'zustand'

const LS_INPUT = 'waifutxt_audio_input_device'
const LS_OUTPUT = 'waifutxt_audio_output_device'

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
  localVideoStream: MediaStream | null
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
  setLocalVideoStream: (stream: MediaStream | null) => void
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
  localVideoStream: null,
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
  setLocalVideoStream: (stream) => set({ localVideoStream: stream }),

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
      localVideoStream: null,
    }),
}))
