/**
 * Client for the steam-presence backend service.
 * The backend is reached via an nginx proxy at /api/steam/* in production,
 * overridable via VITE_STEAM_PRESENCE_BASE_URL for local dev.
 */

const BASE_URL =
  (import.meta.env.VITE_STEAM_PRESENCE_BASE_URL as string | undefined)?.replace(/\/+$/, '') ??
  '/api/steam'

export type SteamStatus = {
  game: string
  gameId: string | null
  since: number | null
  updatedAt: number
}

export type SteamLinkInfo = {
  linked: boolean
  steamId: string | null
  linkedAt: number | null
}

const STATUS_CACHE_TTL_MS = 30_000

type CacheEntry = { value: SteamStatus | null; fetchedAt: number }
const statusCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<SteamStatus | null>>()

export function clearSteamStatusCache(): void {
  statusCache.clear()
}

export async function getSteamStatus(matrixUserId: string): Promise<SteamStatus | null> {
  const now = Date.now()
  const cached = statusCache.get(matrixUserId)
  if (cached && now - cached.fetchedAt < STATUS_CACHE_TTL_MS) {
    return cached.value
  }
  const existing = inflight.get(matrixUserId)
  if (existing) return existing

  const promise = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/status/${encodeURIComponent(matrixUserId)}`, {
        method: 'GET',
      })
      if (!res.ok) return null
      const body = (await res.json()) as SteamStatus | null
      statusCache.set(matrixUserId, { value: body, fetchedAt: Date.now() })
      return body
    } catch {
      return null
    } finally {
      inflight.delete(matrixUserId)
    }
  })()

  inflight.set(matrixUserId, promise)
  return promise
}

export async function getOwnSteamLink(accessToken: string): Promise<SteamLinkInfo> {
  const res = await fetch(`${BASE_URL}/link/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`link/me failed: ${res.status}`)
  return (await res.json()) as SteamLinkInfo
}

export async function startSteamLink(accessToken: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/link/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`link/start failed: ${res.status}`)
  const body = (await res.json()) as { redirectUrl: string }
  return body.redirectUrl
}

export async function unlinkSteam(accessToken: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/link/me`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`unlink failed: ${res.status}`)
}
