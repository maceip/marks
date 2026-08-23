import { EsbtEngine } from './esbt-engine';
import type { CollabSession, SessionOptions } from './types';
import { ENGINE } from '../lib/product';

export * from './types';
export { loadUser, saveUser, colorVar, initials, PALETTE_SIZE } from './user';

export { ENGINE };

export async function createSession(options: SessionOptions): Promise<CollabSession> {
  return EsbtEngine.open(options);
}
