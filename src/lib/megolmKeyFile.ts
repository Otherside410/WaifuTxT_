// Passphrase-encrypted room key file, same format as Element's "Export E2E room keys".
// Layout: version (1) | salt (16) | iv (16) | rounds (4, big-endian) | ciphertext | HMAC-SHA256 (32)
// wrapped in base64 between the BEGIN / END MEGOLM SESSION DATA markers.

const HEADER = '-----BEGIN MEGOLM SESSION DATA-----'
const TRAILER = '-----END MEGOLM SESSION DATA-----'
const DEFAULT_ROUNDS = 500_000
const LINE_LENGTH = 76

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('Le chiffrement du navigateur (WebCrypto) est indisponible : utilisez une connexion HTTPS.')
  }
  return subtle
}

async function deriveKeys(salt: Uint8Array<ArrayBuffer>, rounds: number, passphrase: string) {
  const subtle = getSubtle()
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-512' }, base, 512)
  const aesKey = await subtle.importKey('raw', bits.slice(0, 32), 'AES-CTR', false, ['encrypt', 'decrypt'])
  const hmacKey = await subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  return { aesKey, hmacKey }
}

export async function encryptRoomKeyFile(json: string, passphrase: string): Promise<string> {
  const subtle = getSubtle()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(16))
  // Clear bit 63 of the counter so it cannot overflow into the nonce half.
  iv[8] &= 0x7f
  const { aesKey, hmacKey } = await deriveKeys(salt, DEFAULT_ROUNDS, passphrase)

  const cipherText = new Uint8Array(
    await subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aesKey, new TextEncoder().encode(json)),
  )

  const payload = new Uint8Array(1 + 16 + 16 + 4 + cipherText.length + 32)
  payload[0] = 1
  payload.set(salt, 1)
  payload.set(iv, 17)
  new DataView(payload.buffer).setUint32(33, DEFAULT_ROUNDS)
  payload.set(cipherText, 37)
  const hmacOffset = 37 + cipherText.length
  const mac = await subtle.sign('HMAC', hmacKey, payload.subarray(0, hmacOffset))
  payload.set(new Uint8Array(mac), hmacOffset)

  const b64 = toBase64(payload)
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += LINE_LENGTH) lines.push(b64.slice(i, i + LINE_LENGTH))
  return `${HEADER}\n${lines.join('\n')}\n${TRAILER}\n`
}

export async function decryptRoomKeyFile(fileContent: string, passphrase: string): Promise<string> {
  const lines = fileContent.split(/\r?\n/).map((l) => l.trim())
  const start = lines.indexOf(HEADER)
  const end = lines.indexOf(TRAILER)
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Ce fichier n'est pas un export de clés de chiffrement valide.")
  }

  let data: Uint8Array<ArrayBuffer>
  try {
    data = fromBase64(lines.slice(start + 1, end).join(''))
  } catch {
    throw new Error('Fichier de clés corrompu (encodage invalide).')
  }
  if (data.length < 1 + 16 + 16 + 4 + 32) throw new Error('Fichier de clés tronqué ou corrompu.')
  if (data[0] !== 1) throw new Error("Version du fichier de clés non prise en charge.")

  const salt = data.slice(1, 17)
  const iv = data.slice(17, 33)
  const rounds = new DataView(data.buffer).getUint32(33)
  const hmacOffset = data.length - 32

  const { aesKey, hmacKey } = await deriveKeys(salt, rounds, passphrase)
  const subtle = getSubtle()
  const valid = await subtle.verify('HMAC', hmacKey, data.slice(hmacOffset), data.subarray(0, hmacOffset))
  if (!valid) throw new Error('Phrase secrète incorrecte ou fichier de clés corrompu.')

  const plain = await subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aesKey, data.slice(37, hmacOffset))
  return new TextDecoder().decode(plain)
}
