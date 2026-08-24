/// <reference lib="webworker" />
import { analyzeDocument } from '../intelligence/analyze.ts';
import type {
  IntelligenceAnalyzeRequest,
  IntelligenceAnalyzeResponse,
} from '../intelligence/types.ts';

self.onmessage = (event: MessageEvent<IntelligenceAnalyzeRequest>) => {
  const request = event.data;
  if (request.type !== 'analyze') return;
  const response: IntelligenceAnalyzeResponse = {
    type: 'analyzed',
    revision: request.revision,
    analysis: analyzeDocument(request.text, request.revision),
  };
  (self as unknown as Worker).postMessage(response);
};
