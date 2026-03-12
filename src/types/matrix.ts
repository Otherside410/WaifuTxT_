export interface MatrixSession {
  userId: string
  accessToken: string
  homeserver: string
  deviceId: string
}

export interface RoomSummary {
  roomId: string
  name: string
  avatarUrl: string | null
  roomType?: string
  isVoice?: boolean
  topic: string
  lastMessage: string
  lastMessageTs: number
  unreadCount: number
  isSpace: boolean
  isDirect: boolean
  membership: string
  children: string[]
}

export interface EncryptedFileInfo {
  url: string
  key: { alg: string; key_ops: string[]; kty: string; k: string; ext: boolean }
  iv: string
  hashes: { sha256: string }
  v: string
}

export interface MessageEvent {
  eventId: string
  roomId: string
  sender: string
  senderName: string
  senderAvatar: string | null
  content: string
  htmlContent: string | null
  timestamp: number
  type: 'm.text' | 'm.image' | 'm.file' | 'm.video' | 'm.audio' | 'm.notice' | 'm.emote'
  replyTo: string | null
  isEdited: boolean
  imageUrl?: string
  imageInfo?: { w: number; h: number; mimetype: string; size: number }
  thumbnailUrl?: string
  fileName?: string
  fileUrl?: string
  fileSize?: number
  encryptedFile?: EncryptedFileInfo
  encryptedThumbnailFile?: EncryptedFileInfo
}

export interface RoomMember {
  userId: string
  displayName: string
  avatarUrl: string | null
  membership: string
  powerLevel: number
  presence: 'online' | 'offline' | 'unavailable'
}

export interface TypingState {
  roomId: string
  userIds: string[]
}
