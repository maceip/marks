import { useEffect, useMemo, useState } from 'react';
import type { CommentRecord } from '../browser/comments';
import { createSession } from '../collab';
import type { CollabSession, ConnectionStatus, EngineName, LocalUser, Peer } from '../collab/types';

export interface SessionState {
  session: CollabSession | null;
  status: ConnectionStatus;
  peers: Peer[];
  comments: CommentRecord[];
  hydrated: boolean;
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
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Identity changes should not tear down a live session.
  const identity = useMemo(() => user, [user.name, user.colorIndex]);

  useEffect(() => {
    if (!docId) {
      setSession(null);
      setComments([]);
      setHydrated(false);
      return;
    }

    const next = createSession({ docId, engine, user: identity });
    setSession(next);
    setStatus(next.status());
    setPeers(next.peers());
    setComments(next.comments());
    setHydrated(next.hydrated());

    const offStatus = next.onStatusChange(setStatus);
    const offPeers = next.onPeersChange(setPeers);
    const offComments = next.onCommentsChange(setComments);
    const offHydrated = next.onHydrated(() => setHydrated(true));

    return () => {
      offStatus();
      offPeers();
      offComments();
      offHydrated();
      next.destroy();
      setSession(null);
    };
  }, [docId, engine, identity]);

  return { session, status, peers, comments, hydrated };
}
