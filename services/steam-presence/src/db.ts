import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

mkdirSync(dirname(config.dbPath), { recursive: true })

export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    matrix_user_id TEXT PRIMARY KEY,
    steam_id       TEXT NOT NULL,
    linked_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS statuses (
    matrix_user_id TEXT PRIMARY KEY,
    steam_id       TEXT NOT NULL,
    game           TEXT,
    game_id        TEXT,
    since          INTEGER,
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_links (
    nonce          TEXT PRIMARY KEY,
    matrix_user_id TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );
`)

export type LinkRow = {
  matrix_user_id: string
  steam_id: string
  linked_at: number
}

export type StatusRow = {
  matrix_user_id: string
  steam_id: string
  game: string | null
  game_id: string | null
  since: number | null
  updated_at: number
}

export const stmts = {
  insertPending: db.prepare(
    'INSERT OR REPLACE INTO pending_links (nonce, matrix_user_id, created_at) VALUES (?, ?, ?)',
  ),
  takePending: db.prepare('SELECT * FROM pending_links WHERE nonce = ?'),
  deletePending: db.prepare('DELETE FROM pending_links WHERE nonce = ?'),
  purgePending: db.prepare('DELETE FROM pending_links WHERE created_at < ?'),

  upsertLink: db.prepare(
    'INSERT INTO links (matrix_user_id, steam_id, linked_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(matrix_user_id) DO UPDATE SET steam_id = excluded.steam_id, linked_at = excluded.linked_at',
  ),
  deleteLink: db.prepare('DELETE FROM links WHERE matrix_user_id = ?'),
  allLinks: db.prepare('SELECT * FROM links'),
  getLink: db.prepare('SELECT * FROM links WHERE matrix_user_id = ?'),

  upsertStatus: db.prepare(
    `INSERT INTO statuses (matrix_user_id, steam_id, game, game_id, since, updated_at)
     VALUES (@matrix_user_id, @steam_id, @game, @game_id, @since, @updated_at)
     ON CONFLICT(matrix_user_id) DO UPDATE SET
       steam_id   = excluded.steam_id,
       game       = excluded.game,
       game_id    = excluded.game_id,
       since      = COALESCE(
         CASE WHEN statuses.game_id IS excluded.game_id THEN statuses.since ELSE excluded.since END,
         excluded.since
       ),
       updated_at = excluded.updated_at`,
  ),
  getStatus: db.prepare('SELECT * FROM statuses WHERE matrix_user_id = ?'),
  deleteStatus: db.prepare('DELETE FROM statuses WHERE matrix_user_id = ?'),
}
