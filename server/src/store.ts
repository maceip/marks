import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { DATA_DIR, DB_PATH } from './config.js';

/**
 * The engine a document's stored bytes belong to. Every new document is
 * `esbt`; `loro` and `yjs` remain only as read-only markers on rows created
 * before those engines were removed (their sockets are refused and their
 * exports are empty — there is no converter between the binary formats).
 */
export type Engine = 'esbt' | 'loro' | 'yjs';

export interface DocumentRow {
  id: string;
  title: string;
  engine: Engine;
  chars: number;
  created_at: number;
  updated_at: number;
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    title       TEXT    NOT NULL DEFAULT 'Untitled',
    engine      TEXT    NOT NULL DEFAULT 'esbt',
    state       BLOB,
    chars       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_updated_at ON documents (updated_at DESC);
`);

const stmts = {
  list: db.prepare<[], DocumentRow>(
    `SELECT id, title, engine, chars, created_at, updated_at
     FROM documents ORDER BY updated_at DESC`,
  ),
  get: db.prepare<[string], DocumentRow>(
    `SELECT id, title, engine, chars, created_at, updated_at FROM documents WHERE id = ?`,
  ),
  getState: db.prepare<[string], { state: Buffer | null; engine: Engine }>(
    `SELECT state, engine FROM documents WHERE id = ?`,
  ),
  insert: db.prepare(
    `INSERT INTO documents (id, title, engine, state, chars, created_at, updated_at)
     VALUES (@id, @title, @engine, @state, @chars, @created_at, @updated_at)`,
  ),
  saveState: db.prepare(
    `UPDATE documents SET state = @state, title = @title, chars = @chars, updated_at = @updated_at
     WHERE id = @id`,
  ),
  rename: db.prepare(`UPDATE documents SET title = ?, updated_at = ? WHERE id = ?`),
  remove: db.prepare(`DELETE FROM documents WHERE id = ?`),
  exists: db.prepare<[string], { one: number }>(`SELECT 1 AS one FROM documents WHERE id = ?`),
};

export function listDocuments(): DocumentRow[] {
  return stmts.list.all();
}

export function getDocument(id: string): DocumentRow | undefined {
  return stmts.get.get(id);
}

export function documentExists(id: string): boolean {
  return stmts.exists.get(id) !== undefined;
}

export function getState(id: string): { state: Uint8Array | null; engine: Engine } | undefined {
  const row = stmts.getState.get(id);
  if (!row) return undefined;
  return { state: row.state ? new Uint8Array(row.state) : null, engine: row.engine };
}

export function createDocument(opts: {
  engine?: Engine;
  title?: string;
  id?: string;
} = {}): DocumentRow {
  const now = Date.now();
  const row = {
    id: opts.id ?? nanoid(12),
    title: opts.title ?? 'Untitled',
    engine: opts.engine ?? 'esbt',
    state: null,
    chars: 0,
    created_at: now,
    updated_at: now,
  };
  stmts.insert.run(row);
  return getDocument(row.id)!;
}

/**
 * Persist a CRDT snapshot. Called from the room layer on a debounce, so this is
 * the single place where `title`/`chars`/`updated_at` are recomputed.
 *
 * A missing row is not created here. Rooms register their document when they
 * open, so by the time a store happens the row exists — unless the document was
 * deleted while the room was still live. Recreating it would undo the deletion,
 * and this call site does not know which engine wrote the bytes, so the row
 * would come back with the wrong one.
 *
 * @returns whether the document still existed and was written.
 */
export function saveState(id: string, state: Uint8Array, title: string, chars: number): boolean {
  if (!documentExists(id)) return false;

  stmts.saveState.run({
    id,
    state: Buffer.from(state),
    title,
    chars,
    updated_at: Date.now(),
  });
  return true;
}

export function renameDocument(id: string, title: string): DocumentRow | undefined {
  stmts.rename.run(title, Date.now(), id);
  return getDocument(id);
}

/**
 * Ids deleted recently, with the time they were deleted.
 *
 * A client whose socket is closed by a deletion will reconnect, and an unknown
 * id is normally created on connect — that is how a URL creates a document. A
 * short tombstone keeps that from silently undoing the deletion. It is
 * deliberately in-memory: it only has to outlive the reconnect attempts of
 * clients that were connected at the time, and after a restart no room is live.
 */
const tombstones = new Map<string, number>();
const TOMBSTONE_TTL_MS = 5 * 60_000;

export function deleteDocument(id: string): boolean {
  const deleted = stmts.remove.run(id).changes > 0;
  if (deleted) {
    tombstones.set(id, Date.now());
    if (tombstones.size > 512) pruneTombstones();
  }
  return deleted;
}

/** Whether this id was deleted recently enough that it must not be recreated. */
export function isRecentlyDeleted(id: string): boolean {
  const deletedAt = tombstones.get(id);
  if (deletedAt === undefined) return false;
  if (Date.now() - deletedAt <= TOMBSTONE_TTL_MS) return true;
  tombstones.delete(id);
  return false;
}

function pruneTombstones(): void {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  for (const [id, deletedAt] of tombstones) {
    if (deletedAt < cutoff) tombstones.delete(id);
  }
}

export function databaseFile(): string {
  return path.resolve(DB_PATH);
}

export default db;
