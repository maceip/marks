import type { EsbtDoc } from './doc.js';
import type { Op } from './ops.js';

export class UndoManager {
  private undoStack: Op[][] = [];
  private redoStack: Op[][] = [];
  private doc: EsbtDoc;
  private unhook: (() => void) | null = null;

  constructor(doc: EsbtDoc) {
    this.doc = doc;
    doc._setUndoHook((ops, origin) => {
      if (origin === 'undo' || origin === 'redo') return;
      if (!ops.length) return;
      this.undoStack.push(ops);
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
    const batch = this.undoStack.pop();
    if (!batch) return;
    const inverse = this.doc._applyUndoOps([...batch].reverse(), 'undo');
    this.redoStack.push(inverse);
  }

  redo(): void {
    const batch = this.redoStack.pop();
    if (!batch) return;
    const inverse = this.doc._applyUndoOps(batch, 'redo');
    this.undoStack.push(inverse);
  }

  destroy(): void {
    this.doc._setUndoHook(null);
    this.undoStack = [];
    this.redoStack = [];
    this.unhook = null;
  }
}
