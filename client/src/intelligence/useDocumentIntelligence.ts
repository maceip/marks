import { useEffect, useState } from 'react';
import type { CollabSession } from '../collab/types.ts';
import IntelligenceWorker from '../workers/intelligence.worker?worker';
import type {
  DocumentIntelligence,
  IntelligenceAnalyzeResponse,
} from './types.ts';

const ANALYSIS_SETTLE_MS = 180;

export interface DocumentIntelligenceState {
  analysis: DocumentIntelligence | null;
  analyzing: boolean;
  error: string | null;
}

/**
 * One worker per open inspector. Every edit advances the content revision;
 * worker results are accepted only when they match that exact revision.
 */
export function useDocumentIntelligence(session: CollabSession | null): DocumentIntelligenceState {
  const [state, setState] = useState<DocumentIntelligenceState>({
    analysis: null,
    analyzing: Boolean(session),
    error: null,
  });

  useEffect(() => {
    if (!session) {
      setState({ analysis: null, analyzing: false, error: null });
      return;
    }
    const worker = new IntelligenceWorker();
    let active = true;
    let contentRevision = 1;
    let timer = 0;

    const submit = () => {
      timer = 0;
      setState((current) => ({ ...current, analyzing: true, error: null }));
      worker.postMessage({
        type: 'analyze',
        revision: contentRevision,
        text: session.getText(),
      });
    };
    const schedule = (delay = ANALYSIS_SETTLE_MS) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(submit, delay);
    };
    worker.onmessage = (event: MessageEvent<IntelligenceAnalyzeResponse>) => {
      if (!active || event.data.type !== 'analyzed') return;
      if (event.data.revision !== contentRevision) {
        schedule(0);
        return;
      }
      setState({ analysis: event.data.analysis, analyzing: false, error: null });
    };
    worker.onerror = () => {
      if (!active) return;
      setState((current) => ({
        ...current,
        analyzing: false,
        error: 'Document intelligence stopped. Close and reopen the inspector to retry.',
      }));
    };
    const off = session.onChange(() => {
      contentRevision += 1;
      schedule();
    });
    submit();
    return () => {
      active = false;
      off();
      if (timer) window.clearTimeout(timer);
      worker.terminate();
    };
  }, [session]);

  return state;
}
