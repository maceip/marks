import { LoroEngine } from './loro-engine';
import type { CollabSession, EngineName, SessionOptions } from './types';
import { YjsEngine } from './yjs-engine';

export * from './types';
export { loadUser, saveUser, colorVar, initials, PALETTE_SIZE } from './user';

export const ENGINES: Array<{ id: EngineName; label: string; blurb: string }> = [
  {
    id: 'loro',
    label: 'Loro',
    blurb: 'Fugue over an Eg-walker event graph. Fastest merges, smallest snapshots.',
  },
  {
    id: 'yjs',
    label: 'Yjs',
    blurb: 'YATA via Hocuspocus. The widest ecosystem of bindings and backends.',
  },
];

export function createSession(options: SessionOptions): CollabSession {
  return options.engine === 'yjs' ? new YjsEngine(options) : new LoroEngine(options);
}
