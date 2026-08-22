/**
 * Static contract check: the values the package exports must satisfy the
 * constructor interfaces by these exact names. Marks does:
 *
 *   import { EsbtDoc, VersionVector, UndoManager, EphemeralStore } from '@marks/esbt';
 *
 * This module compiles only while that binding stays true. It exports
 * nothing and is never imported at runtime.
 */

import type {
  EsbtDocStatic,
  UndoManagerStatic,
  VersionVectorStatic,
} from './api.js';
import type { EphemeralStoreStatic } from './ephemeral.js';
import { EsbtDoc } from './doc.js';
import { EphemeralStore } from './ephemeral.js';
import { UndoManager } from './undo.js';
import { VersionVector } from './vector.js';

const esbtDoc: EsbtDocStatic = EsbtDoc;
const versionVector: VersionVectorStatic = VersionVector;
const undoManager: UndoManagerStatic = UndoManager;
const ephemeralStore: EphemeralStoreStatic = EphemeralStore;

export type ContractHolds = [
  typeof esbtDoc,
  typeof versionVector,
  typeof undoManager,
  typeof ephemeralStore,
];
