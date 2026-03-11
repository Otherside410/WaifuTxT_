import type { MatrixSession, MessageEvent, RoomSummary, RoomMember, EncryptedFileInfo } from '../types/matrix'
import { useAuthStore } from '../stores/authStore'
import { useRoomStore } from '../stores/roomStore'
import { useMessageStore } from '../stores/messageStore'

type MatrixClient = import('matrix-js-sdk').MatrixClient
type MatrixEvent = import('matrix-js-sdk').MatrixEvent

let client: MatrixClient | null = null
let sdk: typeof import('matrix-js-sdk') | null = null
let pendingSecretStorageKey: { keyId: string; key: Uint8Array } | null = null

async function getSDK() {
  if (!sdk) {
    sdk = await import('matrix-js-sdk')
  }
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

  const session: MatrixSession = {
    userId: response.user_id,
    accessToken: response.access_token,
    homeserver,
    deviceId: response.device_id,
  }

  tempClient.stopClient()
  return session
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
      getSecretStorageKey: async ({ keys }) => {
        if (!pendingSecretStorageKey) return null
        const { keyId, key } = pendingSecretStorageKey
        if (!(keyId in keys)) return null
        return [keyId, key]
      },
    },
  })

  try {
    console.log('[WaifuTxT] Initializing Rust crypto...')
    await client.initRustCrypto()
    console.log('[WaifuTxT] Rust crypto initialized')
  } catch (err) {
    console.warn('[WaifuTxT] Crypto init failed, E2EE rooms won\'t be readable:', err)
  }

  setupEventListeners(matrixSdk)

  await client.startClient({
    initialSyncLimit: 30,
    lazyLoadMembers: true,
  })
}

export async function logout(): Promise<void> {
  if (client) {
    try {
      await client.logout(true)
    } catch {
      // ignore
    }
    client.stopClient()
    client = null
  }
  useAuthStore.getState().logout()
  useRoomStore.getState().reset()
  useMessageStore.getState().reset()
}

function setupEventListeners(matrixSdk: typeof import('matrix-js-sdk')) {
  if (!client) return

  client.on(matrixSdk.ClientEvent.Sync, (state: string) => {
    if (state === 'PREPARED' || state === 'SYNCING') {
      try {
        syncRooms()
      } catch (err) {
        console.error('[WaifuTxT] syncRooms error:', err)
      }
    }
  })

  client.on(matrixSdk.RoomEvent.Timeline, (event: MatrixEvent, room: import('matrix-js-sdk').Room | undefined) => {
    try {
      if (!room) return
      const type = event.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') return

      if (type === 'm.room.encrypted') {
        if (event.isDecryptionFailure?.()) {
          const msg = encryptedFallbackMessage(event, room.roomId)
          if (msg) {
            useMessageStore.getState().addMessage(room.roomId, msg)
            updateRoomLastMessage(room.roomId, msg)
          }
        }

        event.once(matrixSdk.MatrixEventEvent.Decrypted, () => {
          try {
            if (event.getType() !== 'm.room.message') return
            const msg = eventToMessage(event, room.roomId)
            if (msg) {
              const store = useMessageStore.getState()
              store.replaceMessage(room.roomId, msg.eventId, msg)
              store.addMessage(room.roomId, msg)
              updateRoomLastMessage(room.roomId, msg)
            }
          } catch (err) {
            console.error('[WaifuTxT] Decrypted event error:', err)
          }
        })
        return
      }

      const msg = eventToMessage(event, room.roomId)
      if (msg) {
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
    } catch (err) {
      console.error('[WaifuTxT] Typing event error:', err)
    }
  })

  client.on(matrixSdk.RoomEvent.Receipt, () => {
    try {
      syncRooms()
    } catch (err) {
      console.error('[WaifuTxT] Receipt event error:', err)
    }
  })
}

function syncRooms() {
  if (!client) return

  const matrixRooms = client.getRooms()
  const roomMap = new Map<string, RoomSummary>()
  const baseUrl = client.baseUrl

  for (const room of matrixRooms) {
    try {
      const stateEvents = room.currentState.getStateEvents('m.room.create')
      const createEvent = stateEvents?.[0]
      const isSpace = createEvent?.getContent()?.type === 'm.space'

      const children: string[] = []
      if (isSpace) {
        const childEvents = room.currentState.getStateEvents('m.space.child')
        for (const ev of childEvents) {
          const stateKey = ev.getStateKey()
          if (ev.getContent()?.via && stateKey) {
            children.push(stateKey)
          }
        }
      }

      let isDirect = false
      try {
        const directMap = client!.getAccountData('m.direct')?.getContent() || {}
        isDirect = Object.values(directMap).some((roomIds) =>
          (roomIds as string[]).includes(room.roomId),
        )
      } catch {
        // m.direct might not be available yet
      }

      const timeline = room.getLiveTimeline().getEvents()
      const lastEvent = [...timeline].reverse().find((e) =>
        e.getType() === 'm.room.message' || e.getType() === 'm.room.encrypted',
      )
      const lastContent = lastEvent?.getContent()

      let avatarUrl: string | null = null
      try {
        avatarUrl = room.getAvatarUrl(baseUrl, 48, 48, 'crop') || null
      } catch {
        // avatar URL resolution can fail
      }

      let topic = ''
      try {
        topic = room.currentState.getStateEvents('m.room.topic')?.[0]?.getContent()?.topic || ''
      } catch {
        // topic might not exist
      }

      let lastMessageText = lastContent?.body || ''
      if (lastMessageText.includes('Unable to decrypt') || lastContent?.msgtype === 'm.bad.encrypted') {
        lastMessageText = '🔒 Message chiffré'
      }

      roomMap.set(room.roomId, {
        roomId: room.roomId,
        name: room.name || 'Sans nom',
        avatarUrl,
        topic,
        lastMessage: lastMessageText,
        lastMessageTs: lastEvent?.getTs() || 0,
        unreadCount: room.getUnreadNotificationCount('total') || 0,
        isSpace,
        isDirect,
        membership: room.getMyMembership(),
        children,
      })
    } catch (err) {
      console.error(`[WaifuTxT] Error processing room ${room.roomId}:`, err)
    }
  }

  useRoomStore.getState().setRooms(roomMap)
}

function encryptedFallbackMessage(event: MatrixEvent, roomId: string): MessageEvent | null {
  try {
    const sender = event.getSender()
    if (!sender) return null

    const room = client?.getRoom(roomId)
    const member = room?.getMember(sender)

    let senderAvatar: string | null = null
    try {
      senderAvatar = member?.getAvatarUrl(client!.baseUrl, 40, 40, 'crop', false, false) || null
    } catch { /* ignore */ }

    return {
      eventId: event.getId()!,
      roomId,
      sender,
      senderName: member?.name || sender,
      senderAvatar,
      content: '🔒 Message chiffré (impossible de déchiffrer)',
      htmlContent: null,
      timestamp: event.getTs(),
      type: 'm.notice',
      replyTo: null,
      isEdited: false,
    }
  } catch {
    return null
  }
}

function updateRoomLastMessage(roomId: string, msg: MessageEvent) {
  useRoomStore.getState().updateRoom(roomId, {
    lastMessage: msg.content,
    lastMessageTs: msg.timestamp,
  })
}

function eventToMessage(event: MatrixEvent, roomId: string): MessageEvent | null {
  try {
    if (event.isEncrypted?.() && event.isDecryptionFailure?.()) {
      return encryptedFallbackMessage(event, roomId)
    }

    const content = event.getContent()
    if (!content.body && !content.msgtype) return null

    if (content.msgtype === 'm.bad.encrypted' || content.body?.includes?.('Unable to decrypt')) {
      return encryptedFallbackMessage(event, roomId)
    }

    const sender = event.getSender()
    if (!sender) return null

    const room = client?.getRoom(roomId)
    const member = room?.getMember(sender)

    const msgtype = content.msgtype || 'm.text'
    let type: MessageEvent['type'] = 'm.text'
    if (msgtype === 'm.image') type = 'm.image'
    else if (msgtype === 'm.file') type = 'm.file'
    else if (msgtype === 'm.video') type = 'm.video'
    else if (msgtype === 'm.audio') type = 'm.audio'
    else if (msgtype === 'm.notice') type = 'm.notice'
    else if (msgtype === 'm.emote') type = 'm.emote'

    const relatesTo = content['m.relates_to']
    const replyTo = relatesTo?.['m.in_reply_to']?.event_id || null

    let imageUrl: string | undefined
    let imageInfo: MessageEvent['imageInfo']
    let thumbnailUrl: string | undefined
    let encryptedFile: EncryptedFileInfo | undefined
    let encryptedThumbnailFile: EncryptedFileInfo | undefined

    if (type === 'm.image') {
      imageInfo = content.info
      if (content.file) {
        encryptedFile = content.file as EncryptedFileInfo
        if (content.info?.thumbnail_file) {
          encryptedThumbnailFile = content.info.thumbnail_file as EncryptedFileInfo
        }
      } else if (content.url) {
        imageUrl = client?.mxcUrlToHttp(content.url, 800, 600, 'scale') || undefined
        if (content.info?.thumbnail_url) {
          thumbnailUrl = client?.mxcUrlToHttp(content.info.thumbnail_url, 400, 300, 'scale') || undefined
        }
      }
    }

    let fileUrl: string | undefined
    let fileName: string | undefined
    let fileSize: number | undefined
    if (type === 'm.file') {
      fileName = content.filename || content.body
      fileSize = content.info?.size
      if (content.file) {
        encryptedFile = content.file as EncryptedFileInfo
      } else if (content.url) {
        fileUrl = client?.mxcUrlToHttp(content.url) || undefined
      }
    }

    if (type === 'm.video') {
      fileName = content.filename || content.body
      fileSize = content.info?.size
      if (content.file) {
        encryptedFile = content.file as EncryptedFileInfo
        if (content.info?.thumbnail_file) {
          encryptedThumbnailFile = content.info.thumbnail_file as EncryptedFileInfo
        }
      } else if (content.url) {
        fileUrl = client?.mxcUrlToHttp(content.url) || undefined
      }
      if (content.info?.thumbnail_url) {
        thumbnailUrl = client?.mxcUrlToHttp(content.info.thumbnail_url, 400, 300, 'scale') || undefined
      }
    }

    if (type === 'm.audio') {
      fileName = content.filename || content.body
      fileSize = content.info?.size
      if (content.file) {
        encryptedFile = content.file as EncryptedFileInfo
      } else if (content.url) {
        fileUrl = client?.mxcUrlToHttp(content.url) || undefined
      }
    }

    let senderAvatar: string | null = null
    try {
      senderAvatar = member?.getAvatarUrl(client!.baseUrl, 40, 40, 'crop', false, false) || null
    } catch {
      // avatar might fail
    }

    return {
      eventId: event.getId()!,
      roomId,
      sender,
      senderName: member?.name || sender,
      senderAvatar,
      content: content.body || '',
      htmlContent: content.formatted_body || null,
      timestamp: event.getTs(),
      type,
      replyTo,
      isEdited: !!content['m.new_content'],
      imageUrl,
      imageInfo,
      thumbnailUrl,
      fileName,
      fileUrl,
      fileSize,
      encryptedFile,
      encryptedThumbnailFile,
    }
  } catch (err) {
    console.error('[WaifuTxT] eventToMessage error:', err)
    return null
  }
}

export async function sendMessage(roomId: string, body: string): Promise<void> {
  if (!client) return
  await client.sendMessage(roomId, {
    msgtype: 'm.text',
    body,
  })
}

export async function sendImage(roomId: string, file: File): Promise<void> {
  if (!client) return
  const upload = await client.uploadContent(file)
  await client.sendMessage(roomId, {
    msgtype: 'm.image',
    body: file.name,
    url: upload.content_uri,
    info: {
      mimetype: file.type,
      size: file.size,
    },
  })
}

export async function sendFile(roomId: string, file: File): Promise<void> {
  if (!client) return
  const upload = await client.uploadContent(file)
  await client.sendMessage(roomId, {
    msgtype: 'm.file',
    body: file.name,
    url: upload.content_uri,
    info: {
      mimetype: file.type,
      size: file.size,
    },
  })
}

export async function loadRoomHistory(roomId: string): Promise<boolean> {
  if (!client) return false
  const room = client.getRoom(roomId)
  if (!room) return false

  useMessageStore.getState().setLoadingHistory(true)

  try {
    const timeline = room.getLiveTimeline()
    const result = await client.paginateEventTimeline(timeline, { backwards: true, limit: 50 })

    if (result) {
      const events = timeline.getEvents()
      const messages: MessageEvent[] = []
      for (const event of events) {
        const type = event.getType()
        if (type === 'm.room.message') {
          const msg = eventToMessage(event, roomId)
          if (msg) messages.push(msg)
        } else if (type === 'm.room.encrypted') {
          if (event.isDecryptionFailure?.()) {
            const msg = encryptedFallbackMessage(event, roomId)
            if (msg) messages.push(msg)
          }
        }
      }
      useMessageStore.getState().setMessages(roomId, messages)
    }

    return result
  } finally {
    useMessageStore.getState().setLoadingHistory(false)
  }
}

export async function loadInitialMessages(roomId: string): Promise<void> {
  if (!client) return
  const room = client.getRoom(roomId)
  if (!room) return

  const timeline = room.getLiveTimeline()
  const events = timeline.getEvents()
  const messages: MessageEvent[] = []

  for (const event of events) {
    const type = event.getType()
    if (type === 'm.room.message') {
      const msg = eventToMessage(event, roomId)
      if (msg) messages.push(msg)
    } else if (type === 'm.room.encrypted') {
      if (event.isDecryptionFailure?.()) {
        const msg = encryptedFallbackMessage(event, roomId)
        if (msg) messages.push(msg)
      }
    }
  }

  useMessageStore.getState().setMessages(roomId, messages)
}

export function loadRoomMembers(roomId: string): void {
  if (!client) return
  const room = client.getRoom(roomId)
  if (!room) return

  try {
    const matrixMembers = room.getJoinedMembers()
    const baseUrl = client.baseUrl
    const members: RoomMember[] = matrixMembers.map((m) => {
      let avatarUrl: string | null = null
      try {
        avatarUrl = m.getAvatarUrl(baseUrl, 40, 40, 'crop', false, false) || null
      } catch {
        // ignore
      }

      return {
        userId: m.userId,
        displayName: m.name || m.userId,
        avatarUrl,
        membership: m.membership || 'join',
        powerLevel: room.currentState.getStateEvents('m.room.power_levels')?.[0]
          ?.getContent()?.users?.[m.userId] || 0,
        presence: 'offline' as const,
      }
    })

    members.sort((a, b) => {
      if (a.powerLevel !== b.powerLevel) return b.powerLevel - a.powerLevel
      return a.displayName.localeCompare(b.displayName)
    })

    useRoomStore.getState().setMembers(roomId, members)
  } catch (err) {
    console.error(`[WaifuTxT] loadRoomMembers error for ${roomId}:`, err)
  }
}

export function sendTyping(roomId: string, typing: boolean): void {
  try {
    client?.sendTyping(roomId, typing, typing ? 10000 : 0)
  } catch {
    // ignore typing errors
  }
}

export async function restoreKeyBackup(recoveryKey: string): Promise<{ imported: number; total: number }> {
  if (!client) throw new Error('Client non initialisé')

  const crypto = client.getCrypto()
  if (!crypto) throw new Error('Module crypto non disponible')

  console.log('[WaifuTxT] Starting key backup restore...')

  const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api/recovery-key')

  let decodedKey: Uint8Array
  try {
    decodedKey = decodeRecoveryKey(recoveryKey.trim())
    console.log('[WaifuTxT] Recovery key decoded, length:', decodedKey.length)
  } catch (err) {
    console.error('[WaifuTxT] Failed to decode recovery key:', err)
    throw new Error('Clé de récupération invalide (format incorrect)')
  }

  const defaultKeyId = await client.secretStorage.getDefaultKeyId()
  if (!defaultKeyId) throw new Error('Aucune clé de secret storage configurée sur ce compte')

  console.log('[WaifuTxT] Default SS key ID:', defaultKeyId)

  const keyInfo = await client.secretStorage.getKey(defaultKeyId)
  if (!keyInfo) throw new Error('Impossible de récupérer les infos de la clé de secret storage')

  const valid = await client.secretStorage.checkKey(decodedKey, keyInfo[1] as import('matrix-js-sdk/lib/secret-storage').SecretStorageKeyDescriptionAesV1)
  if (!valid) throw new Error('Clé de récupération incorrecte — ne correspond pas au secret storage')

  console.log('[WaifuTxT] Recovery key verified against secret storage')

  pendingSecretStorageKey = { keyId: defaultKeyId, key: decodedKey }

  try {
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
    console.log('[WaifuTxT] Backup key loaded from secret storage')
  } catch (err) {
    console.error('[WaifuTxT] loadSessionBackupPrivateKeyFromSecretStorage failed:', err)
    throw err
  } finally {
    pendingSecretStorageKey = null
  }

  try {
    console.log('[WaifuTxT] Calling restoreKeyBackup()...')
    const result = await crypto.restoreKeyBackup()
    console.log('[WaifuTxT] Restore result:', JSON.stringify(result))
    return { imported: result?.imported ?? 0, total: result?.total ?? 0 }
  } catch (err) {
    console.error('[WaifuTxT] restoreKeyBackup() failed:', err)
    throw err
  }
}

const decryptedUrlCache = new Map<string, string>()
const decryptPromiseCache = new Map<string, Promise<string>>()

function base64ToBytes(base64: string): Uint8Array {
  let b64 = base64.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  const binStr = atob(b64)
  const bytes = new Uint8Array(binStr.length)
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i)
  return bytes
}

function buildAuthenticatedMediaUrl(mxcUrl: string): string | null {
  if (!client) return null
  const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/)
  if (!match) return null
  const [, serverName, mediaId] = match
  return `${client.baseUrl}/_matrix/client/v1/media/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`
}

export async function decryptMediaUrl(file: EncryptedFileInfo): Promise<string> {
  const cacheKey = file.url
  const cached = decryptedUrlCache.get(cacheKey)
  if (cached) return cached

  const inflight = decryptPromiseCache.get(cacheKey)
  if (inflight) return inflight

  const promise = (async () => {
    if (!client) throw new Error('Client not initialized')

    const accessToken = client.getAccessToken()
    const authUrl = buildAuthenticatedMediaUrl(file.url)
    const legacyUrl = client.mxcUrlToHttp(file.url)
    const url = authUrl || legacyUrl
    if (!url) throw new Error('Cannot resolve mxc URL: ' + file.url)

    let response = await fetch(url, {
      headers: accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {},
    })

    if (!response.ok && authUrl && legacyUrl && authUrl !== legacyUrl) {
      response = await fetch(legacyUrl)
    }

    if (!response.ok) throw new Error(`Media download failed: ${response.status}`)

    const encryptedData = await response.arrayBuffer()

    const keyData = base64ToBytes(file.key.k)
    const iv = base64ToBytes(file.iv)
    const ivArray = new Uint8Array(16)
    ivArray.set(iv.slice(0, 8))

    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'AES-CTR' }, false, ['decrypt'],
    )

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter: ivArray, length: 64 },
      cryptoKey,
      encryptedData,
    )

    const mimetype = file.url.endsWith('.png') ? 'image/png' : 'application/octet-stream'
    const blob = new Blob([decrypted], { type: mimetype })
    const blobUrl = URL.createObjectURL(blob)
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
}

const previewCache = new Map<string, UrlPreviewData | null>()

export async function getUrlPreview(url: string): Promise<UrlPreviewData | null> {
  const cached = previewCache.get(url)
  if (cached !== undefined) return cached

  if (!client) return null

  try {
    const data = await client.getUrlPreview(url, Date.now())
    if (!data) { previewCache.set(url, null); return null }

    const ogData = data as Record<string, unknown>
    const title = ogData['og:title'] as string | undefined
    const description = ogData['og:description'] as string | undefined
    const siteName = ogData['og:site_name'] as string | undefined
    const mxcImage = ogData['og:image'] as string | undefined

    if (!title && !description) { previewCache.set(url, null); return null }

    let imageUrl: string | undefined
    if (mxcImage && mxcImage.startsWith('mxc://')) {
      imageUrl = client.mxcUrlToHttp(mxcImage, 400, 200, 'scale') || undefined
    }

    const result: UrlPreviewData = { title, description, imageUrl, siteName }
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
    return client.mxcUrlToHttp(mxcUrl, size, size, 'crop')
  } catch {
    return null
  }
}
