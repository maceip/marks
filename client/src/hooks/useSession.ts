import { useEffect, useMemo, useState } from 'react';
import { createSession } from '../collab';
import type { CollabSession, ConnectionStatus, EngineName, LocalUser, Peer } from '../collab/types';

export interface SessionState {
  session: CollabSession | null;
  status: ConnectionStatus;
  peers: Peer[];
}

/**
 * Owns one CollabSession for the open document.
 *
 * Text is deliberately *not* React state: it changes on every keystroke and
 * flows straight to the editor and the preview renderer, neither of which is
 * a React-rendered tree.
 */
export function useSession(
  docId: string | null,
  engine: EngineName,
  user: LocalUser,
): SessionState {
  const [session, setSession] = useState<CollabSession | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);

  // Identity changes should not tear down a live session.
  const identity = useMemo(() => user, [user.name, user.colorIndex]);

  useEffect(() => {
    if (!docId) {
      setSession(null);
      return;
    }

    const next = createSession({ docId, engine, user: identity });
    setSession(next);
    setStatus(next.status());
    setPeers(next.peers());

    const offStatus = next.onStatusChange(setStatus);
    const offPeers = next.onPeersChange(setPeers);

    return () => {
      offStatus();
      offPeers();
      next.destroy();
      setSession(null);
    };
  }, [docId, engine, identity]);

  return { session, status, peers };
}
