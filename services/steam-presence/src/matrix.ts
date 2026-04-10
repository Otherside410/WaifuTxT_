import { request } from 'undici'
import { config } from './config.js'

/**
 * Verify a Matrix access token by calling /_matrix/client/v3/account/whoami.
 * Returns the canonical user_id if the token is valid, otherwise null.
 */
export async function verifyMatrixToken(accessToken: string): Promise<string | null> {
  try {
    const res = await request(`${config.matrixHomeserver}/_matrix/client/v3/account/whoami`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (res.statusCode !== 200) return null
    const body = (await res.body.json()) as { user_id?: string }
    return typeof body.user_id === 'string' ? body.user_id : null
  } catch {
    return null
  }
}
