import { request } from 'undici'
import { config } from './config.js'

const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login'
const STEAM_ID_PATTERN = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/

/**
 * Build the Steam OpenID 2.0 redirect URL.
 * The user's browser is sent here; Steam authenticates them and redirects back to returnTo.
 */
export function buildSteamLoginUrl(returnTo: string, realm: string): string {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  })
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`
}

/**
 * Verify a Steam OpenID callback by replaying the parameters back to Steam with
 * openid.mode=check_authentication. Returns the 17-digit SteamID64 on success.
 */
export async function verifySteamAssertion(query: Record<string, string>): Promise<string | null> {
  if (query['openid.mode'] !== 'id_res') return null

  const claimed = query['openid.claimed_id']
  const match = claimed?.match(STEAM_ID_PATTERN)
  if (!match) return null
  const steamId = match[1]

  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) body.set(k, v)
  body.set('openid.mode', 'check_authentication')

  const res = await request(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (res.statusCode !== 200) return null
  const text = await res.body.text()
  if (!/is_valid\s*:\s*true/i.test(text)) return null

  return steamId
}

export type SteamPlayerSummary = {
  steamid: string
  personaname?: string
  gameid?: string
  gameextrainfo?: string
}

/**
 * Fetch player summaries for up to 100 steam ids in one call.
 */
export async function getPlayerSummaries(steamIds: string[]): Promise<SteamPlayerSummary[]> {
  if (steamIds.length === 0) return []
  const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/')
  url.searchParams.set('key', config.steamApiKey)
  url.searchParams.set('steamids', steamIds.slice(0, 100).join(','))

  const res = await request(url.toString(), { method: 'GET' })
  if (res.statusCode !== 200) {
    throw new Error(`Steam API returned ${res.statusCode}`)
  }
  const json = (await res.body.json()) as { response?: { players?: SteamPlayerSummary[] } }
  return json.response?.players ?? []
}
