import type { MatrixSession, MessageEvent, RoomSummary, RoomMember, EncryptedFileInfo, ThreadSummary } from '../types/matrix'
import { useMessageStore } from '../stores/messageStore'
import { useRoomStore } from '../stores/roomStore'
import { useAuthStore } from '../stores/authStore'
import { useVoiceStore } from '../stores/voiceStore'
import { setupVoiceStreams, cleanupVoiceStreams } from './voice'
import { setupVerificationListeners } from './verification'

type MatrixClient = import('matrix-js-sdk').MatrixClient
type MatrixEvent = import('matrix-js-sdk').MatrixEvent
type MatrixRoom = import('matrix-js-sdk').Room

let client: MatrixClient | null = null
let sdk: typeof import('matrix-js-sdk') | null = null
let pendingSecretStorageKey: { keyId: string; key: Uint8Array } | null = null
let voiceRefreshInterval: ReturnType<typeof setInterval> | null = null
const mediaBlobCache = new Map<string, string>()
const mediaBlobPromiseCache = new Map<string, Promise<string | null>>()
const decryptedUrlCache = new Map<string, string>()
const decryptPromiseCache = new Map<string, Promise<string>>()
const userProfileCache = new Map<string, { displayName: string | null; avatarUrl: string | null }>()
const roomJoinedMembersCache = new Map<string, Map<string, { displayName: string | null; avatarMxc: string | null }>>()

const OWN_STATUS_MSG_STORAGE_KEY = 'waifutxt_status_msg'
export const MAX_PRESENCE_STATUS_MSG_LEN = 200

let ownStatusStorageListenerBound = false

function isVoiceDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem('waifutxt_debug_voice') === '1'
  } catch {
    return false
  }
}

function voiceDebugLog(message: string, extra?: unknown): void {
  if (!isVoiceDebugEnabled()) return
  if (extra !== undefined) {
    console.log(`[voice] ${message}`, extra)
    return
  }
  console.log(`[voice] ${message}`)
}

async function getSDK() {
  if (!sdk) sdk = await import('matrix-js-sdk')
  return sdk
}

export function getClient(): MatrixClient | null {
  return client
}

async function ensureClientReady(): Promise<MatrixClient> {
  if (client) return client

  const authStore = useAuthStore.getState()
  const restoredSession = authStore.session || authStore.restoreSession()
  if (!restoredSession) throw new Error('Session introuvable, reconnecte-toi.')

  await initClient(restoredSession)
  if (!client) throw new Error('Client non initialisé')
  return client
}

export async function login(
  homeserver: string,
  username: string,
  password: string,
): Promise<MatrixSession> {
  const matrixSdk = await getSDK()
  const tempClient = matrixSdk.createClient({ baseUrl: homeserver })
  const response = await tempClient.login('m.login.password', {
    user: username,
    password,
    initial_device_display_name: 'WaifuTxT Web',
  })

  return {
    userId: response.user_id,
    accessToken: response.access_token,
    homeserver,
    deviceId: response.device_id || '',
  }
}

export async function initClient(session: MatrixSession): Promise<void> {
  const matrixSdk = await getSDK()

  client = matrixSdk.createClient({
    baseUrl: session.homeserver,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
    timelineSupport: true,
    useAuthorizationHeader: true,
    cryptoCallbacks: {
      getSecretStorageKey: async ({ keys }, _name) => {
        if (!pendingSecretStorageKey) return null
        const { keyId, key } = pendingSecretStorageKey
        if (!(keyId in keys)) return null
        return [keyId, key as Uint8Array<ArrayBuffer>]
      },
    },
  })

  try {
    await client.initRustCrypto()
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes("doesn't match the account in the constructor")) {
      // The IndexedDB crypto store belongs to a different account/device. Purging
      // locally is not enough — the server still holds one-time keys for the old
      // device, which causes "already exists" 400 errors on key upload and breaks
      // to-device messaging (and therefore emoji verification). The only clean
      // recovery is to remove the device from the server (which flushes its keys)
      // and force a fresh login that gets a new deviceId.
      console.warn('[WaifuTxT] Crypto store mismatch — purging local stores and logging out for clean re-login')
      await purgeRustCryptoStores()
      try {
        await client.logout(true)
      } catch {
        // ignore — server may already have invalidated the token
      }
      client.stopClient()
      client = null
      throw new Error('Données de chiffrement corrompues. Veuillez vous reconnecter.')
    } else {
      console.warn('[WaifuTxT] Crypto init failed:', err)
    }
  }

  setupEventListeners(matrixSdk)

  await client.startClient({
    initialSyncLimit: 30,
    lazyLoadMembers: true,
  })
}

// The two IndexedDB databases created by @matrix-org/matrix-sdk-crypto-wasm via matrix-js-sdk.
// Source: node_modules/matrix-js-sdk/lib/client.js + rust-crypto/constants.js
const RUST_CRYPTO_DB_NAMES = ['matrix-js-sdk::matrix-sdk-crypto', 'matrix-js-sdk::matrix-sdk-crypto-meta']

async function purgeRustCryptoStores(): Promise<void> {
  await Promise.allSettled(
    RUST_CRYPTO_DB_NAMES.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name)
          req.onsuccess = () => resolve()
          req.onerror = () => resolve()
          req.onblocked = () => resolve()
        }),
    ),
  )
}

export async function logout(): Promise<void> {
  if (!client) return
  cleanupVoiceStreams()
  useVoiceStore.getState().reset()
  try {
    await client.logout(true)
  } catch {
    // ignore
  }
  client.stopClient()
  if (voiceRefreshInterval) {
    clearInterval(voiceRefreshInterval)
    voiceRefreshInterval = null
  }
  client = null
  useRoomStore.getState().reset()
  useMessageStore.getState().reset()
}

function setupEventListeners(matrixSdk: typeof import('matrix-js-sdk')) {
  if (!client) return

  let presenceInitialized = false
  client.on(matrixSdk.ClientEvent.Sync, (state: string) => {
    if (state === 'PREPARED' || state === 'SYNCING') {
      try {
        syncRooms()
      } catch (err) {
        console.error('[WaifuTxT] syncRooms error:', err)
      }
      if (!presenceInitialized) {
        presenceInitialized = true
        // Seed presenceMap with whatever the SDK already knows from the initial sync.
        seedPresenceFromUsers()
        initOwnPresence().catch(() => {})
      }
    }
  })

  if (typeof window !== 'undefined' && !ownStatusStorageListenerBound) {
    ownStatusStorageListenerBound = true
    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key !== OWN_STATUS_MSG_STORAGE_KEY || !client) return
      const uid = client.getUserId()
      if (!uid) return
      const msg = getStoredOwnStatusMessage().trim()
      useRoomStore.getState().setStatusMessage(uid, msg || null)
    })
  }

  client.on(matrixSdk.RoomEvent.Timeline, (event: MatrixEvent, room: import('matrix-js-sdk').Room | undefined) => {
    try {
      if (!room) return
      const type = event.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted' && type !== 'm.reaction' && type !== 'm.room.redaction') return

      if (type === 'm.reaction') {
        useMessageStore.getState().bumpReactionsVersion()
        return
      }

      if (type === 'm.room.redaction') {
        const redactedEventId = getRedactedEventId(event)
        if (!redactedEventId) return
        const store = useMessageStore.getState()
        const existing = store.getMessages(room.roomId).find((m) => m.eventId === redactedEventId)
        if (existing) {
          const deletedMessage: MessageEvent = {
            ...existing,
            type: 'm.notice',
            content: 'Message supprimé',
            htmlContent: null,
            isEdited: false,
            imageUrl: undefined,
            imageInfo: undefined,
            thumbnailUrl: undefined,
            fileName: undefined,
            fileUrl: undefined,
            fileSize: undefined,
            encryptedFile: undefined,
            encryptedThumbnailFile: undefined,
          }
          store.replaceMessage(room.roomId, redactedEventId, deletedMessage)
          updateRoomLastMessage(room.roomId, deletedMessage)
        }
        useMessageStore.getState().bumpReactionsVersion()
        return
      }

      if (type === 'm.room.encrypted') {
        // Always show a placeholder immediately — Rust crypto is async so
        // isDecryptionFailure() may still be false at this point.
        // encryptedFallbackMessage already extracts threadRootId from unencrypted wire content.
        const fallback = encryptedFallbackMessage(event, room.roomId)
        if (fallback) {
          if (fallback.threadRootId) {
            // Thread reply — placeholder goes into the thread store, not main timeline
            useMessageStore.getState().addThreadMessage(fallback.threadRootId, fallback)
          } else {
            useMessageStore.getState().addMessage(room.roomId, fallback)
            updateRoomLastMessage(room.roomId, fallback)
          }
        }

        // Replace with real content once decryption completes (success or failure).
        event.once(matrixSdk.MatrixEventEvent.Decrypted, () => {
          const msg = eventToMessage(event, room.roomId)
          if (!msg) return
          if (msg.replacesEventId) {
            applyMessageEdit(room.roomId, msg)
            // Drop the temporary placeholder — it may be in thread store or main timeline
            const decryptedEventId = event.getId()
            if (decryptedEventId) {
              useMessageStore.getState().removeMessage(room.roomId, decryptedEventId)
            }
            return
          }
          if (msg.threadRootId) {
            const store = useMessageStore.getState()
            // Replace the encrypted fallback with the real message in the thread store
            const existing = store.getThreadMessages(msg.threadRootId)
            const idx = existing.findIndex((m) => m.eventId === msg.eventId)
            if (idx !== -1) {
              const updated = [...existing]
              updated[idx] = msg
              store.setThreadMessages(msg.threadRootId, updated)
            } else {
              store.addThreadMessage(msg.threadRootId, msg)
            }
            store.updateThreadRootInfo(room.roomId, msg.threadRootId, {
              replyCount: store.getThreadMessages(msg.threadRootId).length,
              lastReplyTs: msg.timestamp,
              lastReplierAvatar: msg.senderAvatar,
              lastReplierName: msg.senderName,
            })
            return
          }
          const store = useMessageStore.getState()
          store.replaceMessage(room.roomId, msg.eventId, msg)
          updateRoomLastMessage(room.roomId, msg)
        })
        return
      }

      const msg = eventToMessage(event, room.roomId)
      if (msg) {
        if (msg.replacesEventId) {
          applyMessageEdit(room.roomId, msg)
          return
        }
        if (msg.threadRootId) {
          // Thread reply — route to thread store, not main timeline
          const store = useMessageStore.getState()
          store.addThreadMessage(msg.threadRootId, msg)
          // Update reply count pill on the root message
          const threadMsgs = store.getThreadMessages(msg.threadRootId)
          store.updateThreadRootInfo(room.roomId, msg.threadRootId, {
            replyCount: threadMsgs.length,
            lastReplyTs: msg.timestamp,
            lastReplierAvatar: msg.senderAvatar,
            lastReplierName: msg.senderName,
          })
          return
        }
        useMessageStore.getState().addMessage(room.roomId, msg)
        updateRoomLastMessage(room.roomId, msg)
      }
    } catch (err) {
      console.error('[WaifuTxT] Timeline event error:', err)
    }
  })

  client.on(
    matrixSdk.RoomEvent.LocalEchoUpdated,
    (event: MatrixEvent, room: import('matrix-js-sdk').Room, oldEventId?: string) => {
      if (!room || !oldEventId) return
      const newEventId = event.getId()
      if (!newEventId || !newEventId.startsWith('$')) return
      const store = useMessageStore.getState()
      const existing = store.getMessages(room.roomId).find((m) => m.eventId === oldEventId)
      if (!existing) return
      store.replaceMessage(room.roomId, oldEventId, { ...existing, eventId: newEventId })
    },
  )

  client.on(matrixSdk.RoomMemberEvent.Typing, (_event: MatrixEvent, member: import('matrix-js-sdk').RoomMember) => {
    try {
      const room = client?.getRoom(member.roomId)
      if (!room) return
      const typingMembers = room.getMembers().filter((m: import('matrix-js-sdk').RoomMember) =>
        (m as unknown as { typing: boolean }).typing && m.userId !== client?.getUserId(),
      )
      useMessageStore.getState().setTyping({
        roomId: member.roomId,
        userIds: typingMembers.map((m: import('matrix-js-sdk').RoomMember) => m.name || m.userId),
      })
    } catch {
      // ignore typing errors
    }
  })

  client.on(matrixSdk.RoomEvent.Receipt, () => {
    syncRooms()
    useMessageStore.getState().bumpReceiptsVersion()
  })

  // Real-time presence updates emitted by the SDK on User objects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client.on('User.presence' as any, (_event: unknown, user: any) => {
    const content = user?.events?.presence?.getContent?.() as Record<string, unknown> | undefined
    const sm =
      content && Object.prototype.hasOwnProperty.call(content, 'status_msg')
        ? String((content.status_msg as string | undefined) ?? '')
        : undefined
    applyPresence(user?.userId, user?.presence, sm)
  })

  // Fallback: raw m.presence events arriving in the sync stream.
  // Covers homeservers where the SDK reEmitter is not wired for User events.
  client.on(matrixSdk.ClientEvent.Event, (event: MatrixEvent) => {
    if (event.getType() !== 'm.presence') return
    const c = event.getContent() as Record<string, unknown>
    const sm = Object.prototype.hasOwnProperty.call(c, 'status_msg')
      ? String((c.status_msg as string | undefined) ?? '')
      : undefined
    applyPresence(event.getSender(), c.presence as string | undefined, sm)
  })

  client.on(matrixSdk.ClientEvent.Event, (event: MatrixEvent) => {
    if (event.getType() !== 'm.room.redaction') return
    useMessageStore.getState().bumpReactionsVersion()
  })

  client.on(matrixSdk.RoomStateEvent.Events, (event: MatrixEvent) => {
    if (event.getType() !== 'm.room.pinned_events') return
    const roomId = event.getRoomId?.() || (event as unknown as { room_id?: string }).room_id
    if (!roomId) return
    const content = event.getContent() as { pinned?: string[] }
    const pinned = Array.isArray(content.pinned) ? content.pinned : []
    useMessageStore.getState().setPinnedEventIds(roomId, pinned)
  })

  // Keep voice participant lists fresh when call membership state changes.
  client.on(matrixSdk.ClientEvent.Event, (event: MatrixEvent) => {
    const type = event.getType()
    if (type !== 'm.call.member' && type !== 'org.matrix.msc3401.call.member' && type !== 'org.matrix.msc4143.rtc.member') {
      return
    }
    syncRooms()
  })

  // Some homeservers keep stale call-member state longer than Element's UI.
  // Lightweight heartbeat keeps participant lists aligned with active memberships.
  if (voiceRefreshInterval) clearInterval(voiceRefreshInterval)
  voiceRefreshInterval = setInterval(() => {
    try {
      syncRooms()
    } catch {
      // ignore periodic sync errors
    }
  }, 7000)

  setupVerificationListeners(client)
}

interface AnnotationContent {
  rel_type?: string
  event_id?: string
  key?: string
}

interface ParsedReactionAnnotation {
  event_id: string
  key: string
}

function getRedactedEventId(redactionEvent: MatrixEvent): string | null {
  if (redactionEvent.getType() !== 'm.room.redaction') return null
  const fromMethod = (redactionEvent as unknown as { getAssociatedId?: () => string | null }).getAssociatedId?.()
  if (fromMethod) return fromMethod
  const fromWire = ((redactionEvent as unknown as { event?: { redacts?: string } }).event?.redacts) || null
  if (fromWire) return fromWire
  const fromContent = (redactionEvent.getContent()?.redacts as string | undefined) || null
  return fromContent
}

export interface MessageReactionSummary {
  key: string
  count: number
  senders: string[]
  reactedByMe: boolean
}

function getReactionAnnotation(event: MatrixEvent): ParsedReactionAnnotation | null {
  if (event.getType() !== 'm.reaction') return null
  const content = event.getContent() as Record<string, unknown>
  const relates = content['m.relates_to'] as AnnotationContent | undefined
  if (!relates || relates.rel_type !== 'm.annotation') return null
  if (!relates.event_id || !relates.key) return null
  return { event_id: relates.event_id, key: relates.key }
}

export function getMessageReactions(roomId: string, eventId: string): MessageReactionSummary[] {
  if (!client) return []
  const room = client.getRoom(roomId)
  if (!room) return []
  const me = client.getUserId() || ''

  const buckets = new Map<string, { senders: Set<string> }>()
  const timeline = room.getLiveTimeline().getEvents()
  for (const event of timeline) {
    if (event.isRedacted?.()) continue
    const annotation = getReactionAnnotation(event)
    if (!annotation) continue
    if (annotation.event_id !== eventId) continue
    const sender = event.getSender()
    if (!sender) continue
    const bucket = buckets.get(annotation.key) || { senders: new Set<string>() }
    bucket.senders.add(sender)
    buckets.set(annotation.key, bucket)
  }

  return Array.from(buckets.entries())
    .map(([key, bucket]) => {
      const senders = Array.from(bucket.senders)
      return {
        key,
        count: senders.length,
        senders,
        reactedByMe: !!me && senders.includes(me),
      }
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function findOwnReactionEventId(roomId: string, eventId: string, key: string): string | null {
  if (!client) return null
  const room = client.getRoom(roomId)
  const me = client.getUserId()
  if (!room || !me) return null

  for (const event of room.getLiveTimeline().getEvents()) {
    if (event.isRedacted?.()) continue
    if (event.getSender() !== me) continue
    const annotation = getReactionAnnotation(event)
    if (!annotation) continue
    if (annotation.event_id === eventId && annotation.key === key) {
      return event.getId() || null
    }
  }
  return null
}

export async function toggleReaction(roomId: string, eventId: string, key: string): Promise<void> {
  if (!client) return
  const ownReactionEventId = findOwnReactionEventId(roomId, eventId, key)

  if (ownReactionEventId) {
    await client.redactEvent(roomId, ownReactionEventId)
    return
  }

  await (client as any).sendEvent(roomId, 'm.reaction', {
    'm.relates_to': {
      rel_type: 'm.annotation',
      event_id: eventId,
      key,
    },
  } as any)
}

function syncRooms() {
  if (!client) return
  const matrixRooms = client.getRooms()
  const roomMap = new Map<string, RoomSummary>()
  const baseUrl = client.baseUrl
  const myUserId = client.getUserId() || ''
  const myDeviceId = client.getDeviceId() || ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rtcManager = (client as any).matrixRTC
  const activeRoomId = useRoomStore.getState().activeRoomId

  for (const room of matrixRooms) {
    const membership = room.getMyMembership()
    // Keep only rooms the current user is actively joined to or invited to.
    // This prevents stale spaces/rooms from lingering after deletion/leave from another client (e.g. Element).
    if (membership !== 'join' && membership !== 'invite') continue

    if (membership === 'invite') {
      const name = room.name || room.roomId
      const avatarEvent = room.currentState.getStateEvents('m.room.avatar', '')
      const mxcAvatar = (avatarEvent?.getContent()?.url as string | undefined) ?? null
      roomMap.set(room.roomId, {
        roomId: room.roomId,
        name,
        avatarUrl: mxcAvatar ? client.mxcUrlToHttp(mxcAvatar, 48, 48, 'crop') : null,
        topic: '',
        lastMessage: '',
        lastMessageTs: 0,
        unreadCount: 0,
        mentionCount: 0,
        isSpace: false,
        isDirect: false,
        membership: 'invite',
        children: [],
      })
      continue
    }

    const createEvent = room.currentState.getStateEvents('m.room.create')?.[0]
    const isSpace = createEvent?.getContent()?.type === 'm.space'
    const roomType = (room.getType?.() || createEvent?.getContent()?.type || '') as string
    const hasCallState =
      room.currentState.getStateEvents('org.matrix.msc3401.call')?.length > 0 ||
      room.currentState.getStateEvents('org.matrix.msc3401.call.member')?.length > 0 ||
      room.currentState.getStateEvents('m.call.member')?.length > 0 ||
      room.currentState.getStateEvents('org.matrix.msc4143.rtc.member')?.length > 0
    const isVoice = /call|voice/i.test(roomType) || hasCallState
    let voiceParticipants: Array<{ userId: string; displayName: string; avatarUrl: string | null }> = []
    let voiceJoinedByMe = false
    if (isVoice) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const groupCall = (client as any).getGroupCallForRoom?.(room.roomId)
        if (groupCall?.hasLocalParticipant?.()) {
          voiceJoinedByMe = true
        }
      } catch {
        // ignore
      }
    }
    if (isVoice && !voiceJoinedByMe && rtcManager?.getRoomSession) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = (rtcManager.getActiveRoomSession?.(room) || rtcManager.getRoomSession(room)) as any
        if (session) {
          voiceJoinedByMe = isMyVoiceMembership(session, myUserId, myDeviceId) || !!session.isJoined?.()
        }
      } catch {
        // ignore
      }
    }
    if (isVoice) {
      let participantIds: string[] = []
      try {
        if (rtcManager?.getRoomSession) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const session = (rtcManager.getActiveRoomSession?.(room) || rtcManager.getRoomSession(room)) as any
          participantIds = getActiveVoiceParticipantIdsFromSession(session)
        }
      } catch {
        // ignore and try GroupCall participant source below
      }
      if (participantIds.length === 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const groupCall = (client as any).getGroupCallForRoom?.(room.roomId) as any
          if (groupCall?.participants instanceof Map) {
            const fromGroupCall = new Set<string>()
            for (const member of groupCall.participants.keys()) {
              const userId = normalizeVoiceUserId((member as { userId?: string } | null)?.userId)
              if (userId) fromGroupCall.add(userId)
            }
            participantIds = Array.from(fromGroupCall)
          }
        } catch {
          // ignore
        }
      }
      voiceParticipants = getVoiceParticipants(room, baseUrl, participantIds)
    }

    const children: string[] = []
    if (isSpace) {
      const childEvents = room.currentState.getStateEvents('m.space.child')
      for (const ev of childEvents) {
        const stateKey = ev.getStateKey()
        // An m.space.child event with non-empty content = active child.
        // Empty content ({}) means the child was removed (Matrix state deletion).
        // We do NOT require 'via' — it's recommended but not mandatory per spec,
        // and some clients/servers omit it, which would silently hide rooms.
        const content = ev.getContent()
        const isActive = stateKey && content && typeof content === 'object' && Object.keys(content).length > 0
        if (isActive) children.push(stateKey)
      }
    }

    let isDirect = false
    try {
      const directMap = (client as unknown as { getAccountData: (key: string) => { getContent: () => unknown } | null })
        .getAccountData('m.direct')?.getContent() || {}
      isDirect = Object.values(directMap).some((roomIds) => (roomIds as string[]).includes(room.roomId))
    } catch {
      // ignore
    }

    const timeline = room.getLiveTimeline().getEvents()
    const lastEvent = [...timeline].reverse().find((e) => e.getType() === 'm.room.message' || e.getType() === 'm.room.encrypted')
    const lastContent = lastEvent?.getContent()

    let avatarUrl: string | null = null
    try {
      const roomMxc = room.getMxcAvatarUrl()
      avatarUrl = roomMxc ? mxcToAvatarHttpUrl(roomMxc) : null
    } catch {
      // ignore
    }

    const topic = room.currentState.getStateEvents('m.room.topic')?.[0]?.getContent()?.topic || ''
    let lastMessageText = lastContent?.body || ''
    if (lastMessageText.includes('Unable to decrypt') || lastContent?.msgtype === 'm.bad.encrypted') {
      lastMessageText = '🔒 Message chiffré'
    }

    roomMap.set(room.roomId, {
      roomId: room.roomId,
      name: room.name || 'Sans nom',
      avatarUrl,
      roomType,
      isVoice,
      voiceJoinedByMe,
      voiceParticipants,
      topic,
      lastMessage: lastMessageText,
      lastMessageTs: lastEvent?.getTs() || 0,
      unreadCount: room.roomId === activeRoomId ? 0 : (() => {
        // Server push-notification count only fires when a push rule matches,
        // so it misses many unread messages. Compute from read receipts instead.
        const readUpToId = room.getEventReadUpTo(myUserId, false)
        let count = 0
        let foundMarker = false
        for (const ev of timeline) {
          if (ev.getId() === readUpToId) { foundMarker = true; continue }
          if (
            foundMarker &&
            !ev.isState() &&
            ev.getSender() !== myUserId &&
            (ev.getType() === 'm.room.message' || ev.getType() === 'm.room.encrypted')
          ) count++
        }
        // Marker not in loaded window → every message in this window is unread
        if (!foundMarker) {
          count = timeline.filter(
            ev => !ev.isState() && ev.getSender() !== myUserId &&
            (ev.getType() === 'm.room.message' || ev.getType() === 'm.room.encrypted')
          ).length
        }
        // Never go below the server notification count (covers history not in the window)
        return Math.max(count, room.getUnreadNotificationCount() || 0)
      })(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mentionCount: room.roomId === activeRoomId ? 0 : (room.getUnreadNotificationCount('highlight' as any) || 0),
      isSpace,
      isDirect,
      membership,
      children,
    })
  }

  const roomStore = useRoomStore.getState()
  roomStore.setRooms(roomMap)

  // If current selections no longer exist after sync, reset them to avoid UI pointing to removed rooms/spaces.
  if (roomStore.activeRoomId && !roomMap.has(roomStore.activeRoomId)) {
    roomStore.setActiveRoom(null)
  }
  if (roomStore.activeSpaceId && !roomMap.has(roomStore.activeSpaceId)) {
    roomStore.setActiveSpace(null)
  }
}

const CALL_MEMBER_EVENT_TYPES = ['m.call.member', 'org.matrix.msc3401.call.member', 'org.matrix.msc4143.rtc.member'] as const

function normalizeVoiceUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null

  // Extract first candidate user id from noisy call-member payloads.
  const candidateMatch = value.startsWith('@')
    ? value.match(/^@[^|,\s]+:[^|,\s]+/)
    : value.match(/@[^|,\s]+:[^|,\s]+/)
  const candidate = candidateMatch?.[0]
  if (!candidate) return null

  const colon = candidate.indexOf(':')
  if (colon <= 1) return null
  const localpart = candidate.slice(0, colon)
  let serverPart = candidate.slice(colon + 1)
  if (!localpart || !serverPart) return null

  // Call membership keys often append "_<opaque>.m.call" to the server part.
  // Keep only the canonical homeserver host (plus optional port).
  const underscore = serverPart.indexOf('_')
  if (underscore !== -1) serverPart = serverPart.slice(0, underscore)
  const pipe = serverPart.indexOf('|')
  if (pipe !== -1) serverPart = serverPart.slice(0, pipe)

  // Trim trailing punctuation that may leak from embedded strings.
  serverPart = serverPart.replace(/[)\],;]+$/g, '').trim()
  if (!serverPart) return null

  return `${localpart}:${serverPart}`
}

function collectVoiceParticipantIds(room: MatrixRoom): string[] {
  const ids = new Set<string>()

  for (const eventType of CALL_MEMBER_EVENT_TYPES) {
    const events = room.currentState.getStateEvents(eventType) || []
    for (const ev of events) {
      if (ev.isRedacted?.()) continue

      const fromStateKey = normalizeVoiceUserId(ev.getStateKey())
      if (fromStateKey) ids.add(fromStateKey)

      const content = (ev.getContent() as Record<string, unknown>) || {}
      const fromSender = normalizeVoiceUserId(content.sender)
      if (fromSender) ids.add(fromSender)
      const fromUserId = normalizeVoiceUserId(content.user_id)
      if (fromUserId) ids.add(fromUserId)

      if (Array.isArray(content.memberships)) {
        for (const membership of content.memberships) {
          if (!membership || typeof membership !== 'object') continue
          const item = membership as Record<string, unknown>
          const fromMembershipSender = normalizeVoiceUserId(item.sender)
          if (fromMembershipSender) ids.add(fromMembershipSender)
          const fromMembershipUserId = normalizeVoiceUserId(item.user_id)
          if (fromMembershipUserId) ids.add(fromMembershipUserId)
        }
      }
    }
  }

  return Array.from(ids)
}

function getActiveVoiceParticipantIdsFromSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
): string[] {
  const ids = new Set<string>()
  const memberships = Array.isArray(session?.memberships) ? session.memberships : []
  for (const membership of memberships) {
    if (!membership || typeof membership !== 'object') continue
    const m = membership as { userId?: unknown; isExpired?: unknown }
    if (typeof m.isExpired === 'function' && (m.isExpired as () => boolean)()) continue
    const userId = normalizeVoiceUserId(m.userId)
    if (userId) ids.add(userId)
  }
  return Array.from(ids)
}

function getVoiceParticipants(
  room: MatrixRoom,
  baseUrl: string,
  participantIds: string[],
): Array<{ userId: string; displayName: string; avatarUrl: string | null }> {
  const userIds = participantIds
  if (userIds.length === 0) return []

  const participants = userIds.map((userId) => {
    const member = room.getMember(userId)
    const memberStateResult = room.currentState.getStateEvents('m.room.member', userId)
    const memberStateEvent = Array.isArray(memberStateResult) ? memberStateResult[0] : memberStateResult
    const memberStateContent = (memberStateEvent?.getContent() as Record<string, unknown> | undefined) || {}
    let avatarUrl: string | null = null
    try {
      avatarUrl = memberAvatarHttpUrl(member || null)
      if (!avatarUrl && typeof memberStateContent.avatar_url === 'string') {
        avatarUrl = mxcToAvatarHttpUrl(memberStateContent.avatar_url as string)
      }
      if (!avatarUrl && client) {
        const userObj = client.getUser(userId) as { avatarUrl?: string | null } | null
        if (typeof userObj?.avatarUrl === 'string' && userObj.avatarUrl) {
          avatarUrl = mxcToAvatarHttpUrl(userObj.avatarUrl)
        }
      }
    } catch {
      // ignore
    }
    const fallbackLocalpart = userId.replace(/^@/, '').split(':')[0] || userId
    const displayName =
      member?.name ||
      (typeof memberStateContent.displayname === 'string' ? memberStateContent.displayname : '') ||
      fallbackLocalpart
    return {
      userId,
      displayName,
      avatarUrl,
    }
  })

  const sorted = participants.sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr', { sensitivity: 'base' }))
  if (isVoiceDebugEnabled()) {
    console.debug('[VoiceDebug] getVoiceParticipants', {
      roomId: room.roomId,
      participantCount: sorted.length,
      participants: sorted.map((p) => ({
        userId: p.userId,
        displayName: p.displayName,
        hasAvatar: !!p.avatarUrl,
        avatarUrl: p.avatarUrl,
      })),
    })
  }
  return sorted
}

export async function getUserProfileBasics(
  userId: string,
  size = 24,
): Promise<{ displayName: string | null; avatarUrl: string | null }> {
  const cached = userProfileCache.get(userId)
  if (cached) return cached
  if (!client) return { displayName: null, avatarUrl: null }

  let displayName: string | null = null
  let avatarUrl: string | null = null

  const userObj = client.getUser(userId) as { displayName?: string; avatarUrl?: string | null } | null
  if (typeof userObj?.displayName === 'string' && userObj.displayName.trim()) {
    displayName = userObj.displayName.trim()
  }
  if (typeof userObj?.avatarUrl === 'string' && userObj.avatarUrl) {
    avatarUrl = mxcToAvatarHttpUrl(userObj.avatarUrl)
  }

  if (!displayName || !avatarUrl) {
    for (const room of client.getRooms()) {
      const member = room.getMember(userId)
      if (!member) continue
      if (!displayName && member.name) displayName = member.name
      if (!avatarUrl) {
        avatarUrl = memberAvatarHttpUrl(member)
      }
      if (displayName && avatarUrl) break
    }
  }

  if (!displayName || !avatarUrl) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profile = await (client as any).getProfileInfo(userId)
      if (!displayName && typeof profile?.displayname === 'string' && profile.displayname.trim()) {
        displayName = profile.displayname.trim()
      }
      if (!avatarUrl && typeof profile?.avatar_url === 'string' && profile.avatar_url) {
        avatarUrl = mxcToAvatarHttpUrl(profile.avatar_url)
      }
    } catch {
      // ignore
    }
  }

  const result = { displayName, avatarUrl }
  userProfileCache.set(userId, result)
  return result
}

export async function getRoomMemberProfileBasics(
  roomId: string,
  userId: string,
  size = 24,
): Promise<{ displayName: string | null; avatarUrl: string | null }> {
  if (!client) return { displayName: null, avatarUrl: null }

  const fromCache = roomJoinedMembersCache.get(roomId)?.get(userId)
  if (fromCache) {
    return {
      displayName: fromCache.displayName,
      avatarUrl: fromCache.avatarMxc ? mxcToAvatarHttpUrl(fromCache.avatarMxc) : null,
    }
  }

  try {
    const resp = await client.getJoinedRoomMembers(roomId)
    const roomMap = new Map<string, { displayName: string | null; avatarMxc: string | null }>()
    for (const [joinedUserId, info] of Object.entries(resp.joined || {})) {
      const joined = info as { display_name?: string; avatar_url?: string }
      roomMap.set(joinedUserId, {
        displayName: typeof joined.display_name === 'string' ? joined.display_name : null,
        avatarMxc: typeof joined.avatar_url === 'string' ? joined.avatar_url : null,
      })
    }
    roomJoinedMembersCache.set(roomId, roomMap)
  } catch {
    // ignore
  }

  const fallback = roomJoinedMembersCache.get(roomId)?.get(userId)
  if (fallback) {
    return {
      displayName: fallback.displayName,
      avatarUrl: fallback.avatarMxc ? mxcToAvatarHttpUrl(fallback.avatarMxc) : null,
    }
  }

  return getUserProfileBasics(userId, size)
}

/** Store placeholder for encrypted timeline events until decrypt completes (see RoomEvent.Timeline handler). */
const E2EE_STORE_PLACEHOLDER_CONTENT = '🔒 Message chiffré — clé de récupération requise'

function isEncryptedStorePlaceholder(msg: MessageEvent): boolean {
  return msg.content === E2EE_STORE_PLACEHOLDER_CONTENT
}

function encryptedFallbackMessage(event: MatrixEvent, roomId: string): MessageEvent | null {
  const sender = event.getSender()
  if (!sender) return null
  const room = client?.getRoom(roomId)
  const member = room?.getMember(sender)
  const senderAvatar = member ? memberAvatarHttpUrl(member) : null

  // m.relates_to is NOT encrypted per Matrix spec — extract threadRootId from wire content
  // so we can route the fallback to the right store immediately.
  type RelContent = { rel_type?: string; event_id?: string }
  const relation = (event.getRelation?.() as RelContent | null) || null
  const wireContent = (event.getWireContent?.() as Record<string, unknown> | undefined) || {}
  const wireRelatesTo = relation || (wireContent['m.relates_to'] as RelContent | undefined)
  const threadRootId =
    wireRelatesTo?.rel_type === 'm.thread' && typeof wireRelatesTo?.event_id === 'string'
      ? wireRelatesTo.event_id
      : null

  return {
    eventId: event.getId() || `${roomId}-${event.getTs()}`,
    roomId,
    sender,
    senderName: member?.name || sender,
    senderAvatar,
    content: E2EE_STORE_PLACEHOLDER_CONTENT,
    htmlContent: null,
    timestamp: event.getTs(),
    type: 'm.notice',
    replyTo: null,
    isEdited: false,
    threadRootId,
  }
}

function deletedFallbackMessage(event: MatrixEvent, roomId: string): MessageEvent | null {
  const sender = event.getSender()
  if (!sender) return null
  const room = client?.getRoom(roomId)
  const member = room?.getMember(sender)
  const senderAvatar = member ? memberAvatarHttpUrl(member) : null
  return {
    eventId: event.getId() || `${roomId}-${event.getTs()}`,
    roomId,
    sender,
    senderName: member?.name || sender,
    senderAvatar,
    content: 'Message supprimé',
    htmlContent: null,
    timestamp: event.getTs(),
    type: 'm.notice',
    replyTo: null,
    isEdited: false,
  }
}

function updateRoomLastMessage(roomId: string, msg: MessageEvent) {
  useRoomStore.getState().updateRoom(roomId, {
    lastMessage: msg.content,
    lastMessageTs: msg.timestamp,
  })
}

function applyMessageEdit(roomId: string, editMessage: MessageEvent): boolean {
  const targetEventId = editMessage.replacesEventId
  if (!targetEventId) return false
  const store = useMessageStore.getState()
  const existing = store.getMessages(roomId).find((m) => m.eventId === targetEventId)
  if (!existing) return false

  const updated: MessageEvent = {
    ...existing,
    content: editMessage.content,
    htmlContent: editMessage.htmlContent,
    isEdited: true,
  }
  store.replaceMessage(roomId, targetEventId, updated)
  updateRoomLastMessage(roomId, updated)
  return true
}

function eventToMessage(event: MatrixEvent, roomId: string): MessageEvent | null {
  if (event.isRedacted?.()) return deletedFallbackMessage(event, roomId)
  // Check encrypted states BEFORE inspecting content:
  // • type still 'm.room.encrypted' → decryption pending or not yet attempted
  // • isDecryptionFailure → attempted but failed (no keys)
  // In both cases getContent() returns either the raw ciphertext payload (no body/msgtype)
  // or the synthetic { msgtype: 'm.bad.encrypted' } object — show a placeholder either way.
  if (event.getType() === 'm.room.encrypted') return encryptedFallbackMessage(event, roomId)
  if (event.isEncrypted?.() && event.isDecryptionFailure?.()) return encryptedFallbackMessage(event, roomId)

  const content = event.getContent() as Record<string, unknown>
  const wireContent = (event.getWireContent?.() as Record<string, unknown> | undefined) || {}
  type RelationContent = { rel_type?: string; event_id?: string; 'm.in_reply_to'?: { event_id?: string }; is_falling_back?: boolean }
  const relation = (event.getRelation?.() as RelationContent | null) || null
  const mRelatesTo =
    relation ||
    ((wireContent['m.relates_to'] as RelationContent | undefined) ?? (content['m.relates_to'] as RelationContent | undefined))
  const replacesEventId =
    mRelatesTo?.rel_type === 'm.replace' && typeof mRelatesTo?.event_id === 'string'
      ? mRelatesTo.event_id
      : null
  const threadRootId =
    mRelatesTo?.rel_type === 'm.thread' && typeof mRelatesTo?.event_id === 'string'
      ? mRelatesTo.event_id
      : null
  const effectiveContent =
    ((wireContent['m.new_content'] as Record<string, unknown> | undefined) ||
      (content['m.new_content'] as Record<string, unknown> | undefined) ||
      content) as Record<string, unknown>
  if (
    (content as Record<string, unknown>).msgtype === 'm.bad.encrypted' ||
    String((content as Record<string, unknown>).body || '').includes('Unable to decrypt')
  ) return encryptedFallbackMessage(event, roomId)
  if (!effectiveContent.body && !effectiveContent.msgtype) return null

  const sender = event.getSender()
  if (!sender) return null
  const room = client?.getRoom(roomId)
  const member = room?.getMember(sender)

  const msgtype = String(effectiveContent.msgtype || content.msgtype || 'm.text')
  let type: MessageEvent['type'] = 'm.text'
  if (msgtype === 'm.image') type = 'm.image'
  else if (msgtype === 'm.file') type = 'm.file'
  else if (msgtype === 'm.video') type = 'm.video'
  else if (msgtype === 'm.audio') type = 'm.audio'
  else if (msgtype === 'm.notice') type = 'm.notice'
  else if (msgtype === 'm.emote') type = 'm.emote'

  // Show reply quote when:
  //   • Normal reply (no thread): always
  //   • In-thread reply with is_falling_back: false: genuine reply to a specific message, show it
  //   • In-thread reply with is_falling_back: true (or missing): just a fallback pointing to the root, skip
  const inReplyToId = mRelatesTo?.['m.in_reply_to']?.event_id as string | undefined
  const isGenuineInThreadReply = !!threadRootId && mRelatesTo?.is_falling_back === false
  const replyTo = inReplyToId && (!threadRootId || isGenuineInThreadReply) ? inReplyToId : null

  let imageUrl: string | undefined
  let imageInfo: MessageEvent['imageInfo']
  let thumbnailUrl: string | undefined
  let encryptedFile: EncryptedFileInfo | undefined
  let encryptedThumbnailFile: EncryptedFileInfo | undefined
  let fileUrl: string | undefined
  let fileName: string | undefined
  let fileSize: number | undefined

  if (type === 'm.image') {
    imageInfo = effectiveContent.info as MessageEvent['imageInfo']
    if (effectiveContent.file) {
      encryptedFile = effectiveContent.file as EncryptedFileInfo
      if ((effectiveContent.info as Record<string, unknown> | undefined)?.thumbnail_file) {
        encryptedThumbnailFile = (effectiveContent.info as Record<string, unknown>).thumbnail_file as EncryptedFileInfo
      }
    } else if (effectiveContent.url) {
      // Prefer direct media download over thumbnail endpoints for better compatibility.
      // Some homeservers/proxies fail thumbnail generation or auth on thumbnails.
      imageUrl = client?.mxcUrlToHttp(String(effectiveContent.url), undefined, undefined, undefined, false, true, true) || undefined
      const info = effectiveContent.info as Record<string, unknown> | undefined
      if (typeof info?.thumbnail_url === 'string') {
        thumbnailUrl = client?.mxcUrlToHttp(info.thumbnail_url, 400, 300, 'scale', false, true, true) || undefined
      }
    }
  }

  let audioDuration: number | undefined
  let isVoiceMessage = false

  if (type === 'm.file' || type === 'm.video' || type === 'm.audio') {
    fileName = String(effectiveContent.filename || effectiveContent.body || '')
    const info = effectiveContent.info as Record<string, unknown> | undefined
    fileSize = typeof info?.size === 'number' ? info.size : undefined
    if (effectiveContent.file) encryptedFile = effectiveContent.file as EncryptedFileInfo
    else if (effectiveContent.url) fileUrl = client?.mxcUrlToHttp(String(effectiveContent.url), undefined, undefined, undefined, false, true) || undefined
    if (type === 'm.video') {
      if (info?.thumbnail_file) encryptedThumbnailFile = info.thumbnail_file as EncryptedFileInfo
      if (typeof info?.thumbnail_url === 'string') {
        thumbnailUrl = client?.mxcUrlToHttp(info.thumbnail_url, 400, 300, 'scale', false, true) || undefined
      }
    }
    if (type === 'm.audio') {
      audioDuration = typeof info?.duration === 'number' ? info.duration : undefined
      const mscVoice = effectiveContent['org.matrix.msc3245.voice'] || effectiveContent['org.matrix.msc1767.audio']
      isVoiceMessage = !!mscVoice
    }
  }

  const senderAvatar = member ? memberAvatarHttpUrl(member) : null

  return {
    eventId: event.getId() || `${roomId}-${event.getTs()}`,
    roomId,
    sender,
    senderName: member?.name || sender,
    senderAvatar,
    content: String(effectiveContent.body || ''),
    htmlContent: (effectiveContent.formatted_body as string | undefined) || null,
    timestamp: event.getTs(),
    type,
    replacesEventId,
    replyTo,
    isEdited: !!content['m.new_content'] || !!replacesEventId,
    imageUrl,
    imageInfo,
    thumbnailUrl,
    fileName,
    fileUrl,
    fileSize,
    audioDuration,
    isVoiceMessage,
    encryptedFile,
    encryptedThumbnailFile,
    threadRootId,
    threadInfo: null,
  }
}

export async function sendMessage(roomId: string, body: string, replyToEventId?: string): Promise<void> {
  if (!client) return
  const content: Record<string, unknown> = { msgtype: 'm.text', body }
  if (replyToEventId) {
    content['m.relates_to'] = {
      'm.in_reply_to': {
        event_id: replyToEventId,
      },
    }
  }
  await client.sendMessage(roomId, content as any)
}

export async function sendThreadReply(
  roomId: string,
  threadRootId: string,
  body: string,
  replyToEventId?: string,
): Promise<void> {
  if (!client) return
  // When replying to a specific message inside the thread (not just the root),
  // set is_falling_back: false so clients render the quote correctly.
  const inReplyToId = replyToEventId ?? threadRootId
  const isFallingBack = !replyToEventId || replyToEventId === threadRootId
  const content = {
    msgtype: 'm.text',
    body,
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: threadRootId,
      'm.in_reply_to': { event_id: inReplyToId },
      is_falling_back: isFallingBack,
    },
  }
  await client.sendMessage(roomId, content as any)
}

export async function loadThreadMessages(roomId: string, threadRootId: string): Promise<void> {
  if (!client) return
  try {
    const matrixSdk = await getSDK()
    const result = await (client as any).http.authedRequest(
      'GET',
      `/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(threadRootId)}/m.thread`,
      { limit: 100, dir: 'f' },
      undefined,
      { prefix: '/_matrix/client/v1' },
    ) as { chunk?: Record<string, unknown>[] } | null

    const rawEvents = result?.chunk ?? []
    const matrixEvents = rawEvents.map((raw) => new matrixSdk.MatrixEvent(raw as any))

    // Decrypt all encrypted events in parallel before processing
    await Promise.all(
      matrixEvents
        .filter((e) => e.getType() === 'm.room.encrypted')
        .map(async (e) => {
          try { await client!.decryptEventIfNeeded(e) } catch { /* shown as fallback */ }
        }),
    )

    const messages: MessageEvent[] = []
    for (const matrixEvent of matrixEvents) {
      const type = matrixEvent.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') continue
      const msg = eventToMessage(matrixEvent, roomId)
      if (msg) messages.push(msg)
    }

    messages.sort((a, b) => a.timestamp - b.timestamp)
    useMessageStore.getState().setThreadMessages(threadRootId, messages)
    if (messages.length > 0) {
      const last = messages[messages.length - 1]
      useMessageStore.getState().updateThreadRootInfo(roomId, threadRootId, {
        replyCount: messages.length,
        lastReplyTs: last.timestamp,
        lastReplierAvatar: last.senderAvatar,
        lastReplierName: last.senderName,
      })
    }
  } catch (err) {
    console.warn('[WaifuTxT] loadThreadMessages failed:', err)
  }
}

export async function loadRoomThreads(roomId: string): Promise<ThreadSummary[]> {
  if (!client) return []
  const room = client.getRoom(roomId)
  if (!room) return []

  // Primary: Matrix spec GET /rooms/{roomId}/threads (MSC3856 / Matrix 1.4+)
  // Returns thread root events with bundled reply count + latest event.
  try {
    const matrixSdk = await getSDK()
    const result = await (client as any).http.authedRequest(
      'GET',
      `/rooms/${encodeURIComponent(roomId)}/threads`,
      { limit: 50 },
      undefined,
      { prefix: '/_matrix/client/v1' },
    ) as { chunk?: Record<string, unknown>[] } | null

    const chunk = result?.chunk ?? []
    if (chunk.length > 0) {
      // Build MatrixEvent instances for all root events
      const rootEvents = chunk.map((raw) => ({
        raw,
        event: new matrixSdk.MatrixEvent(raw as any),
      }))

      // Decrypt encrypted root events in parallel
      await Promise.all(
        rootEvents
          .filter(({ event }) => event.getType() === 'm.room.encrypted')
          .map(async ({ event }) => {
            try { await client!.decryptEventIfNeeded(event) } catch { /* shown as fallback */ }
          }),
      )

      const summaries: ThreadSummary[] = []
      for (const { raw, event: matrixEvent } of rootEvents) {
        const rootMsg = eventToMessage(matrixEvent, roomId)
        if (!rootMsg) continue

        const unsigned = raw.unsigned as Record<string, unknown> | undefined
        const relationsBundle = unsigned?.['m.relations'] as Record<string, unknown> | undefined
        const threadInfo = relationsBundle?.['m.thread'] as Record<string, unknown> | undefined
        const replyCount = typeof threadInfo?.count === 'number' ? threadInfo.count : 0
        const latestEventRaw = threadInfo?.latest_event as Record<string, unknown> | undefined
        const lastReplyTs = typeof latestEventRaw?.origin_server_ts === 'number'
          ? latestEventRaw.origin_server_ts
          : rootMsg.timestamp
        const latestSender = typeof latestEventRaw?.sender === 'string' ? latestEventRaw.sender : rootMsg.sender
        const latestMember = room.getMember(latestSender)

        summaries.push({
          rootMessage: rootMsg,
          replyCount,
          lastReplyTs,
          lastReplierName: latestMember?.name ?? latestSender,
          lastReplierAvatar: memberAvatarHttpUrl(latestMember),
        })
      }
      if (summaries.length > 0) {
        return summaries.sort((a, b) => b.lastReplyTs - a.lastReplyTs)
      }
    }
  } catch (err) {
    console.warn('[WaifuTxT] /rooms/threads API failed, trying SDK map:', err)
  }

  // Fallback A: SDK-native thread map (populated after sync bundles thread data)
  const sdkThreads = (room as any).threads as Map<string, any> | undefined
  if (sdkThreads && sdkThreads.size > 0) {
    const summaries: ThreadSummary[] = []
    for (const [, thread] of sdkThreads) {
      const rootEvent = thread.rootEvent as MatrixEvent | null
      if (!rootEvent) continue
      const rootMsg = eventToMessage(rootEvent, roomId)
      if (!rootMsg) continue
      const lastReplyEvent = thread.lastReply?.() as MatrixEvent | null
      const lastReplierMember = lastReplyEvent ? room.getMember(lastReplyEvent.getSender() ?? '') : null
      summaries.push({
        rootMessage: rootMsg,
        replyCount: thread.replyCount ?? 0,
        lastReplyTs: lastReplyEvent?.getTs() ?? rootMsg.timestamp,
        lastReplierName: lastReplierMember?.name || lastReplyEvent?.getSender() || rootMsg.senderName,
        lastReplierAvatar: memberAvatarHttpUrl(lastReplierMember),
      })
    }
    if (summaries.length > 0) return summaries.sort((a, b) => b.lastReplyTs - a.lastReplyTs)
  }

  // Fallback B: derive from what the store already knows (threadInfo or threadMessages)
  const store = useMessageStore.getState()
  const messages = store.getMessages(roomId)
  const summaries: ThreadSummary[] = []
  const seen = new Set<string>()

  for (const msg of messages) {
    if (!msg.threadInfo || msg.threadInfo.replyCount === 0) continue
    seen.add(msg.eventId)
    summaries.push({
      rootMessage: msg,
      replyCount: msg.threadInfo.replyCount,
      lastReplyTs: msg.threadInfo.lastReplyTs,
      lastReplierName: msg.threadInfo.lastReplierName,
      lastReplierAvatar: msg.threadInfo.lastReplierAvatar,
    })
  }

  for (const [rootEventId, replies] of store.threadMessages) {
    if (seen.has(rootEventId) || !replies.length) continue
    const rootMsg = messages.find((m) => m.eventId === rootEventId)
    if (!rootMsg) continue
    const last = replies[replies.length - 1]
    summaries.push({
      rootMessage: rootMsg,
      replyCount: replies.length,
      lastReplyTs: last.timestamp,
      lastReplierName: last.senderName,
      lastReplierAvatar: last.senderAvatar,
    })
  }

  return summaries.sort((a, b) => b.lastReplyTs - a.lastReplyTs)
}

export async function sendEditMessage(roomId: string, eventId: string, body: string): Promise<void> {
  if (!client) throw new Error('Client Matrix non initialisé')
  const nextBody = body.trim()
  if (!nextBody) throw new Error('Le message édité est vide')
  if (!eventId || !eventId.startsWith('$')) {
    throw new Error("Ce message n'est pas encore synchronisé avec le serveur")
  }

  const editContent = {
    msgtype: 'm.text',
    body: `* ${nextBody}`,
    'm.new_content': {
      msgtype: 'm.text',
      body: nextBody,
    },
    'm.relates_to': {
      rel_type: 'm.replace',
      event_id: eventId,
    },
  } as any

  try {
    await (client as any).sendEvent(roomId, 'm.room.message', editContent)
  } catch {
    // Some homeservers/SDK paths behave better with sendMessage; keep a fallback.
    await client.sendMessage(roomId, editContent)
  }
}

export async function joinRoom(roomId: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  await client.joinRoom(roomId)
}

export async function declineInvite(roomId: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  await client.leave(roomId)
}

export async function getOrCreateDmRoom(userId: string): Promise<string> {
  if (!client) throw new Error('Client non initialisé')
  const myUserId = client.getUserId()
  if (!myUserId) throw new Error('Utilisateur non identifié')

  const directMap =
    (((client as unknown as { getAccountData: (key: string) => { getContent: () => unknown } | null })
      .getAccountData('m.direct')
      ?.getContent() as Record<string, string[]>) || {})

  const knownDirectRooms = directMap[userId] || []
  for (const roomId of knownDirectRooms) {
    const room = client.getRoom(roomId)
    if (room && room.getMyMembership() === 'join') return roomId
  }

  // Fallback: detect an existing 1:1 room with this user.
  const existing = client.getRooms().find((room) => {
    if (room.getMyMembership() !== 'join') return false
    if (room.isSpaceRoom?.()) return false
    const members = room.getJoinedMembers().map((m) => m.userId)
    return members.includes(userId) && members.includes(myUserId) && members.length <= 2
  })
  if (existing) return existing.roomId

  // Create a fresh DM room.
  const created = await client.createRoom({
    is_direct: true,
    invite: [userId],
    preset: 'trusted_private_chat',
  } as any)
  return created.room_id
}

export function canUserCreateRoom(spaceId: string): boolean {
  if (!client) return false
  const room = client.getRoom(spaceId)
  if (!room) return false
  const userId = client.getUserId()
  if (!userId) return false

  const powerLevelsEvent = room.currentState.getStateEvents('m.room.power_levels', '')
  const powerLevels = (powerLevelsEvent?.getContent() as {
    state_default?: number
    events?: Record<string, number>
    users?: Record<string, number>
  }) ?? {}
  const userPowerLevel = powerLevels.users?.[userId] ?? room.getMember(userId)?.powerLevel ?? 0
  const requiredLevel = powerLevels.events?.['m.space.child'] ?? powerLevels.state_default ?? 50
  return userPowerLevel >= requiredLevel
}

export async function createRoom(
  name: string,
  options?: { topic?: string; visibility?: 'public' | 'private'; parentSpaceId?: string },
): Promise<string> {
  const readyClient = await ensureClientReady()
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('Le nom du salon est requis')
  const visibility = options?.visibility === 'public' ? 'public' : 'private'

  try {
    const created = await readyClient.createRoom({
      name: trimmedName,
      topic: options?.topic?.trim() || undefined,
      preset: visibility === 'public' ? 'public_chat' : 'private_chat',
      visibility,
    } as any)
    const newRoomId = created.room_id

    if (options?.parentSpaceId) {
      const homeserver = readyClient.getDomain() || readyClient.baseUrl.replace(/^https?:\/\//, '')
      await (readyClient as any).sendStateEvent(
        options.parentSpaceId,
        'm.space.child',
        { via: [homeserver] },
        newRoomId,
      )
    }

    return newRoomId
  } catch (err) {
    const errorData = err as { data?: { error?: string }; message?: string }
    const msg = errorData?.data?.error || errorData?.message || 'Impossible de créer le salon'
    throw new Error(msg)
  }
}

export async function createSpace(
  name: string,
  options?: { visibility?: 'public' | 'private' },
): Promise<string> {
  const readyClient = await ensureClientReady()
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('Le nom du serveur est requis')
  const visibility = options?.visibility === 'public' ? 'public' : 'private'

  try {
    const created = await readyClient.createRoom({
      name: trimmedName,
      topic: `Serveur ${trimmedName}`,
      preset: visibility === 'public' ? 'public_chat' : 'private_chat',
      visibility,
      creation_content: {
        type: 'm.space',
      },
    } as any)
    return created.room_id
  } catch (firstErr) {
    // Compatibility fallback for homeservers that reject preset/visibility combos for spaces.
    try {
      const created = await readyClient.createRoom({
        name: trimmedName,
        creation_content: {
          type: 'm.space',
        },
      } as any)
      return created.room_id
    } catch (fallbackErr) {
      const err = fallbackErr || firstErr
      const errorData = err as { data?: { error?: string }; message?: string }
      const msg = errorData?.data?.error || errorData?.message || 'Impossible de créer le serveur'
      throw new Error(msg)
    }
  }
}

function isMyVoiceMembership(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
  userId: string,
  deviceId?: string,
): boolean {
  const memberships = Array.isArray(session?.memberships) ? session.memberships : []
  for (const m of memberships) {
    if (!m || typeof m !== 'object') continue
    if (m.userId !== userId) continue
    if (deviceId && m.deviceId && m.deviceId !== deviceId) continue
    if (typeof m.isExpired === 'function' && m.isExpired()) continue
    return true
  }
  return false
}

export async function joinVoiceRoom(roomId: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  const room = client.getRoom(roomId)
  if (!room) throw new Error('Salon introuvable')

  const matrixSdk = await getSDK()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientAny = client as any
  const canUseGroupCall =
    typeof clientAny.getGroupCallForRoom === 'function' &&
    typeof clientAny.createGroupCall === 'function' &&
    typeof clientAny.waitUntilRoomReadyForGroupCalls === 'function'

  if (canUseGroupCall) {
    voiceDebugLog('join: using GroupCall path', { roomId })
    try {
      await clientAny.waitUntilRoomReadyForGroupCalls(roomId)
    } catch {
      // ignore readiness race and continue
      voiceDebugLog('join: waitUntilRoomReadyForGroupCalls failed (ignored)', { roomId })
    }

    // Discord-like behavior: one active voice room at a time.
    const prevVoiceRoom = useVoiceStore.getState().joinedRoomId
    if (prevVoiceRoom && prevVoiceRoom !== roomId) {
      cleanupVoiceStreams()
      useVoiceStore.getState().reset()
    }
    for (const r of client.getRooms()) {
      if (r.roomId === roomId) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const otherCall = clientAny.getGroupCallForRoom(r.roomId) as any
        if (otherCall?.hasLocalParticipant?.()) {
          voiceDebugLog('join: leaving previous GroupCall', { roomId: r.roomId })
          otherCall.leave?.()
        }
      } catch {
        voiceDebugLog('join: failed to leave previous GroupCall (ignored)', { roomId: r.roomId })
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let targetCall = clientAny.getGroupCallForRoom(roomId) as any
    if (!targetCall) {
      try {
        voiceDebugLog('join: creating GroupCall', { roomId })
        targetCall = await clientAny.createGroupCall(
          roomId,
          matrixSdk.GroupCallType.Voice,
          false,
          matrixSdk.GroupCallIntent.Room,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Another client may have created it in the meantime.
        if (!/already has an existing group call/i.test(msg)) {
          voiceDebugLog('join: createGroupCall failed', { roomId, msg })
          throw err
        }
        voiceDebugLog('join: GroupCall already exists, reloading', { roomId })
        targetCall = clientAny.getGroupCallForRoom(roomId)
      }
    }

    if (targetCall) {
      const alreadyInCall = !!targetCall.hasLocalParticipant?.()
      if (!alreadyInCall) {
        voiceDebugLog('join: entering GroupCall', { roomId })
        cleanupVoiceStreams()
        try {
          await targetCall.enter?.()
        } catch (enterErr) {
          const msg = enterErr instanceof Error ? enterErr.message : String(enterErr)
          if (/permission|denied|not allowed|notallowed/i.test(msg)) {
            throw new Error('Accès au microphone refusé. Autorise le micro dans les paramètres de ton navigateur.')
          }
          throw enterErr
        }
        try {
          await targetCall.setMicrophoneMuted?.(false)
        } catch {
          voiceDebugLog('join: unable to unmute mic after enter (ignored)', { roomId })
        }
      }
      await setupVoiceStreams(targetCall, matrixSdk)
      useVoiceStore.getState().setJoinedRoom(roomId)
      voiceDebugLog('join: GroupCall success', { roomId, alreadyInCall })
      syncRooms()
      setTimeout(() => {
        try { syncRooms() } catch { /* ignore */ }
      }, 800)
      return
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rtcManager = (client as any).matrixRTC
  if (!rtcManager || typeof rtcManager.getRoomSession !== 'function') {
    throw new Error('Fonction vocal non disponible')
  }
  voiceDebugLog('join: fallback MatrixRTC path', { roomId })

  const myUserId = client.getUserId()
  const myDeviceId = client.getDeviceId() || ''
  if (!myUserId) throw new Error('Utilisateur non identifié')

  // Discord-like behavior: one active voice channel at a time, switch in one click.
  for (const r of client.getRooms()) {
    if (r.roomId === roomId) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = (rtcManager.getActiveRoomSession?.(r) || rtcManager.getRoomSession(r)) as any
      if (!session) continue
      const iAmInThisSession = isMyVoiceMembership(session, myUserId, myDeviceId) || !!session.isJoined?.()
      if (iAmInThisSession) {
        await session.leaveRoomSession?.(5000)
      }
    } catch {
      // ignore room switch failures and keep trying target room
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targetSession = rtcManager.getRoomSession(room) as any
  if (!targetSession) throw new Error('Session vocale indisponible')

  const alreadyInTarget = isMyVoiceMembership(targetSession, myUserId, myDeviceId) || !!targetSession.isJoined?.()
  if (!alreadyInTarget) {
    // Some stacks require an explicit focus candidate. Reuse the oldest member transport when available.
    const oldest = targetSession.getOldestMembership?.()
    const preferredFocus = oldest?.getTransport?.(oldest)
    const fociPreferred = preferredFocus ? [preferredFocus] : []

    targetSession.joinRoomSession?.(
      fociPreferred,
      undefined,
      {
        callIntent: 'audio',
        notificationType: 'notification',
      },
    )
  }

  useVoiceStore.getState().setJoinedRoom(roomId)
  syncRooms()
  setTimeout(() => {
    try { syncRooms() } catch { /* ignore */ }
  }, 800)
}

export async function leaveVoiceRoom(roomId: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  const room = client.getRoom(roomId)
  if (!room) throw new Error('Salon introuvable')

  cleanupVoiceStreams()
  useVoiceStore.getState().reset()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientAny = client as any
  const canUseGroupCall =
    typeof clientAny.getGroupCallForRoom === 'function' &&
    typeof clientAny.waitUntilRoomReadyForGroupCalls === 'function'
  if (canUseGroupCall) {
    voiceDebugLog('leave: using GroupCall path', { roomId })
    try {
      await clientAny.waitUntilRoomReadyForGroupCalls(roomId)
    } catch {
      voiceDebugLog('leave: waitUntilRoomReadyForGroupCalls failed (ignored)', { roomId })
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const call = clientAny.getGroupCallForRoom(roomId) as any
      if (call?.hasLocalParticipant?.()) {
        voiceDebugLog('leave: leaving GroupCall', { roomId })
        call.leave?.()
        syncRooms()
        setTimeout(() => {
          try { syncRooms() } catch { /* ignore */ }
        }, 500)
        return
      }
      voiceDebugLog('leave: no local GroupCall participant, fallback MatrixRTC', { roomId })
    } catch {
      voiceDebugLog('leave: GroupCall leave failed, fallback MatrixRTC', { roomId })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rtcManager = (client as any).matrixRTC
  if (!rtcManager || typeof rtcManager.getRoomSession !== 'function') {
    throw new Error('Fonction vocal non disponible')
  }
  voiceDebugLog('leave: MatrixRTC path', { roomId })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = (rtcManager.getActiveRoomSession?.(room) || rtcManager.getRoomSession(room)) as any
  if (!session) return

  const myUserId = client.getUserId() || ''
  const myDeviceId = client.getDeviceId() || ''
  const iAmInThisSession = isMyVoiceMembership(session, myUserId, myDeviceId) || !!session.isJoined?.()
  if (!iAmInThisSession) {
    syncRooms()
    return
  }

  await session.leaveRoomSession?.(5000)
  syncRooms()
}

export async function sendImage(roomId: string, file: File): Promise<void> {
  if (!client) return
  const upload = await client.uploadContent(file)
  await client.sendMessage(roomId, {
    msgtype: 'm.image',
    body: file.name || 'image.png',
    url: upload.content_uri,
    info: { mimetype: file.type, size: file.size },
  } as any)
}

export async function sendFile(roomId: string, file: File): Promise<void> {
  if (!client) return
  const upload = await client.uploadContent(file)
  await client.sendMessage(roomId, {
    msgtype: 'm.file',
    body: file.name,
    filename: file.name,
    url: upload.content_uri,
    info: { mimetype: file.type, size: file.size },
  } as any)
}

export async function redactMessage(roomId: string, eventId: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  await client.redactEvent(roomId, eventId)
}

export function canUserRedact(roomId: string, senderId: string): boolean {
  if (!client) return false
  const userId = client.getUserId()
  if (!userId) return false
  if (senderId === userId) return true
  const room = client.getRoom(roomId)
  if (!room) return false
  const powerLevelsEvent = room.currentState.getStateEvents('m.room.power_levels', '')
  const powerLevels = (powerLevelsEvent?.getContent() as {
    redact?: number
    users?: Record<string, number>
  }) ?? {}
  const userPowerLevel = powerLevels.users?.[userId] ?? room.getMember(userId)?.powerLevel ?? 0
  const requiredLevel = powerLevels.redact ?? 50
  return userPowerLevel >= requiredLevel
}

export async function leaveRoom(roomId: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  await client.leave(roomId)
}

export async function renameRoom(roomId: string, name: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Le nom du salon est requis')
  await (client as any).sendStateEvent(roomId, 'm.room.name', { name: trimmed }, '')
}

export function canUserRenameRoom(roomId: string): boolean {
  if (!client) return false
  const room = client.getRoom(roomId)
  if (!room) return false
  const userId = client.getUserId()
  if (!userId) return false
  const powerLevelsEvent = room.currentState.getStateEvents('m.room.power_levels', '')
  const powerLevels = (powerLevelsEvent?.getContent() as {
    state_default?: number
    events?: Record<string, number>
    users?: Record<string, number>
  }) ?? {}
  const userPowerLevel = powerLevels.users?.[userId] ?? room.getMember(userId)?.powerLevel ?? 0
  const requiredLevel = powerLevels.events?.['m.room.name'] ?? powerLevels.state_default ?? 50
  return userPowerLevel >= requiredLevel
}

export async function sendVideo(roomId: string, file: File): Promise<void> {
  if (!client) return
  const upload = await client.uploadContent(file)
  await client.sendMessage(roomId, {
    msgtype: 'm.video',
    body: file.name || 'video.mp4',
    url: upload.content_uri,
    info: { mimetype: file.type, size: file.size },
  } as any)
}

export async function sendVoiceMessage(roomId: string, blob: Blob, durationMs: number): Promise<void> {
  if (!client) return
  const file = new File([blob], 'voice-message.ogg', { type: blob.type || 'audio/ogg' })
  const upload = await client.uploadContent(file)
  await client.sendMessage(roomId, {
    msgtype: 'm.audio',
    body: 'Message vocal',
    url: upload.content_uri,
    info: {
      mimetype: file.type,
      size: blob.size,
      duration: durationMs,
    },
    'org.matrix.msc3245.voice': {},
    'org.matrix.msc1767.audio': {
      duration: durationMs,
    },
  } as any)
}

export async function loadRoomHistory(roomId: string): Promise<boolean> {
  if (!client) return false
  const room = client.getRoom(roomId)
  if (!room) return false
  useMessageStore.getState().setLoadingHistory(true)
  try {
    const timeline = room.getLiveTimeline()
    const before = timeline.getEvents().length
    await client.scrollback(room, 30)
    const events = timeline.getEvents()
    const orderedIds: string[] = []
    const byId = new Map<string, MessageEvent>()
    const pendingEdits = new Map<string, MessageEvent>()
    for (const event of events) {
      if (event.getType() !== 'm.room.message' && event.getType() !== 'm.room.encrypted') continue
      const msg = eventToMessage(event, roomId)
      if (!msg) continue
      if (msg.threadRootId) {
        useMessageStore.getState().addThreadMessage(msg.threadRootId, msg)
        continue
      }
      if (msg.replacesEventId) {
        const existing = byId.get(msg.replacesEventId)
        if (existing) {
          byId.set(msg.replacesEventId, {
            ...existing,
            content: msg.content,
            htmlContent: msg.htmlContent,
            isEdited: true,
          })
        } else {
          const prevPending = pendingEdits.get(msg.replacesEventId)
          if (!prevPending || msg.timestamp >= prevPending.timestamp) {
            pendingEdits.set(msg.replacesEventId, msg)
          }
        }
        continue
      }
      if (!byId.has(msg.eventId)) orderedIds.push(msg.eventId)
      const pending = pendingEdits.get(msg.eventId)
      byId.set(
        msg.eventId,
        pending
          ? {
              ...msg,
              content: pending.content,
              htmlContent: pending.htmlContent,
              isEdited: true,
            }
          : msg,
      )
    }
    const messages = orderedIds.map((id) => byId.get(id)).filter((m): m is MessageEvent => !!m)
    useMessageStore.getState().setMessages(roomId, messages)
    return events.length > before
  } finally {
    useMessageStore.getState().setLoadingHistory(false)
  }
}

export async function loadInitialMessages(roomId: string): Promise<void> {
  if (!client) return
  const matrixSdk = await getSDK()
  const room = client.getRoom(roomId)
  if (!room) return
  const events = room.getLiveTimeline().getEvents()
  const orderedIds: string[] = []
  const byId = new Map<string, MessageEvent>()
  const pendingEdits = new Map<string, MessageEvent>()
  for (const event of events) {
    if (event.getType() !== 'm.room.message' && event.getType() !== 'm.room.encrypted') continue
    const msg = eventToMessage(event, roomId)
    if (msg) {
      if (msg.threadRootId) {
        useMessageStore.getState().addThreadMessage(msg.threadRootId, msg)
        continue
      }
      if (msg.replacesEventId) {
        const existing = byId.get(msg.replacesEventId)
        if (existing) {
          byId.set(msg.replacesEventId, {
            ...existing,
            content: msg.content,
            htmlContent: msg.htmlContent,
            isEdited: true,
          })
        } else {
          const prevPending = pendingEdits.get(msg.replacesEventId)
          if (!prevPending || msg.timestamp >= prevPending.timestamp) {
            pendingEdits.set(msg.replacesEventId, msg)
          }
        }
      } else {
        if (!byId.has(msg.eventId)) orderedIds.push(msg.eventId)
        const pending = pendingEdits.get(msg.eventId)
        byId.set(
          msg.eventId,
          pending
            ? {
                ...msg,
                content: pending.content,
                htmlContent: pending.htmlContent,
                isEdited: true,
              }
            : msg,
        )
      }
    }
    // Attach a decryption listener on history events so they update when keys
    // become available (e.g. after session verification or key backup restore).
    if (event.getType() === 'm.room.encrypted') {
      event.once(matrixSdk.MatrixEventEvent.Decrypted, () => {
        const decrypted = eventToMessage(event, roomId)
        if (!decrypted) return
        if (decrypted.replacesEventId) {
          applyMessageEdit(roomId, decrypted)
          const decryptedEventId = event.getId()
          if (decryptedEventId) {
            useMessageStore.getState().removeMessage(roomId, decryptedEventId)
          }
          return
        }
        if (decrypted.threadRootId) {
          const store = useMessageStore.getState()
          const existing = store.getThreadMessages(decrypted.threadRootId)
          const idx = existing.findIndex((m) => m.eventId === decrypted.eventId)
          if (idx !== -1) {
            const updated = [...existing]
            updated[idx] = decrypted
            store.setThreadMessages(decrypted.threadRootId, updated)
          } else {
            store.addThreadMessage(decrypted.threadRootId, decrypted)
          }
          return
        }
        useMessageStore.getState().replaceMessage(roomId, decrypted.eventId, decrypted)
        updateRoomLastMessage(roomId, decrypted)
      })
    }
  }
  const messages = orderedIds.map((id) => byId.get(id)).filter((m): m is MessageEvent => !!m)
  useMessageStore.getState().setMessages(roomId, messages)
  useMessageStore.getState().markRoomLoaded(roomId)
}

export async function loadRoomMembers(roomId: string): Promise<void> {
  if (!client) return
  const room = client.getRoom(roomId)
  if (!room) return

  const baseUrl = client.baseUrl
  const powerLevels: Record<string, number> =
    room.currentState.getStateEvents('m.room.power_levels')?.[0]?.getContent()?.users ?? {}

  let members: RoomMember[]

  try {
    // getJoinedRoomMembers always hits the server and returns ALL currently joined
    // members regardless of lazyLoadMembers or SDK cache state.
    const resp = await client.getJoinedRoomMembers(roomId)

    // SDK RoomMember objects carry avatar URL resolution and display names —
    // build a lookup so we can enrich the server list where available.
    const sdkMap = new Map(
      room.getMembers()
        .filter((m) => m.membership === 'join')
        .map((m) => [m.userId, m]),
    )

    members = Object.entries(resp.joined).map(([userId, info]) => {
      const sdkM = sdkMap.get(userId)
      let avatarUrl: string | null = null
      try {
        if (sdkM) {
          avatarUrl = memberAvatarHttpUrl(sdkM)
        } else if (info.avatar_url) {
          avatarUrl = mxcToAvatarHttpUrl(info.avatar_url as string)
        }
      } catch {
        // ignore
      }
      const p = client!.getUser(userId)?.presence
      const presence: RoomMember['presence'] =
        p === 'online' ? 'online' : p === 'unavailable' ? 'unavailable' : 'offline'
      return {
        userId,
        displayName: sdkM?.name ?? info.display_name ?? userId,
        avatarUrl,
        membership: 'join',
        powerLevel: powerLevels[userId] ?? 0,
        presence,
      }
    })
  } catch {
    // Fallback: populate SDK cache then read from it
    try { await room.loadMembersIfNeeded() } catch { /* ignore */ }
    members = room.getMembers().filter((m) => m.membership === 'join').map((m) => {
      let avatarUrl: string | null = null
      try {
        avatarUrl = memberAvatarHttpUrl(m)
      } catch { /* ignore */ }
      const p = client!.getUser(m.userId)?.presence
      const presence: RoomMember['presence'] =
        p === 'online' ? 'online' : p === 'unavailable' ? 'unavailable' : 'offline'
      return {
        userId: m.userId,
        displayName: m.name || m.userId,
        avatarUrl,
        membership: m.membership || 'join',
        powerLevel: powerLevels[m.userId] ?? 0,
        presence,
      }
    })
  }

  const store = useRoomStore.getState()
  // Seed presenceMap for members not yet tracked by real-time events.
  for (const m of members) {
    if (!(m.userId in store.presenceMap)) {
      store.updatePresence(m.userId, m.presence)
    }
    if (!(m.userId in store.statusMessageMap)) {
      const ownId = client!.getUserId()
      let seeded = false
      if (ownId === m.userId) {
        const stored = getStoredOwnStatusMessage().trim()
        if (stored) {
          store.setStatusMessage(m.userId, stored)
          seeded = true
        }
      }
      if (!seeded) {
        const u = client!.getUser(m.userId) as import('matrix-js-sdk').User | null
        const content = u?.events?.presence?.getContent?.() as Record<string, unknown> | undefined
        if (content && Object.prototype.hasOwnProperty.call(content, 'status_msg')) {
          const raw = String((content.status_msg as string | undefined) ?? '').trim()
          if (raw) store.setStatusMessage(m.userId, raw)
        } else if (u && typeof u.presenceStatusMsg === 'string' && u.presenceStatusMsg.trim()) {
          store.setStatusMessage(m.userId, u.presenceStatusMsg.trim())
        }
      }
    }
  }
  store.setMembers(roomId, members)
}

export function sendTyping(roomId: string, typing: boolean): void {
  try {
    client?.sendTyping(roomId, typing, typing ? 10000 : 0)
  } catch {
    // ignore
  }
}

export async function sendReadReceipt(roomId: string): Promise<void> {
  if (!client) return
  const room = client.getRoom(roomId)
  if (!room) return
  const events = room.getLiveTimeline().getEvents()
  const lastReadable = [...events]
    .reverse()
    .find((e) => e.getType() === 'm.room.message' || e.getType() === 'm.room.encrypted')
  if (!lastReadable) return
  try {
    await client.sendReadReceipt(lastReadable)
  } catch {
    // ignore read receipt errors
  }
}

export function isMessageReadByOthers(roomId: string, eventId: string, senderId: string): boolean {
  if (!client) return false
  const me = client.getUserId()
  if (!me || senderId !== me) return false
  const room = client.getRoom(roomId)
  if (!room) return false

  const timelineEvents = room.getLiveTimeline().getEvents()
  const timelineIds = timelineEvents.map((e) => e.getId()).filter((id): id is string => !!id)
  const messageIndex = timelineIds.indexOf(eventId)
  if (messageIndex === -1) return false

  const members = room.getJoinedMembers()
  for (const member of members) {
    if (!member.userId || member.userId === me) continue
    const readUpToId = room.getEventReadUpTo(member.userId)
    if (!readUpToId) continue
    const readIndex = timelineIds.indexOf(readUpToId)
    if (readIndex >= messageIndex) return true
  }
  return false
}

export function getMessageReadersAtEvent(roomId: string, eventId: string, senderId: string): string[] {
  if (!client) return []
  const me = client.getUserId()
  if (!me || senderId !== me) return []
  const room = client.getRoom(roomId)
  if (!room) return []
  const targetEvent = room.findEventById(eventId)
  if (!targetEvent) return []
  const readers = room.getUsersReadUpTo(targetEvent)
  return readers.filter((userId) => userId !== me)
}

export async function restoreKeyBackup(recoveryKey: string): Promise<{ imported: number; total: number }> {
  if (!client) throw new Error('Client non initialisé')
  const crypto = client.getCrypto()
  if (!crypto) throw new Error('Module crypto non disponible')

  const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api/recovery-key')
  const decodedKey = decodeRecoveryKey(recoveryKey.trim())
  const defaultKeyId = await client.secretStorage.getDefaultKeyId()
  if (!defaultKeyId) throw new Error('Aucune clé de secret storage configurée sur ce compte')
  pendingSecretStorageKey = { keyId: defaultKeyId, key: decodedKey }
  try {
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
  } finally {
    pendingSecretStorageKey = null
  }
  const result = await crypto.restoreKeyBackup()
  return { imported: result?.imported ?? 0, total: result?.total ?? 0 }
}

export interface DeviceInfo {
  deviceId: string
  displayName: string
  lastSeenIp: string | null
  lastSeenTs: number | null
  isCurrentDevice: boolean
}

function applyPresence(
  userId: string | undefined | null,
  raw: string | undefined | null,
  statusMsgUpdate?: string,
): void {
  if (!userId) return
  const presence = raw === 'online' ? 'online' : raw === 'unavailable' ? 'unavailable' : 'offline'
  useRoomStore.getState().updatePresence(userId, presence)
  if (statusMsgUpdate !== undefined) {
    let trimmed = statusMsgUpdate.trim()
    // Pour soi : la phrase enregistrée dans l'app (localStorage) prime sur m.presence —
    // sinon un autre client (ex. Element + Spotify) écrase avec "listening", etc.
    // Si l'utilisateur a vidé la phrase ici, on retombe sur la valeur serveur.
    if (client?.getUserId() === userId) {
      const stored = getStoredOwnStatusMessage().trim()
      trimmed = stored || trimmed
    }
    useRoomStore.getState().setStatusMessage(userId, trimmed || null)
  }
}

function seedPresenceFromUsers(): void {
  if (!client) return
  for (const user of client.getUsers()) {
    const content = user.events?.presence?.getContent?.() as Record<string, unknown> | undefined
    const sm =
      content && Object.prototype.hasOwnProperty.call(content, 'status_msg')
        ? String((content.status_msg as string | undefined) ?? '')
        : undefined
    applyPresence(user.userId, user.presence, sm)
  }
}

export function getOwnPresence(): 'online' | 'unavailable' | 'offline' {
  if (!client) return 'offline'
  const userId = client.getUserId()
  if (!userId) return 'offline'
  const p = client.getUser(userId)?.presence
  if (p === 'online') return 'online'
  if (p === 'unavailable') return 'unavailable'
  return 'offline'
}

export function getStoredOwnStatusMessage(): string {
  try {
    return localStorage.getItem(OWN_STATUS_MSG_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function getLocalPresencePreference(): 'online' | 'unavailable' | 'offline' {
  try {
    const stored = localStorage.getItem('waifutxt_presence')
    if (stored === 'online' || stored === 'unavailable' || stored === 'offline') return stored
  } catch {
    /* ignore */
  }
  return 'online'
}

function isPresenceDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem('waifutxt_debug_presence') === '1'
  } catch {
    return false
  }
}

/** Réapplique la phrase Paramètres → store (retour onglet, etc.). */
export function reapplyStoredOwnStatusToStore(): void {
  if (!client) return
  const uid = client.getUserId()
  if (!uid) return
  const stored = getStoredOwnStatusMessage().trim()
  if (stored) useRoomStore.getState().setStatusMessage(uid, stored)
}

export async function setOwnPresence(presence: 'online' | 'unavailable' | 'offline'): Promise<void> {
  if (!client) return
  const status_msg = getStoredOwnStatusMessage().slice(0, MAX_PRESENCE_STATUS_MSG_LEN)
  if (isPresenceDebugEnabled()) {
    console.info('[WaifuTxT presence] setOwnPresence → PUT …/presence/{userId}/status', {
      presence,
      status_msg,
    })
  }
  await client.setPresence({ presence, status_msg })
}

/**
 * Envoie la phrase au homeserver via PUT /presence/{userId}/status (matrix-js-sdk : client.setPresence).
 * Le corps JSON contient toujours `presence` + `status_msg` (Spec Matrix).
 */
export async function setOwnStatusMessage(text: string): Promise<void> {
  const c = await ensureClientReady()
  const userId = c.getUserId()
  if (!userId) throw new Error('Non connecté')
  const trimmed = text.trim().slice(0, MAX_PRESENCE_STATUS_MSG_LEN)
  try {
    localStorage.setItem(OWN_STATUS_MSG_STORAGE_KEY, trimmed)
  } catch {
    console.warn('[WaifuTxT] Échec localStorage pour waifutxt_status_msg — la phrase ne sera peut‑être pas mémorisée localement')
  }
  useRoomStore.getState().setStatusMessage(userId, trimmed || null)
  const presence = getLocalPresencePreference()
  if (isPresenceDebugEnabled()) {
    console.info('[WaifuTxT presence] setOwnStatusMessage → client.setPresence', {
      presence,
      status_msg: trimmed,
      userId,
    })
  }
  await c.setPresence({ presence, status_msg: trimmed })
}

export async function initOwnPresence(): Promise<void> {
  const presence = getLocalPresencePreference()
  // Optimistically push into presenceMap so the UI reflects it immediately,
  // before the server echoes the User.presence event back.
  const userId = client?.getUserId()
  if (userId) {
    useRoomStore.getState().updatePresence(userId, presence)
    const msg = getStoredOwnStatusMessage().trim()
    useRoomStore.getState().setStatusMessage(userId, msg || null)
  }
  await setOwnPresence(presence)
}

export function getOwnAvatarUrl(): string | null {
  if (!client) return null
  const userId = client.getUserId()
  if (!userId) return null
  for (const room of client.getRooms()) {
    const member = room.getMember(userId)
    if (!member) continue
    const url = memberAvatarHttpUrl(member)
    if (url) return url
  }
  const userObj = client.getUser(userId) as { avatarUrl?: string | null } | null
  const mxc = typeof userObj?.avatarUrl === 'string' ? userObj.avatarUrl : ''
  if (mxc) {
    const url = mxcToAvatarHttpUrl(mxc)
    if (url) return url
  }
  return null
}

/**
 * Uploads a cropped image to the homeserver media repo and sets the global Matrix profile avatar.
 */
export async function uploadProfileAvatar(imageBlob: Blob): Promise<{ mxcUrl: string; httpPreviewUrl: string | null }> {
  const c = await ensureClientReady()
  const userId = c.getUserId()
  if (!userId) throw new Error('Non connecté')

  const mime =
    imageBlob.type && imageBlob.type.startsWith('image/')
      ? imageBlob.type
      : 'image/png'
  const ext =
    mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'png'
  const file = new File([imageBlob], `avatar.${ext}`, { type: mime })

  const upload = await c.uploadContent(file)
  const contentUri = upload.content_uri
  if (!contentUri) throw new Error('Le serveur n’a pas renvoyé d’URI média')

  await c.setAvatarUrl(contentUri)

  const user = c.getUser(userId)
  user?.setAvatarUrl?.(contentUri)
  userProfileCache.delete(userId)
  roomJoinedMembersCache.clear()

  try {
    syncRooms()
  } catch {
    // ignore
  }

  const httpPreviewUrl = mxcToAvatarHttpUrl(contentUri)

  return { mxcUrl: contentUri, httpPreviewUrl }
}

/**
 * Uploads an animated (or static) GIF as the global Matrix avatar — no re-encoding, animation is kept.
 */
export async function uploadProfileAvatarGif(file: File): Promise<{ mxcUrl: string; httpPreviewUrl: string | null }> {
  const c = await ensureClientReady()
  const userId = c.getUserId()
  if (!userId) throw new Error('Non connecté')

  const filename = file.name.toLowerCase().endsWith('.gif') ? file.name : 'avatar.gif'
  const uploadFile = new File([file], filename, { type: 'image/gif' })

  const upload = await c.uploadContent(uploadFile)
  const contentUri = upload.content_uri
  if (!contentUri) throw new Error('Le serveur n’a pas renvoyé d’URI média')

  await c.setAvatarUrl(contentUri)

  const user = c.getUser(userId)
  user?.setAvatarUrl?.(contentUri)
  userProfileCache.delete(userId)
  roomJoinedMembersCache.clear()

  try {
    syncRooms()
  } catch {
    // ignore
  }

  const httpPreviewUrl = mxcToAvatarHttpUrl(contentUri)

  return { mxcUrl: contentUri, httpPreviewUrl }
}

export async function getSessions(): Promise<DeviceInfo[]> {
  if (!client) return []
  const myDeviceId = client.getDeviceId()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client as any).getDevices()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response.devices ?? []).map((d: any) => ({
    deviceId: d.device_id,
    displayName: d.display_name || d.device_id,
    lastSeenIp: d.last_seen_ip ?? null,
    lastSeenTs: d.last_seen_ts ?? null,
    isCurrentDevice: d.device_id === myDeviceId,
  }))
}

export async function renameSession(deviceId: string, name: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  await client.setDeviceDetails(deviceId, { display_name: name })
}

export async function deleteSession(deviceId: string, password: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  const userId = client.getUserId()
  if (!userId) throw new Error('Utilisateur non identifié')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any
  try {
    await c.deleteDevice(deviceId)
  } catch (err: unknown) {
    const e = err as { httpStatus?: number; status?: number; data?: { session?: string } }
    if (e?.httpStatus !== 401 && e?.status !== 401) throw err
    await c.deleteDevice(deviceId, {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: userId },
      password,
      session: e?.data?.session,
    })
  }
}

export async function isSessionVerified(): Promise<boolean> {
  if (!client) return false
  const crypto = client.getCrypto()
  if (!crypto) return false
  try {
    const userId = client.getUserId()
    const deviceId = client.getDeviceId()
    if (!userId || !deviceId) return false
    const status = await crypto.getDeviceVerificationStatus(userId, deviceId)
    return status?.crossSigningVerified === true
  } catch {
    return false
  }
}

export async function shouldShowKeyBackupBanner(): Promise<boolean> {
  if (!client) return false
  const crypto = client.getCrypto()
  if (!crypto) return false
  try {
    // If this device is cross-signing verified it can already read encrypted
    // messages — no need to prompt for key backup or verification.
    if (await isSessionVerified()) return false
    const activeBackupVersion = await crypto.getActiveSessionBackupVersion()
    if (!activeBackupVersion) return true
    const status = await crypto.getSecretStorageStatus()
    return status.secretStorageKeyValidityMap?.['m.megolm_backup.v1'] !== true
  } catch {
    return true
  }
}

function base64ToBytes(base64: string): Uint8Array {
  let b64 = base64.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function buildAuthenticatedMediaUrl(mxcUrl: string): string | null {
  if (!client) return null
  const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/)
  if (!match) return null
  const [, serverName, mediaId] = match
  return `${client.baseUrl}/_matrix/client/v1/media/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`
}

function appendAccessToken(url: string, accessToken: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`
}

export function getMediaUrlWithAccessToken(url: string): string | null {
  if (!client) return null
  const token = client.getAccessToken()
  if (!token) return null
  if (url.startsWith('mxc://')) {
    const auth = buildAuthenticatedMediaUrl(url)
    return auth ? appendAccessToken(auth, token) : null
  }
  return appendAccessToken(url, token)
}

/**
 * Full media download URL for an avatar MXC (no thumbnail). Thumbnails often flatten GIFs to a static frame;
 * the raw file keeps animation. Browser scales via CSS object-cover on <img>.
 */
export function mxcToAvatarHttpUrl(mxc: string | null | undefined): string | null {
  if (!client || !mxc || typeof mxc !== 'string' || !mxc.startsWith('mxc://')) return null
  try {
    const raw = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, false, true)
    if (!raw) return null
    return getMediaUrlWithAccessToken(raw) || raw
  } catch {
    return null
  }
}

function memberAvatarHttpUrl(member: import('matrix-js-sdk').RoomMember | null | undefined): string | null {
  if (!member) return null
  const mxc = member.getMxcAvatarUrl?.()
  return mxc ? mxcToAvatarHttpUrl(mxc) : null
}

export async function loadMediaWithAuth(url: string): Promise<string | null> {
  const cached = mediaBlobCache.get(url)
  if (cached) return cached
  const inflight = mediaBlobPromiseCache.get(url)
  if (inflight) return inflight

  const promise = (async () => {
    if (!client) return null
    const token = client.getAccessToken()
    const tokenUrl = getMediaUrlWithAccessToken(url)
    const candidates = [tokenUrl, url].filter((u): u is string => !!u)
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate)
        if (!res.ok) continue
        const blob = await res.blob()
        const blobUrl = URL.createObjectURL(blob)
        mediaBlobCache.set(url, blobUrl)
        return blobUrl
      } catch {
        // continue
      }

      // Some homeservers disallow access_token query auth and require Bearer token.
      if (token) {
        try {
          const res = await fetch(candidate, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (!res.ok) continue
          const blob = await res.blob()
          const blobUrl = URL.createObjectURL(blob)
          mediaBlobCache.set(url, blobUrl)
          return blobUrl
        } catch {
          // continue
        }
      }
    }
    return null
  })()

  mediaBlobPromiseCache.set(url, promise)
  promise.finally(() => mediaBlobPromiseCache.delete(url))
  return promise
}

export async function decryptMediaUrl(file: EncryptedFileInfo): Promise<string> {
  const cacheKey = file.url
  const cached = decryptedUrlCache.get(cacheKey)
  if (cached) return cached
  const inflight = decryptPromiseCache.get(cacheKey)
  if (inflight) return inflight

  const promise = (async () => {
    if (!client) throw new Error('Client not initialized')
    const authUrl =
      getMediaUrlWithAccessToken(file.url) ||
      buildAuthenticatedMediaUrl(file.url) ||
      client.mxcUrlToHttp(file.url)
    if (!authUrl) throw new Error('Cannot resolve media url')
    // Important: avoid Authorization header here to prevent CORS preflight failures.
    // Matrix web clients usually authenticate media via access_token query param.
    const response = await fetch(authUrl)
    if (!response.ok) throw new Error(`Media download failed: ${response.status}`)
    const encryptedData = await response.arrayBuffer()

    const keyData = base64ToBytes(file.key.k)
    const iv = base64ToBytes(file.iv)
    const ivArray = new Uint8Array(16)
    if (iv.length >= 16) {
      ivArray.set(iv.slice(0, 16))
    } else if (iv.length > 0) {
      ivArray.set(iv)
    }
    const keyBuffer = keyData.buffer.slice(keyData.byteOffset, keyData.byteOffset + keyData.byteLength) as ArrayBuffer
    const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CTR' }, false, ['decrypt'])
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: ivArray, length: 64 }, cryptoKey, encryptedData)
    const blobUrl = URL.createObjectURL(new Blob([decrypted]))
    decryptedUrlCache.set(cacheKey, blobUrl)
    return blobUrl
  })()

  decryptPromiseCache.set(cacheKey, promise)
  promise.finally(() => decryptPromiseCache.delete(cacheKey))
  return promise
}

export interface UrlPreviewData {
  title?: string
  description?: string
  imageUrl?: string
  siteName?: string
  videoUrl?: string     // og:video direct URL (mp4 or embed)
  videoType?: string    // og:video:type mime or "text/html"
  imageWidth?: number
  imageHeight?: number
}

const previewCache = new Map<string, UrlPreviewData | null>()

function normalizePreviewImageUrl(rawImage: string, pageUrl: string): string | undefined {
  if (!rawImage) return undefined
  if (rawImage.startsWith('mxc://')) {
    return client?.mxcUrlToHttp(rawImage, 400, 200, 'scale', false, true, true) || undefined
  }
  if (rawImage.startsWith('http://') || rawImage.startsWith('https://')) return rawImage
  if (rawImage.startsWith('//')) return `https:${rawImage}`
  try {
    return new URL(rawImage, pageUrl).toString()
  } catch {
    return undefined
  }
}

function pickFirstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string')
    return typeof first === 'string' ? first : undefined
  }
  return undefined
}

export async function getUrlPreview(url: string): Promise<UrlPreviewData | null> {
  const cached = previewCache.get(url)
  if (cached !== undefined) return cached
  if (!client) return null
  try {
    const data = await client.getUrlPreview(url, Date.now())
    if (!data) return null
    const og = data as Record<string, unknown>
    const imageCandidate =
      pickFirstString(og['og:image']) ||
      pickFirstString(og['og:image:url']) ||
      pickFirstString(og['og:image:secure_url']) ||
      pickFirstString(og['twitter:image']) ||
      pickFirstString(og['twitter:image:src']) ||
      pickFirstString(og['image'])

    const videoCandidate =
      pickFirstString(og['og:video:secure_url']) ||
      pickFirstString(og['og:video:url']) ||
      pickFirstString(og['og:video'])

    const imageWidthRaw = pickFirstString(og['og:image:width']) || pickFirstString(og['matrix:image:width'])
    const imageHeightRaw = pickFirstString(og['og:image:height']) || pickFirstString(og['matrix:image:height'])

    const result: UrlPreviewData = {
      title: pickFirstString(og['og:title']) || pickFirstString(og.title),
      description: pickFirstString(og['og:description']) || pickFirstString(og.description),
      siteName: pickFirstString(og['og:site_name']) || pickFirstString(og.site_name),
      imageUrl: imageCandidate ? normalizePreviewImageUrl(imageCandidate, url) : undefined,
      videoUrl: videoCandidate || undefined,
      videoType: pickFirstString(og['og:video:type']) || undefined,
      imageWidth: imageWidthRaw ? parseInt(imageWidthRaw, 10) || undefined : undefined,
      imageHeight: imageHeightRaw ? parseInt(imageHeightRaw, 10) || undefined : undefined,
    }
    if (!result.title && !result.description) {
      previewCache.set(url, null)
      return null
    }
    previewCache.set(url, result)
    return result
  } catch {
    previewCache.set(url, null)
    return null
  }
}

export function canUserPinMessages(roomId: string): boolean {
  if (!client) return false
  const room = client.getRoom(roomId)
  if (!room) return false
  const userId = client.getUserId()
  if (!userId) return false

  const powerLevelsEvent = room.currentState.getStateEvents('m.room.power_levels', '')
  const powerLevels = (powerLevelsEvent?.getContent() as {
    state_default?: number
    events?: Record<string, number>
    users?: Record<string, number>
  }) ?? {}
  const userPowerLevel = powerLevels.users?.[userId] ?? room.getMember(userId)?.powerLevel ?? 0
  const requiredLevel = powerLevels.events?.['m.room.pinned_events'] ?? powerLevels.state_default ?? 50
  return userPowerLevel >= requiredLevel
}

export function getPinnedEventIds(roomId: string): string[] {
  if (!client) return []
  const room = client.getRoom(roomId)
  if (!room) return []
  const pinEvent = room.currentState.getStateEvents('m.room.pinned_events', '')
  if (!pinEvent) return []
  const content = pinEvent.getContent() as { pinned?: string[] }
  return Array.isArray(content.pinned) ? content.pinned : []
}

export async function pinMessage(roomId: string, eventId: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  const current = getPinnedEventIds(roomId)
  if (current.includes(eventId)) return
  const pinned = [...current, eventId]
  // Optimistic update before server call
  useMessageStore.getState().setPinnedEventIds(roomId, pinned)
  try {
    await (client as any).sendStateEvent(roomId, 'm.room.pinned_events', { pinned }, '')
  } catch (err) {
    // Revert on failure
    useMessageStore.getState().setPinnedEventIds(roomId, current)
    throw err
  }
}

export async function unpinMessage(roomId: string, eventId: string): Promise<void> {
  if (!client) throw new Error('Client non initialisé')
  const current = getPinnedEventIds(roomId)
  const pinned = current.filter((id) => id !== eventId)
  // Optimistic update before server call
  useMessageStore.getState().setPinnedEventIds(roomId, pinned)
  try {
    await (client as any).sendStateEvent(roomId, 'm.room.pinned_events', { pinned }, '')
  } catch (err) {
    // Revert on failure
    useMessageStore.getState().setPinnedEventIds(roomId, current)
    throw err
  }
}

export async function loadPinnedMessages(roomId: string): Promise<MessageEvent[]> {
  if (!client) return []
  const matrixSdk = await getSDK()
  const pinnedIds = getPinnedEventIds(roomId)
  if (pinnedIds.length === 0) return []

  const room = client.getRoom(roomId)
  if (!room) return []

  const storeMessages = useMessageStore.getState().getMessages(roomId)
  const results: MessageEvent[] = []

  for (const eventId of pinnedIds) {
    try {
      const local = room.findEventById(eventId)
      if (local) {
        await client.decryptEventIfNeeded(local)
        const fromTimeline = eventToMessage(local, roomId)
        if (fromTimeline && !isEncryptedStorePlaceholder(fromTimeline)) {
          results.push(fromTimeline)
          continue
        }
      }

      const stored = storeMessages.find((m) => m.eventId === eventId)
      if (stored && !isEncryptedStorePlaceholder(stored)) {
        results.push(stored)
        continue
      }

      const rawEvent = await client.fetchRoomEvent(roomId, eventId) as Record<string, unknown>
      if (!rawEvent) continue
      const mxEvent = new matrixSdk.MatrixEvent({ ...rawEvent, room_id: roomId })
      await client.decryptEventIfNeeded(mxEvent)
      const msg = eventToMessage(mxEvent, roomId)
      if (msg) results.push(msg)
    } catch {
      // Event may have been redacted or inaccessible
    }
  }
  return results
}

/** @param _size ignored — avatars use full download URL for GIF compatibility */
export function resolveAvatarUrl(mxcUrl: string | null, _size = 48): string | null {
  return mxcToAvatarHttpUrl(mxcUrl)
}
