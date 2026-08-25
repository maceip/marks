import { useEffect, useState } from 'react';
import type { CollabSession } from '../collab/types.ts';
import IntelligenceWorker from '../workers/intelligence.worker?worker';
import type {
  DocumentIntelligence,
  IntelligenceAnalyzeResponse,
} from './types.ts';
import { createAnalysisDeadline } from './analysis-deadline.ts';

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
    let worker: Worker;
    try {
      worker = new IntelligenceWorker();
    } catch {
      setState({
        analysis: null,
        analyzing: false,
        error: 'Document intelligence could not start. Close and reopen the inspector to retry.',
      });
      return;
    }
    let active = true;
    let contentRevision = 1;
    let timer = 0;
    let off: () => void = () => undefined;
    const fail = (message: string): void => {
      if (!active) return;
      active = false;
      if (timer) window.clearTimeout(timer);
      timer = 0;
      deadline.clear();
      off();
      worker.terminate();
      setState((current) => ({
        ...current,
        analyzing: false,
        error: message,
      }));
    };
    const deadline = createAnalysisDeadline(() => {
      fail('Document intelligence took too long. Close and reopen the inspector to retry.');
    });

    const submit = () => {
      if (!active) return;
      timer = 0;
      setState((current) => ({ ...current, analyzing: true, error: null }));
      deadline.arm();
      try {
        worker.postMessage({
          type: 'analyze',
          revision: contentRevision,
          text: session.getText(),
        });
      } catch {
        fail('Document intelligence could not analyze this page. Close and reopen the inspector to retry.');
      }
    };
    const schedule = (delay = ANALYSIS_SETTLE_MS) => {
      if (!active) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(submit, delay);
    };
    worker.onmessage = (event: MessageEvent<IntelligenceAnalyzeResponse>) => {
      if (!active || event.data.type !== 'analyzed') return;
      deadline.clear();
      if (event.data.revision !== contentRevision) {
        schedule(0);
        return;
      }
      setState({ analysis: event.data.analysis, analyzing: false, error: null });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail('Document intelligence stopped. Close and reopen the inspector to retry.');
    };
    worker.onmessageerror = () => {
      fail('Document intelligence returned an unreadable result. Close and reopen the inspector to retry.');
    };
    off = session.onChange(() => {
      contentRevision += 1;
      schedule();
    });
    submit();
    return () => {
      active = false;
      off();
      if (timer) window.clearTimeout(timer);
      deadline.clear();
      worker.terminate();
    };
  }, [session]);

  return state;
}
