import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from either `src/` (tsx) or `dist/` (compiled). */
export const ROOT = path.resolve(here, '..', '..');

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST ?? '0.0.0.0';

/** Where the SQLite database lives. */
export const DATA_DIR = process.env.MARKS_DATA_DIR ?? path.join(ROOT, 'data');
export const DB_PATH = process.env.MARKS_DB ?? path.join(DATA_DIR, 'marks.sqlite');

/** Built client assets, served in production. */
export const CLIENT_DIST = path.join(ROOT, 'client', 'dist');

/** Persistence debounce: how long after the last edit we write a snapshot. */
export const PERSIST_DEBOUNCE_MS = Number(process.env.MARKS_PERSIST_DEBOUNCE ?? 1_500);
/** Upper bound on how long a stream of edits can defer a write. */
export const PERSIST_MAX_WAIT_MS = Number(process.env.MARKS_PERSIST_MAX_WAIT ?? 10_000);
/** How long an idle room stays resident in memory before being evicted. */
export const ROOM_IDLE_TIMEOUT_MS = Number(process.env.MARKS_ROOM_IDLE ?? 60_000);
