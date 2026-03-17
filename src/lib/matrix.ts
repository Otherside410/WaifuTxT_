import type { MatrixSession, MessageEvent, RoomSummary, RoomMember, EncryptedFileInfo } from '../types/matrix'
import { useMessageStore } from '../stores/messageStore'
import { useRoomStore } from '../stores/roomStore'
import { setupVerificationListeners } from './verification'

type MatrixClient = import('matrix-js-sdk').MatrixClient
type MatrixEvent = import('matrix-js-sdk').MatrixEvent

let client: MatrixClient | null = null
let sdk: typeof import('matrix-js-sdk') | null = null
let pendingSecretStorageKey: { keyId: string; key: Uint8Array } | null = null
const mediaBlobCache = new Map<string, string>()
const mediaBlobPromiseCache = new Map<string, Promise<string | null>>()
const decryptedUrlCache = new Map<string, string>()
const decryptPromiseCache = new Map<string, Promise<string>>()

async function getSDK() {
  if (!sdk) sdk = await import('matrix-js-sdk')
  return sdk
}

export function getClient(): MatrixClient | null {
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
  try {
    await client.logout(true)
  } catch {
    // ignore
  }
  client.stopClient()
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

  client.on(matrixSdk.RoomEvent.Timeline, (event: MatrixEvent, room: import('matrix-js-sdk').Room | undefined) => {
    try {
      if (!room) return
      const type = event.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') return

      if (type === 'm.room.encrypted') {
        // Always show a placeholder immediately — Rust crypto is async so
        // isDecryptionFailure() may still be false at this point.
        const fallback = encryptedFallbackMessage(event, room.roomId)
        if (fallback) {
          useMessageStore.getState().addMessage(room.roomId, fallback)
          updateRoomLastMessage(room.roomId, fallback)
        }

        // Replace with real content once decryption completes (success or failure).
        event.once(matrixSdk.MatrixEventEvent.Decrypted, () => {
          const msg = eventToMessage(event, room.roomId)
          if (!msg) return
          if (msg.replacesEventId) {
            applyMessageEdit(room.roomId, msg)
            // This encrypted event is only the edit payload; remove its temporary placeholder.
            const decryptedEventId = event.getId()
            if (decryptedEventId) {
              useMessageStore.getState().removeMessage(room.roomId, decryptedEventId)
            }
            return
          }
          const store = useMessageStore.getState()
          // replaceMessage also appends when the event is not yet in the list.
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
        useMessageStore.getState().addMessage(room.roomId, msg)
        updateRoomLastMessage(room.roomId, msg)
      }
    } catch (err) {
      console.error('[WaifuTxT] Timeline event error:', err)
    }
  })

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
    applyPresence(user?.userId, user?.presence)
  })

  // Fallback: raw m.presence events arriving in the sync stream.
  // Covers homeservers where the SDK reEmitter is not wired for User events.
  client.on(matrixSdk.ClientEvent.Event, (event: MatrixEvent) => {
    if (event.getType() !== 'm.presence') return
    applyPresence(event.getSender(), event.getContent()?.presence)
  })

  setupVerificationListeners(client)
}

function syncRooms() {
  if (!client) return
  const matrixRooms = client.getRooms()
  const roomMap = new Map<string, RoomSummary>()
  const baseUrl = client.baseUrl
  const myUserId = client.getUserId() || ''
  const activeRoomId = useRoomStore.getState().activeRoomId

  for (const room of matrixRooms) {
    const createEvent = room.currentState.getStateEvents('m.room.create')?.[0]
    const isSpace = createEvent?.getContent()?.type === 'm.space'
    const roomType = (room.getType?.() || createEvent?.getContent()?.type || '') as string
    const hasCallState =
      room.currentState.getStateEvents('org.matrix.msc3401.call')?.length > 0 ||
      room.currentState.getStateEvents('org.matrix.msc3401.call.member')?.length > 0 ||
      room.currentState.getStateEvents('m.call.member')?.length > 0 ||
      room.currentState.getStateEvents('org.matrix.msc4143.rtc.member')?.length > 0
    const isVoice = /call|voice/i.test(roomType) || hasCallState

    const children: string[] = []
    if (isSpace) {
      const childEvents = room.currentState.getStateEvents('m.space.child')
      for (const ev of childEvents) {
        const stateKey = ev.getStateKey()
        if (ev.getContent()?.via && stateKey) children.push(stateKey)
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
      avatarUrl = room.getAvatarUrl(baseUrl, 48, 48, 'crop', false, true) || null
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
      mentionCount: room.roomId === activeRoomId ? 0 : (room.getUnreadNotificationCount('highlight') || 0),
      isSpace,
      isDirect,
      membership: room.getMyMembership(),
      children,
    })
  }

  useRoomStore.getState().setRooms(roomMap)
}

function encryptedFallbackMessage(event: MatrixEvent, roomId: string): MessageEvent | null {
  const sender = event.getSender()
  if (!sender) return null
  const room = client?.getRoom(roomId)
  const member = room?.getMember(sender)
  let senderAvatar: string | null = null
  try {
    senderAvatar = member?.getAvatarUrl(client!.baseUrl, 40, 40, 'crop', false, false, true) || null
  } catch {
    // ignore
  }
  return {
    eventId: event.getId() || `${roomId}-${event.getTs()}`,
    roomId,
    sender,
    senderName: member?.name || sender,
    senderAvatar,
    content: '🔒 Message chiffré — clé de récupération requise',
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
  // Check encrypted states BEFORE inspecting content:
  // • type still 'm.room.encrypted' → decryption pending or not yet attempted
  // • isDecryptionFailure → attempted but failed (no keys)
  // In both cases getContent() returns either the raw ciphertext payload (no body/msgtype)
  // or the synthetic { msgtype: 'm.bad.encrypted' } object — show a placeholder either way.
  if (event.getType() === 'm.room.encrypted') return encryptedFallbackMessage(event, roomId)
  if (event.isEncrypted?.() && event.isDecryptionFailure?.()) return encryptedFallbackMessage(event, roomId)

  const content = event.getContent() as Record<string, unknown>
  const wireContent = (event.getWireContent?.() as Record<string, unknown> | undefined) || {}
  type RelationContent = { rel_type?: string; event_id?: string; 'm.in_reply_to'?: { event_id?: string } }
  const relation = (event.getRelation?.() as RelationContent | null) || null
  const mRelatesTo =
    relation ||
    ((wireContent['m.relates_to'] as RelationContent | undefined) ?? (content['m.relates_to'] as RelationContent | undefined))
  const replacesEventId =
    mRelatesTo?.rel_type === 'm.replace' && typeof mRelatesTo?.event_id === 'string'
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

  const replyTo = (mRelatesTo?.['m.in_reply_to']?.event_id as string | undefined) || null

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
  }

  let senderAvatar: string | null = null
  try {
    senderAvatar = member?.getAvatarUrl(client!.baseUrl, 40, 40, 'crop', false, false, true) || null
  } catch {
    // ignore
  }

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
    encryptedFile,
    encryptedThumbnailFile,
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
          // Drop the fallback notice created before decryption for encrypted edit events.
          const decryptedEventId = event.getId()
          if (decryptedEventId) {
            useMessageStore.getState().removeMessage(roomId, decryptedEventId)
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
}

export async function loadRoomMembers(roomId: string): Promise<void> {
  if (!client) return
  const room = client.getRoom(roomId)
  if (!room) return
  try {
    await room.loadMembersIfNeeded()
  } catch {
    // ignore — we'll fall back to whatever is cached
  }
  const myUserId = client.getUserId()
  const matrixMembers = room.getMembers().filter((m) => m.membership === 'join')
  const baseUrl = client.baseUrl
  const members: RoomMember[] = matrixMembers.map((m) => {
    let avatarUrl: string | null = null
    try {
      avatarUrl = m.getAvatarUrl(baseUrl, 40, 40, 'crop', false, false, true) || null
    } catch {
      // ignore
    }
    const p = client!.getUser(m.userId)?.presence
    let presence: RoomMember['presence'] = 'offline'
    if (p === 'online') presence = 'online'
    else if (p === 'unavailable') presence = 'unavailable'
    return {
      userId: m.userId,
      displayName: m.name || m.userId,
      avatarUrl,
      membership: m.membership || 'join',
      powerLevel: room.currentState.getStateEvents('m.room.power_levels')?.[0]?.getContent()?.users?.[m.userId] || 0,
      presence,
    }
  })
  const store = useRoomStore.getState()
  // Seed presenceMap for members not yet tracked by real-time events,
  // so the member list shows correct status without waiting for a presence event.
  for (const m of members) {
    if (!(m.userId in store.presenceMap)) {
      store.updatePresence(m.userId, m.presence)
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

function applyPresence(userId: string | undefined | null, raw: string | undefined | null): void {
  if (!userId) return
  const presence = raw === 'online' ? 'online' : raw === 'unavailable' ? 'unavailable' : 'offline'
  useRoomStore.getState().updatePresence(userId, presence)
}

function seedPresenceFromUsers(): void {
  if (!client) return
  for (const user of client.getUsers()) {
    if (user.presence) applyPresence(user.userId, user.presence)
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

export async function setOwnPresence(presence: 'online' | 'unavailable' | 'offline'): Promise<void> {
  if (!client) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client as any).sendPresence({ presence })
}

export async function initOwnPresence(): Promise<void> {
  const stored = localStorage.getItem('waifutxt_presence')
  const presence: 'online' | 'unavailable' | 'offline' =
    stored === 'online' || stored === 'unavailable' || stored === 'offline' ? stored : 'online'
  // Optimistically push into presenceMap so the UI reflects it immediately,
  // before the server echoes the User.presence event back.
  const userId = client?.getUserId()
  if (userId) useRoomStore.getState().updatePresence(userId, presence)
  await setOwnPresence(presence)
}

export function getOwnAvatarUrl(): string | null {
  if (!client) return null
  const userId = client.getUserId()
  if (!userId) return null
  // Use the same RoomMember.getAvatarUrl() path as message avatars — it reads
  // from sync state already in memory, no network call needed.
  for (const room of client.getRooms()) {
    const member = room.getMember(userId)
    if (!member) continue
    try {
      const url = member.getAvatarUrl(client.baseUrl, 40, 40, 'crop', false, false, true)
      if (url) return url
    } catch {
      continue
    }
  }
  return null
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

export function resolveAvatarUrl(mxcUrl: string | null, size = 48): string | null {
  if (!mxcUrl || !client) return null
  try {
    return client.mxcUrlToHttp(mxcUrl, size, size, 'crop', false, true) || null
  } catch {
    return null
  }
}
