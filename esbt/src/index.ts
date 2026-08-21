/**
 * Public surface of the ESBT engine that marks will bind to.
 *
 * Types come from the editor contract. Runtime constructors come from the
 * implementation modules as they land (doc/weight/vector/undo/ephemeral).
 * Both are kept so neither the contract PR nor the in-progress impl is lost.
 */
export type {
  EsbtConfig,
  EsbtDoc,
  EsbtDocStatic,
  EsbtEvent,
  EsbtExportOptions,
  EsbtItemId,
  EsbtOp,
  EsbtPresenceState,
  EsbtTextRange,
  UndoManager as UndoManagerType,
  UndoManagerStatic,
  VersionVector as VersionVectorType,
  VersionVectorStatic,
} from './api.js';

export type { EphemeralStore, EphemeralStoreStatic } from './ephemeral.js';

export { VersionVector } from './vector.js';
export { UndoManager } from './undo.js';
export { EsbtDoc } from './doc.js';
export { cmpWeight, newseq, Allocator } from './weight.js';
export type { SiteId, Weight } from './weight.js';
