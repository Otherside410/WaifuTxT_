import { stmts, type LinkRow } from './db.js'
import { getPlayerSummaries } from './steam.js'
import { config } from './config.js'

let timer: NodeJS.Timeout | null = null

async function pollOnce(): Promise<void> {
  const links = stmts.allLinks.all() as LinkRow[]
  if (links.length === 0) return

  const bySteamId = new Map(links.map((l) => [l.steam_id, l.matrix_user_id]))
  const ids = [...bySteamId.keys()]

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    try {
      const players = await getPlayerSummaries(chunk)
      const now = Date.now()
      for (const p of players) {
        const matrixUserId = bySteamId.get(p.steamid)
        if (!matrixUserId) continue
        stmts.upsertStatus.run({
          matrix_user_id: matrixUserId,
          steam_id: p.steamid,
          game: p.gameextrainfo ?? null,
          game_id: p.gameid ?? null,
          since: p.gameid ? now : null,
          updated_at: now,
        })
      }
    } catch (err) {
      console.error('[steam-presence] poll chunk failed:', err)
    }
  }
}

export function startPolling(): void {
  if (timer) return
  void pollOnce().catch((err) => console.error('[steam-presence] initial poll failed:', err))
  timer = setInterval(() => {
    void pollOnce().catch((err) => console.error('[steam-presence] poll failed:', err))
  }, config.pollIntervalSec * 1000)
}

export function stopPolling(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
