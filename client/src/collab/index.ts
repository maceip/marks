import { EsbtEngine } from './esbt-engine';
import type { CollabSession, SessionOptions } from './types';

export * from './types';
export { loadUser, saveUser, colorVar, initials, PALETTE_SIZE } from './user';

export const ENGINE = {
  id: 'esbt' as const,
  label: 'ESBT',
  blurb:
    'Weighted-identifier sequence CRDT (Mechaoui & Imine). Pure TypeScript, tombstone-free deletes, delta reconnect.',
};

export function createSession(options: SessionOptions): CollabSession {
  return new EsbtEngine(options);
}
