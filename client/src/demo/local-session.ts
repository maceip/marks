import type { CollabSession, LocalUser } from '../collab/types';
import { EsbtEngine } from '../collab/esbt-engine';

/**
 * Local workspace session: the same Rust/Wasm replica, journal, and undo
 * path as service mode, without room admission or a WebSocket.
 */
export async function createLocalSession(docId: string, user: LocalUser): Promise<CollabSession> {
  return EsbtEngine.open({ docId, user });
}
