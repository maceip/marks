/**
 * Public surface of the ESBT engine that marks will bind to.
 *
 * Implement these types. Marks owns the WebSocket room, CodeMirror binding,
 * IndexedDB cache, and HTTP snapshot fetch. It will not import Loro or Yjs
 * once this package satisfies the contract.
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
  UndoManager,
  UndoManagerStatic,
  VersionVector,
  VersionVectorStatic,
} from './api.js';

export type { EphemeralStore, EphemeralStoreStatic } from './ephemeral.js';
