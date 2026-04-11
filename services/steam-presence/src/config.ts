function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

export const config = {
  steamApiKey: required('STEAM_API_KEY'),
  matrixHomeserver: optional('MATRIX_HOMESERVER', 'https://matrix.org').replace(/\/+$/, ''),
  publicBaseUrl: required('PUBLIC_BASE_URL').replace(/\/+$/, ''),
  frontendUrl: required('FRONTEND_URL').replace(/\/+$/, ''),
  allowedOrigin: required('ALLOWED_ORIGIN'),
  port: Number(optional('PORT', '3000')),
  dbPath: optional('DB_PATH', '/data/steam-presence.db'),
  pollIntervalSec: Number(optional('POLL_INTERVAL_SEC', '60')),
}
