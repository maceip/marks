/**
 * Per-peer undo. Only operations this replica generated are undoable —
 * imports never enter the stacks — and undoing emits *new* operations
 * (a delete of our insert, or a reinsert of a deleted item under a fresh
 * counter) so every peer converges on the result.
 */

import type { EsbtDoc as EsbtDocContract, UndoManagerOptions } from './api.js';
import type { EsbtDoc } from './doc.js';
import type { Op } from './ops.js';

export class UndoManager {
  private undoStack: Op[][] = [];
  private redoStack: Op[][] = [];
  private readonly doc: EsbtDoc;
  private readonly mergeIntervalMs: number;
  private lastPushAt = 0;
  private destroyed = false;

  constructor(doc: EsbtDocContract, options: UndoManagerOptions = {}) {
    const impl = doc as unknown as EsbtDoc;
    if (typeof impl._setUndoHook !== 'function' || typeof impl._applyUndoOps !== 'function') {
      throw new Error('esbt: UndoManager requires an EsbtDoc from this package');
    }
    this.doc = impl;
    this.mergeIntervalMs = Math.max(0, options.mergeIntervalMs ?? 0);
    const excluded = options.excludeOriginPrefixes ?? [];

    impl._setUndoHook((ops, origin) => {
      if (origin === 'undo' || origin === 'redo') return;
      if (origin && excluded.some((prefix) => origin.startsWith(prefix))) return;
      if (ops.length === 0) return;

      const now = Date.now();
      const top = this.undoStack[this.undoStack.length - 1];
      // Group bursts of transacts (keystrokes) into one undo step, the way
      // Loro's UndoManager and Y.UndoManager's captureTimeout do. Never merge
      // across an undo/redo boundary: that would swallow the redo history.
      if (
        top !== undefined &&
        this.mergeIntervalMs > 0 &&
        now - this.lastPushAt <= this.mergeIntervalMs &&
        this.redoStack.length === 0
      ) {
        top.push(...ops);
      } else {
        this.undoStack.push([...ops]);
      }
      this.lastPushAt = now;
      this.redoStack = [];
    });
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    // A step can be a no-op when collaborators already deleted everything it
    // touched; fall through to the next one so the key always does something.
    while (this.undoStack.length > 0) {
      const batch = this.undoStack.pop()!;
      const inverse = this.doc._applyUndoOps([...batch].reverse(), 'undo');
      if (inverse.length > 0) {
        this.redoStack.push(inverse);
        return;
      }
    }
  }

  redo(): void {
    while (this.redoStack.length > 0) {
      const batch = this.redoStack.pop()!;
      const inverse = this.doc._applyUndoOps(batch, 'redo');
      if (inverse.length > 0) {
        this.undoStack.push(inverse);
        return;
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.doc._setUndoHook(null);
    this.undoStack = [];
    this.redoStack = [];
  }
}
