import { EsbtEngine } from './esbt-engine';
import type { CollabSession, SessionOptions } from './types';
import { ENGINE } from '../lib/product';

export * from './types';
export { loadUser, saveUser, colorVar, initials, PALETTE_SIZE } from './user';

export { ENGINE };

export function createSession(options: SessionOptions): CollabSession {
  return new EsbtEngine(options);
}
