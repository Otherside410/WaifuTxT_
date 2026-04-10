import Fastify from 'fastify'
import cors from '@fastify/cors'
import { randomBytes } from 'node:crypto'
import { config } from './config.js'
import { stmts, type LinkRow, type StatusRow } from './db.js'
import { verifyMatrixToken } from './matrix.js'
import { buildSteamLoginUrl, verifySteamAssertion } from './steam.js'
import { startPolling } from './poll.js'

const PENDING_TTL_MS = 15 * 60 * 1000

const app = Fastify({ logger: true })

await app.register(cors, {
  origin: config.allowedOrigin,
  credentials: false,
  methods: ['GET', 'POST', 'DELETE'],
})

function bearer(authorization: string | undefined): string | null {
  if (!authorization) return null
  const m = /^Bearer\s+(.+)$/i.exec(authorization)
  return m ? m[1] : null
}

/**
 * Step 1: front calls this with the user's Matrix access token.
 * We verify the token, create a short-lived nonce, and return the Steam redirect URL.
 */
app.post('/steam/link/start', async (req, reply) => {
  const token = bearer(req.headers.authorization)
  if (!token) return reply.code(401).send({ error: 'missing_bearer' })

  const matrixUserId = await verifyMatrixToken(token)
  if (!matrixUserId) return reply.code(401).send({ error: 'invalid_matrix_token' })

  stmts.purgePending.run(Date.now() - PENDING_TTL_MS)

  const nonce = randomBytes(24).toString('base64url')
  stmts.insertPending.run(nonce, matrixUserId, Date.now())

  const returnTo = `${config.publicBaseUrl}/steam/callback?nonce=${encodeURIComponent(nonce)}`
  const realm = new URL(config.publicBaseUrl).origin
  return { redirectUrl: buildSteamLoginUrl(returnTo, realm) }
})

/**
 * Step 2: Steam redirects the browser here with openid.* params.
 * We verify the assertion, resolve the nonce to a Matrix user id, and persist the link.
 */
app.get<{ Querystring: Record<string, string> }>('/steam/callback', async (req, reply) => {
  const q = req.query
  const nonce = q.nonce
  if (!nonce) return reply.redirect(`${config.frontendUrl}?steam=error&reason=missing_nonce`)

  const pending = stmts.takePending.get(nonce) as
    | { nonce: string; matrix_user_id: string; created_at: number }
    | undefined
  if (!pending || pending.created_at < Date.now() - PENDING_TTL_MS) {
    return reply.redirect(`${config.frontendUrl}?steam=error&reason=expired_nonce`)
  }
  stmts.deletePending.run(nonce)

  const steamId = await verifySteamAssertion(q)
  if (!steamId) {
    return reply.redirect(`${config.frontendUrl}?steam=error&reason=invalid_assertion`)
  }

  stmts.upsertLink.run(pending.matrix_user_id, steamId, Date.now())
  return reply.redirect(`${config.frontendUrl}?steam=linked`)
})

/**
 * Read API: public lookup of a user's current game.
 * Cached briefly at the edge by the front, no auth required.
 */
app.get<{ Params: { matrixUserId: string } }>('/steam/status/:matrixUserId', async (req, reply) => {
  const matrixUserId = decodeURIComponent(req.params.matrixUserId)
  const row = stmts.getStatus.get(matrixUserId) as StatusRow | undefined
  if (!row || !row.game) return reply.send(null)
  return reply.send({
    game: row.game,
    gameId: row.game_id,
    since: row.since,
    updatedAt: row.updated_at,
  })
})

/**
 * Check whether the caller has a Steam link (used by settings UI).
 */
app.get('/steam/link/me', async (req, reply) => {
  const token = bearer(req.headers.authorization)
  if (!token) return reply.code(401).send({ error: 'missing_bearer' })
  const matrixUserId = await verifyMatrixToken(token)
  if (!matrixUserId) return reply.code(401).send({ error: 'invalid_matrix_token' })
  const link = stmts.getLink.get(matrixUserId) as LinkRow | undefined
  return { linked: !!link, steamId: link?.steam_id ?? null, linkedAt: link?.linked_at ?? null }
})

/**
 * Unlink: remove the current user's Steam link and status.
 */
app.delete('/steam/link/me', async (req, reply) => {
  const token = bearer(req.headers.authorization)
  if (!token) return reply.code(401).send({ error: 'missing_bearer' })
  const matrixUserId = await verifyMatrixToken(token)
  if (!matrixUserId) return reply.code(401).send({ error: 'invalid_matrix_token' })
  stmts.deleteLink.run(matrixUserId)
  stmts.deleteStatus.run(matrixUserId)
  return { ok: true }
})

app.get('/steam/health', async () => ({ ok: true }))

startPolling()

app.listen({ host: '0.0.0.0', port: config.port }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
