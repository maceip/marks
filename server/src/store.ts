import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { DATA_DIR, DB_PATH } from './config.js';

export type Engine = 'loro' | 'yjs';

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
    engine      TEXT    NOT NULL DEFAULT 'loro',
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
    engine: opts.engine ?? 'loro',
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
 */
export function saveState(id: string, state: Uint8Array, title: string, chars: number): void {
  if (!documentExists(id)) {
    createDocument({ id, title });
  }
  stmts.saveState.run({
    id,
    state: Buffer.from(state),
    title,
    chars,
    updated_at: Date.now(),
  });
}

export function renameDocument(id: string, title: string): DocumentRow | undefined {
  stmts.rename.run(title, Date.now(), id);
  return getDocument(id);
}

export function deleteDocument(id: string): boolean {
  return stmts.remove.run(id).changes > 0;
}

export function databaseFile(): string {
  return path.resolve(DB_PATH);
}

export default db;
