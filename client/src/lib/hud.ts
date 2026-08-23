/** Everything the performance panel and status bar display, sampled together. */
export interface HudSnapshot {
  engine: string;
  /** Preview latency, in milliseconds. */
  p50: number;
  p95: number;
  max: number;
  samples: number;
  /** Last render pass. */
  blocks: number;
  dirty: number;
  parseMs: number;
  renderMs: number;
  patchMs: number;
  touched: number;
  htmlBytes: number;
  /** Document and network. */
  chars: number;
  words: number;
  snapshotBytes: number;
  sent: number;
  received: number;
  lastUpdateBytes: number;
  retainedOperations: number;
  pendingOperations: number;
  currentDmax: number;
  parseMode: 'full' | 'incremental' | '';
  localSaved: boolean;
}

export const EMPTY_SNAPSHOT: HudSnapshot = {
  engine: 'esbt',
  p50: 0,
  p95: 0,
  max: 0,
  samples: 0,
  blocks: 0,
  dirty: 0,
  parseMs: 0,
  renderMs: 0,
  patchMs: 0,
  touched: 0,
  htmlBytes: 0,
  chars: 0,
  words: 0,
  snapshotBytes: 0,
  sent: 0,
  received: 0,
  lastUpdateBytes: 0,
  retainedOperations: 0,
  pendingOperations: 0,
  currentDmax: 0,
  parseMode: '',
  localSaved: false,
};
