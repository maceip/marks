/**
 * Values the package must export by these exact names.
 * Marks will do: `import { EsbtDoc, VersionVector, UndoManager, EphemeralStore } from '@marks/esbt'`.
 */
import type { EsbtDocStatic, UndoManagerStatic, VersionVectorStatic } from './api.js';
import type { EphemeralStoreStatic } from './ephemeral.js';

export declare const EsbtDoc: EsbtDocStatic;
export declare const VersionVector: VersionVectorStatic;
export declare const UndoManager: UndoManagerStatic;
export declare const EphemeralStore: EphemeralStoreStatic;
