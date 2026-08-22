/**
 * ESBT editor contract.
 *
 * This is the API marks needs to replace Loro and Yjs. It is shaped by the
 * paper (weights, INS/DEL, causal delete buffering, tombstone-free reuse)
 * plus the extra surface a live markdown editor actually calls:
 *
 *   - UTF-16 index edits from CodeMirror and the preview
 *   - origin-tagged transactions so the editor, undo, and remotes stay distinct
 *   - snapshot / shallow-snapshot / delta export for cold open and reconnect
 *   - per-peer undo
 *   - an ephemeral presence store (not part of the paper; required for cursors)
 *
 * Implementation language: TypeScript, runs on the main thread in the browser
 * and in Node. No WASM. All mutating methods are synchronous.
 *
 * Additions over the original contract draft, discovered while replacing the
 * loro/yjs engines (each is called out on its member):
 *
 *   - `EphemeralStore.keys()` — the server room gates its first presence
 *     frame on it (`ephemeral.keys().length > 0`).
 *   - `UndoManagerOptions.mergeIntervalMs` — both previous engines group a
 *     burst of keystrokes into one undo step (Loro's UndoManager interval,
 *     Yjs's captureTimeout). Without it, Mod-Z per keystroke.
 *   - `EsbtDoc.indexToAnchor` / `anchorToIndex` — weight-stable text anchors,
 *     requested by the integration document (§7) for future authenticated
 *     metadata ranges and range presence.
 */

/** Replica / site identifier. Opaque, comparable, stable for the life of a doc instance. */
export type SiteId = string;

/**
 * Identifies one occupancy of a weight: the paper's pair (ω, c).
 * Used so a later insert can reuse a deleted weight without aliasing the old one.
 */
export interface EsbtItemId {
  /** Canonical encoding of ⟨f, sn, sc, σ⟩. Must be stable across replicas. */
  weight: string;
  /** Per-replica insertion counter carried by the matching delete. */
  counter: number;
  site: SiteId;
}

/** A range in the visible markdown source. */
export interface EsbtTextRange {
  /** Inclusive start, UTF-16 code units (JS `string` / CodeMirror 6 index). */
  from: number;
  /** Exclusive end, UTF-16 code units. */
  to: number;
}

/**
 * A weight-stable position. Survives concurrent edits elsewhere in the
 * document, which a UTF-16 index does not; the intended carrier for
 * long-lived metadata ranges and range presence (integration document §7).
 */
export interface EsbtAnchor {
  /** Canonical weight string of the anchored item (`EsbtItemId.weight`). */
  weight: string;
  /** Offset inside a multi-unit item; always 0 while items are single units. */
  offset: number;
}

/**
 * Change notification after the local document has been updated.
 *
 * `origin` is whatever the caller passed to `transact`. Marks uses:
 *   - `"editor"` — CodeMirror already shows this text; do not echo it back
 *   - `"undo"` / `"redo"` — must be pushed into the editor
 *   - `undefined` — remote import, seed, or a UI write (checkbox, import)
 */
export interface EsbtEvent {
  origin?: string;
  /** Visible text after this event. Cheap if the impl caches the string. */
  text: string;
}

/**
 * One operation as the paper defines it, plus a replica sequence number so
 * we can do version-vector deltas without a full vector clock of every peer.
 *
 * `seq` is *not* the paper's insertion counter `c`. `c` lives on the item id
 * and is what a delete names. `seq` increments on every locally generated
 * INS or DEL and is what `VersionVector` tracks.
 */
export type EsbtOp =
  | {
      kind: 'ins';
      site: SiteId;
      seq: number;
      id: EsbtItemId;
      /** One or more UTF-16 units inserted as a single item, or a single character. */
      content: string;
    }
  | {
      kind: 'del';
      site: SiteId;
      seq: number;
      /** The insertion this delete is causally dependent on. */
      id: EsbtItemId;
    };

export interface EsbtConfig {
  /**
   * Dmax — bound on mediant numerator/denominator before falling through to
   * sequence number / sequence path. Paper default in examples is 5; for an
   * editor use a large bound (e.g. 2^31 − 1) so sequential typing stays on
   * the fraction layer.
   */
  dMax?: number;
  /** NEWSEQ digit space (paper `base`). Suggested: 2^16. */
  base?: number;
  /** NEWSEQ maximum depth. Suggested: 16. */
  depth?: number;
  /** This replica's site id. Generated if omitted. */
  siteId?: SiteId;
}

/**
 * Compact summary of which operations this replica has integrated.
 *
 * Encoded form must be small enough to put on a WebSocket URL (marks drops
 * anything over 4 KiB and falls back to a snapshot). Independent of the
 * number of characters in the document.
 */
export interface VersionVector {
  encode(): Uint8Array;
}

export interface VersionVectorStatic {
  decode(bytes: Uint8Array): VersionVector;
}

export type EsbtExportOptions =
  | {
      /**
       * Full replica state: live items, delete log, oplog, clocks.
       * What the server persists and what a reconnecting replica can
       * generate deltas from.
       */
      mode: 'snapshot';
    }
  | {
      /**
       * History-trimmed state: same visible text, no oplog.
       * Cold-open HTTP path. Import must still merge (not clobber)
       * with any newer local ops.
       */
      mode: 'shallow-snapshot';
    }
  | {
      /**
       * Operations this replica has that `from` does not.
       * Empty `from` means "everything since birth" — an update that
       * applied to a fresh doc must reproduce the snapshot's text.
       */
      mode: 'update';
      from?: VersionVector;
    };

/**
 * The sequence document. One instance per open document per replica.
 *
 * Indices are UTF-16 code units, identical to `text.length` and to
 * CodeMirror 6 positions. Grapheme clusters are not a concern of this API;
 * the editor owns those.
 *
 * Concurrency (paper §5–6), all required:
 *
 * 1. Insertions are always ready; they commute by weight order.
 * 2. A delete is applied only after its matching insert `(ω, c)` exists,
 *    otherwise it is buffered.
 * 3. A delete for an already-deleted `(ω, c)` is ignored (delete log).
 * 4. Reinsertion at a released weight uses a new `c`; `c` does not affect
 *    document order.
 * 5. Same set of integrated ops ⇒ same `getText()`, any delivery order.
 */
export interface EsbtDoc {
  readonly siteId: SiteId;

  /** Visible markdown source. Must be O(1) or amortized cheap; marks calls this on every change. */
  getText(): string;
  readonly length: number;

  /**
   * Run `fn` as one undo unit and one origin. Nested transact joins the
   * outer one. Local updates are emitted once when the outermost transact
   * ends, as a single `Uint8Array` that `import` on another replica applies.
   */
  transact(fn: () => void, origin?: string): void;

  /** Insert `text` at `index`. Out of range → clamp to [0, length]. */
  insert(index: number, text: string): void;
  /** Delete `length` units at `index`. Out of range → clamp. */
  delete(index: number, length: number): void;
  /** Atomic delete-then-insert. Preview checkbox writes use this. */
  replaceRange(from: number, to: number, insert: string): void;
  /** Replace the whole visible text. Used by file import, not typing. */
  setText(text: string): void;

  export(options: EsbtExportOptions): Uint8Array;
  /**
   * Merge `bytes` (snapshot, shallow-snapshot, or update). Never throws away
   * local ops the payload does not know about. Idempotent.
   * Unknown / corrupt payloads throw.
   */
  import(bytes: Uint8Array): void;

  oplogVersion(): VersionVector;

  /**
   * Fires after every local or remote mutation that changes visible text
   * *or* that carried an origin the editor must reconcile against.
   */
  subscribe(listener: (event: EsbtEvent) => void): () => void;

  /**
   * Bytes this replica just generated (not imports). Marks frames these
   * as `MSG_UPDATE` and broadcasts them. Must be importable on any replica
   * that already holds a causal prefix of this one.
   */
  subscribeLocalUpdates(listener: (update: Uint8Array) => void): () => void;

  /**
   * Weight-stable anchor for the item at `index`; the END sentinel at or
   * past the end. Contract addition for §7 (metadata ranges, range presence).
   */
  indexToAnchor(index: number): EsbtAnchor;
  /**
   * Current index of an anchor; a deleted anchor resolves to the index its
   * item would occupy today, so ranges collapse instead of drifting.
   */
  anchorToIndex(anchor: EsbtAnchor): number;

  /**
   * Keyed last-writer-wins map riding the document — same oplog, snapshots,
   * and version vectors as the text. Retained as a generic compatibility
   * primitive; Marks does not use it for authorized product metadata.
   * Values are opaque strings; the highest (lamport, site) write per key
   * wins on every replica. Deletes leave a mergeable tombstone.
   */
  mapSet(key: string, value: string): void;
  mapDelete(key: string): void;
  mapGet(key: string): string | undefined;
  /** Live entries, sorted by key. */
  mapEntries(): Array<[string, string]>;
}

export interface EsbtDocStatic {
  new (config?: EsbtConfig): EsbtDoc;
}

/** Options for `UndoManager`. Contract addition; both replaced engines had an equivalent. */
export interface UndoManagerOptions {
  /**
   * Group local transacts that land within this window into one undo step —
   * one Mod-Z per typing burst, not per keystroke. 0 (default) keeps the
   * strict contract behaviour of one transact = one step. Marks passes 500.
   */
  mergeIntervalMs?: number;
  /**
   * Transacts whose origin starts with any of these prefixes never enter
   * the undo stack (Loro's `excludeOriginPrefixes`).
   */
  excludeOriginPrefixes?: string[];
}

/**
 * Per-peer undo. Only operations this replica generated (not imports)
 * are undoable. Undoing must generate *new* ops (a delete of our insert,
 * or a re-insert of a deleted item with a new `c`) so peers converge.
 *
 * One `transact` = one undo step (see `UndoManagerOptions.mergeIntervalMs`).
 * Redo is the inverse stack. After a remote change, the undo stack stays
 * valid (CRDT undo, not CodeMirror history).
 */
export interface UndoManager {
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  destroy(): void;
}

export interface UndoManagerStatic {
  new (doc: EsbtDoc, options?: UndoManagerOptions): UndoManager;
}

/**
 * Cursor / avatar state. Not persisted, not in the snapshot.
 * Marks writes `${siteId}-cm-user` and `${siteId}-cm-sel`.
 */
export interface EsbtPresenceState {
  name?: string;
  colorClassName?: string;
  from?: number;
  to?: number;
  [key: string]: unknown;
}
