/**
 * Public surface of the ESBT engine.
 *
 * The four runtime constructors marks binds to, the contract types they
 * satisfy, and the algorithm primitives (weights, NEWSEQ, CREATE_WEIGHT)
 * for anyone building on the layer below the editor API.
 */

export type {
  EsbtAnchor,
  EsbtConfig,
  EsbtDoc as EsbtDocType,
  EsbtDocStatic,
  EsbtEvent,
  EsbtExportOptions,
  EsbtItemId,
  EsbtOp,
  EsbtPresenceState,
  EsbtTextRange,
  UndoManager as UndoManagerType,
  UndoManagerOptions,
  UndoManagerStatic,
  VersionVector as VersionVectorType,
  VersionVectorStatic,
} from './api.js';

export type {
  EphemeralStore as EphemeralStoreType,
  EphemeralStoreStatic,
} from './ephemeral.js';

export { EsbtDoc } from './doc.js';
export { VersionVector } from './vector.js';
export { UndoManager } from './undo.js';
export { EphemeralStore } from './ephemeral.js';

export {
  Allocator,
  cmpWeight,
  newseq,
  parseWeightKey,
  weightKey,
} from './weight.js';
export type { Fraction, SiteId, Weight } from './weight.js';
