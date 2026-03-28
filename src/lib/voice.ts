import { useVoiceStore } from '../stores/voiceStore'
import { playJoinOther, playLeaveOther } from './voiceNotifications'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let activeGroupCall: any = null
const remoteAudioElements = new Map<string, HTMLAudioElement>()
let localCameraStream: MediaStream | null = null
let localScreenStream: MediaStream | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const feedListeners = new Map<string, { feed: any; cleanup: () => void }>()

function voiceLog(msg: string, extra?: unknown) {
  try {
    if (localStorage.getItem('waifutxt_debug_voice') !== '1') return
  } catch { return }
  if (extra !== undefined) console.log(`[voice] ${msg}`, extra)
  else console.log(`[voice] ${msg}`)
}

function feedKey(feed: { userId: string; stream?: MediaStream }): string {
  return `${feed.userId}:${feed.stream?.id ?? 'no-stream'}`
}

function playRemoteStream(feed: { userId: string; stream: MediaStream; isLocal: () => boolean }) {
  if (feed.isLocal()) return
  const key = feedKey(feed)
  const existing = remoteAudioElements.get(key)
  if (existing) {
    existing.srcObject = feed.stream
    return
  }

  const el = document.createElement('audio')
  el.autoplay = true
  el.setAttribute('data-voice-feed', key)
  el.srcObject = feed.stream

  const store = useVoiceStore.getState()
  if (store.isDeafened) el.volume = 0

  el.play().catch(() => voiceLog('autoplay blocked for feed', { userId: feed.userId }))
  remoteAudioElements.set(key, el)
  voiceLog('playing remote stream', { userId: feed.userId, streamId: feed.stream.id })
}

function removeRemoteStream(key: string) {
  const el = remoteAudioElements.get(key)
  if (!el) return
  el.srcObject = null
  el.remove()
  remoteAudioElements.delete(key)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachFeedListeners(feed: any, sdk: any, isNew = false) {
  if (feed.isLocal()) return
  const key = feedKey(feed)
  if (feedListeners.has(key)) return

  if (isNew) playJoinOther()

  const onSpeaking = (speaking: boolean) => {
    useVoiceStore.getState().setSpeaking(feed.userId, speaking)
  }
  const onNewStream = (stream: MediaStream) => {
    const el = remoteAudioElements.get(key)
    if (el) el.srcObject = stream
  }
  const onDisposed = () => {
    playLeaveOther()
    detachFeedListeners(key)
  }

  feed.on(sdk.CallFeedEvent.Speaking, onSpeaking)
  feed.on(sdk.CallFeedEvent.NewStream, onNewStream)
  feed.on(sdk.CallFeedEvent.Disposed, onDisposed)
  feed.measureVolumeActivity?.(true)

  feedListeners.set(key, {
    feed,
    cleanup: () => {
      feed.off(sdk.CallFeedEvent.Speaking, onSpeaking)
      feed.off(sdk.CallFeedEvent.NewStream, onNewStream)
      feed.off(sdk.CallFeedEvent.Disposed, onDisposed)
      feed.measureVolumeActivity?.(false)
    },
  })
}

function detachFeedListeners(key: string) {
  const entry = feedListeners.get(key)
  if (!entry) return
  entry.cleanup()
  feedListeners.delete(key)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setupVoiceStreams(groupCall: any, sdk: any): Promise<void> {
  activeGroupCall = groupCall
  const store = useVoiceStore.getState()

  // Play existing remote feeds
  const feeds = groupCall.userMediaFeeds ?? []
  for (const feed of feeds) {
    if (!feed.isLocal() && feed.stream) playRemoteStream(feed)
    attachFeedListeners(feed, sdk)
  }

  // Store local stream reference
  const localFeed = groupCall.localCallFeed
  if (localFeed?.stream) store.setLocalStream(localFeed.stream)

  // Listen for new/removed feeds
  const onFeedsChanged = (newFeeds: unknown[]) => {
    voiceLog('UserMediaFeedsChanged', { count: (newFeeds as unknown[]).length })
    const currentKeys = new Set<string>()
    for (const feed of newFeeds as { userId: string; stream: MediaStream; isLocal: () => boolean }[]) {
      currentKeys.add(feedKey(feed))
      if (!feed.isLocal() && feed.stream) playRemoteStream(feed)
      const isNew = !feedListeners.has(feedKey(feed))
      attachFeedListeners(feed, sdk, isNew)
    }
    // Remove stale
    for (const [key] of remoteAudioElements) {
      if (!currentKeys.has(key)) {
        removeRemoteStream(key)
        detachFeedListeners(key)
      }
    }
    // Update local stream
    const lf = groupCall.localCallFeed
    useVoiceStore.getState().setLocalStream(lf?.stream ?? null)
  }

  groupCall.on(sdk.GroupCallEvent.UserMediaFeedsChanged, onFeedsChanged)

  // Store the cleanup reference for the group-level listener
  ;(groupCall as { _waifuFeedsCleanup?: () => void })._waifuFeedsCleanup = () => {
    groupCall.off(sdk.GroupCallEvent.UserMediaFeedsChanged, onFeedsChanged)
  }

  voiceLog('setupVoiceStreams complete', { feedCount: feeds.length })
}

export function cleanupVoiceStreams(): void {
  voiceLog('cleanupVoiceStreams')

  // Remove group-level listener
  if (activeGroupCall?._waifuFeedsCleanup) {
    activeGroupCall._waifuFeedsCleanup()
    delete activeGroupCall._waifuFeedsCleanup
  }

  // Detach all feed listeners
  for (const [key] of feedListeners) detachFeedListeners(key)
  feedListeners.clear()

  // Remove all remote audio elements
  for (const [key] of remoteAudioElements) removeRemoteStream(key)
  remoteAudioElements.clear()

  // Stop local audio stream tracks
  const store = useVoiceStore.getState()
  if (store.localStream) {
    for (const track of store.localStream.getTracks()) track.stop()
  }

  // Stop local video/screen streams
  stopLocalVideo()

  store.clearSpeaking()
  store.setLocalStream(null)
  activeGroupCall = null
}

export async function setVoiceMuted(muted: boolean): Promise<void> {
  useVoiceStore.getState().setMuted(muted)
  if (!activeGroupCall) return
  try {
    await activeGroupCall.setMicrophoneMuted?.(muted)
    voiceLog('setMicrophoneMuted', { muted })
  } catch (err) {
    voiceLog('setMicrophoneMuted failed', err)
  }
}

export function setVoiceDeafened(deafened: boolean): void {
  useVoiceStore.getState().setDeafened(deafened)
  for (const el of remoteAudioElements.values()) {
    el.volume = deafened ? 0 : 1
  }
  voiceLog('setVoiceDeafened', { deafened })
}

export function getActiveGroupCall(): unknown {
  return activeGroupCall
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
