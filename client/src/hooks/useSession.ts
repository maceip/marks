import { useEffect, useMemo, useState } from 'react';
import type {
  CollabSession,
  ConnectionStatus,
  DocumentAccessProvider,
  LocalUser,
  Peer,
} from '../collab/types';
import { isAboutDocument } from '../content/about';
import { UI_DATA_MODE } from '../lib/product';

export interface SessionState {
  session: CollabSession | null;
  status: ConnectionStatus;
  peers: Peer[];
  hydrated: boolean;
  error: string | null;
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
  user: LocalUser,
  access: DocumentAccessProvider | null,
): SessionState {
  const [session, setSession] = useState<CollabSession | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Identity changes should not tear down a live session.
  const identity = useMemo(() => user, [user.name, user.colorIndex, user.id]);

  useEffect(() => {
    if (!docId) {
      setSession(null);
      setHydrated(false);
      setPeers([]);
      setError(null);
      return;
    }

    // Service authority is resolved asynchronously from the first paint. A
    // fast document lookup (notably in WebKit) can therefore win that race.
    // Stay in the opening state until admission is available instead of
    // attempting a session that is guaranteed to fail and then retrying it.
    if (UI_DATA_MODE === 'service' && !isAboutDocument(docId) && !access) {
      setSession(null);
      setStatus('connecting');
      setHydrated(false);
      setPeers([]);
      setError(null);
      return;
    }

    let active = true;
    let next: CollabSession | null = null;
    let unsubscribe: Array<() => void> = [];
    setStatus('connecting');
    setPeers([]);
    setHydrated(false);
    setError(null);

    // The documents shell should not pay for CodeMirror, the CRDT, or their
    // bindings. Load the editing engine only when a document is ready to open.
    const factory =
      UI_DATA_MODE === 'local' || isAboutDocument(docId)
        ? import('../demo/local-session').then(({ createLocalSession }) => () =>
            createLocalSession(docId, identity),
          )
        : import('../collab').then(({ createSession }) => {
            if (!access) {
              throw new Error('service mode requires a document admission provider');
            }
            return () => createSession({ docId, user: identity, access });
          });

    void factory
      .then((create) => create())
      .then((session) => {
        if (!active) {
          session.destroy();
          return;
        }
        next = session;
        setError(null);
        setSession(next);
        setStatus(next.status());
        setPeers(next.peers());
        setHydrated(next.hydrated());
        unsubscribe = [
          next.onStatusChange(setStatus),
          next.onPeersChange(setPeers),
          next.onHydrated(() => setHydrated(true)),
        ];
      })
      .catch((error) => {
        if (active) {
          console.error('[marks] session bootstrap failed', error);
          setStatus('offline');
          setError(error instanceof Error ? error.message : 'The document session could not open.');
        }
      });

    return () => {
      active = false;
      for (const off of unsubscribe) off();
      next?.destroy();
      setSession(null);
    };
  }, [docId, identity, isAboutDocument(docId) ? null : access]);

  return { session, status, peers, hydrated, error };
}
