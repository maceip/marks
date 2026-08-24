import type { CommandEffectObservation } from './types.ts';

type Listener = (observation: CommandEffectObservation) => void;

const listeners = new Set<Listener>();
const backlog: CommandEffectObservation[] = [];
const MAX_BACKLOG = 40;
const MAX_BACKLOG_SOURCE_CHARS = 2 * 1024 * 1024;

function sourceChars(observation: CommandEffectObservation): number {
  return observation.beforeText.length + (observation.afterText?.length ?? 0);
}

/** Internal, source-bearing observations never cross a network boundary. */
export function emitCommandEffect(observation: CommandEffectObservation): void {
  if (listeners.size === 0) {
    if (sourceChars(observation) > MAX_BACKLOG_SOURCE_CHARS) return;
    backlog.push(observation);
    let retained = backlog.reduce((sum, item) => sum + sourceChars(item), 0);
    while (backlog.length > MAX_BACKLOG || retained > MAX_BACKLOG_SOURCE_CHARS) {
      retained -= sourceChars(backlog.shift()!);
    }
    return;
  }
  for (const listener of listeners) {
    try { listener(observation); } catch { /* Observability cannot break the admitted command. */ }
  }
}

export function subscribeCommandEffects(listener: Listener): () => void {
  listeners.add(listener);
  for (const observation of backlog.splice(0)) {
    try { listener(observation); } catch { /* A stale observation must not block subscription. */ }
  }
  return () => listeners.delete(listener);
}
