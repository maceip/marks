export interface TraceOp {
  position: number;
  insert?: string;
  remove?: number;
}

/** mulberry32 — small, fast, and deterministic for a given seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'the', 'merge', 'replica', 'cursor', 'latency', 'block', 'document', 'peer',
  'offline', 'snapshot', 'history', 'branch', 'render', 'preview', 'commit',
];

/**
 * A synthetic editing trace shaped like a person writing prose: mostly single
 * characters at a moving cursor, occasional whole words, occasional
 * backspaces, and occasional jumps elsewhere in the document.
 *
 * It is not the automerge-perf trace used in the published CRDT benchmarks —
 * it is generated locally so this page has no data dependency — but it
 * exercises the same operations those benchmarks measure.
 */
export function generateTrace(ops: number, seed: number): TraceOp[] {
  const next = random(seed);
  const trace: TraceOp[] = [];
  let length = 0;
  let cursor = 0;

  for (let i = 0; i < ops; i++) {
    const roll = next();

    if (roll < 0.08 && length > 8) {
      const remove = Math.max(1, Math.min(1 + Math.floor(next() * 3), cursor));
      const position = Math.max(0, Math.min(cursor - remove, length - remove));
      trace.push({ position, remove });
      length -= remove;
      cursor = position;
      continue;
    }

    if (roll < 0.15) {
      // Jump somewhere else in the document, the way editing a draft does.
      cursor = Math.floor(next() * (length + 1));
    }

    const insert = next() < 0.12 ? `${WORDS[Math.floor(next() * WORDS.length)]} ` : pickChar(next());
    const position = Math.min(cursor, length);
    trace.push({ position, insert });
    length += insert.length;
    cursor = position + insert.length;
  }

  return trace;
}

function pickChar(roll: number): string {
  const alphabet = 'etaoinshrdlcumwfgypbvkjxqz ,.\n';
  return alphabet[Math.floor(roll * alphabet.length)] ?? 'e';
}
