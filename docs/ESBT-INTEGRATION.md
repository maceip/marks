# ESBT integration contract

Marks is replacing Loro and Yjs with ESBT (Mechaoui & Imine, [arXiv:2607.28101](https://arxiv.org/abs/2607.28101); [maceip/ESBT-web](https://github.com/maceip/ESBT-web)).

This document is the API the ESBT implementation must satisfy so the existing markdown editor can keep CodeMirror sync, preview writes, offline delta reconnect, per-peer undo, and presence — without changing the algorithm later.

Marks will bind to these four constructors and nothing else:

```ts
import { EsbtDoc, EphemeralStore, UndoManager, VersionVector } from '@marks/esbt';
```

The editor, WebSocket room, SQLite, and CodeMirror stay in marks. ESBT owns the document, merge, and undo.

**Constraints**

- Indices are UTF-16 code units (`string.length` / CodeMirror 6). Grapheme clusters are the editor’s problem.
- All mutating methods are synchronous.
- TypeScript, main thread in the browser and in Node. No WASM.

---

## Runtime exports

```ts
export declare const EsbtDoc: EsbtDocStatic;
export declare const VersionVector: VersionVectorStatic;
export declare const UndoManager: UndoManagerStatic;
export declare const EphemeralStore: EphemeralStoreStatic;
```

---

## What marks will call

```ts
import { EsbtDoc, EphemeralStore, UndoManager, VersionVector } from '@marks/esbt';

const doc = new EsbtDoc();
const undo = new UndoManager(doc);
const presence = new EphemeralStore(30_000);

doc.subscribe((event) => {
  if (event.origin !== 'editor') reconcileEditor(event.text);
});
doc.subscribeLocalUpdates((bytes) => socket.send(frame(MSG_UPDATE, bytes)));

doc.transact(() => {
  doc.delete(from, to - from);
  doc.insert(from, inserted);
}, 'editor');

undo.undo();

const snapshot = doc.export({ mode: 'snapshot' });
const shallow = doc.export({ mode: 'shallow-snapshot' });
const delta = doc.export({ mode: 'update', from: VersionVector.decode(peerVv) });
doc.import(payload);
```

---

## `EsbtDoc` — document + sync + merge

This is the whole editor surface. CodeMirror, the preview checkbox path, HTTP cold-open, and reconnect deltas all go through it.

```ts
type SiteId = string;

interface EsbtDoc {
  readonly siteId: SiteId;
  readonly length: number;
  getText(): string; // cached; called on every change

  transact(fn: () => void, origin?: string): void;
  insert(index: number, text: string): void;
  delete(index: number, length: number): void;
  replaceRange(from: number, to: number, insert: string): void;
  setText(text: string): void;

  export(options: EsbtExportOptions): Uint8Array;
  import(bytes: Uint8Array): void; // merge, never clobber newer local ops
  oplogVersion(): VersionVector;

  subscribe(listener: (event: EsbtEvent) => void): () => void;
  subscribeLocalUpdates(listener: (update: Uint8Array) => void): () => void;
}

interface EsbtDocStatic {
  new (config?: EsbtConfig): EsbtDoc;
}

type EsbtExportOptions =
  | { mode: 'snapshot' }            // persist + full replica
  | { mode: 'shallow-snapshot' }    // HTTP cold open, no oplog
  | { mode: 'update'; from?: VersionVector }; // reconnect / offline delta

interface EsbtEvent {
  origin?: string; // "editor" | "undo" | "redo" | undefined
  text: string;
}

interface EsbtConfig {
  dMax?: number;   // use 2^31-1 in the editor
  base?: number;   // NEWSEQ, 2^16
  depth?: number;  // NEWSEQ, 16
  siteId?: SiteId;
}

interface EsbtTextRange {
  from: number; // inclusive, UTF-16
  to: number;   // exclusive, UTF-16
}
```

### Method semantics

| Method | Behaviour |
| --- | --- |
| `getText()` | Visible markdown source. Must be O(1) or amortized cheap. |
| `transact(fn, origin)` | One undo unit and one origin. Nested transact joins the outer one. Local updates emit once when the outermost transact ends, as a single `Uint8Array` that `import` on another replica applies. |
| `insert(index, text)` | Insert at `index`. Out of range → clamp to `[0, length]`. |
| `delete(index, length)` | Delete `length` units at `index`. Out of range → clamp. |
| `replaceRange(from, to, insert)` | Atomic delete-then-insert. Preview checkbox writes use this. |
| `setText(text)` | Replace the whole visible text. File import, not typing. |
| `export({ mode: 'snapshot' })` | Full replica: live items, delete log, oplog, clocks. What the server persists. |
| `export({ mode: 'shallow-snapshot' })` | Same visible text, no oplog. `GET /api/documents/:id/snapshot?shallow=1`. |
| `export({ mode: 'update', from })` | Ops this replica has that `from` does not. Empty `from` = everything since birth. |
| `import(bytes)` | Merge snapshot, shallow-snapshot, or update. Never throw away local ops the payload does not know about. Idempotent. Unknown / corrupt payloads throw. |
| `oplogVersion()` | This replica’s version vector. |
| `subscribe` | After every mutation that changes visible text *or* that carried an origin the editor must reconcile against. |
| `subscribeLocalUpdates` | Bytes this replica just generated (not imports). Marks frames these as `MSG_UPDATE`. Must be importable on any replica that already holds a causal prefix. |

### `origin` is load-bearing

`origin` is whatever the caller passed to `transact`. Marks uses:

| Origin | Meaning |
| --- | --- |
| `"editor"` | CodeMirror already has the text. Do **not** echo it back or the replica double-applies. |
| `"undo"` / `"redo"` | Must be pushed into the editor. |
| `undefined` | Remote import, seed, or a UI write (checkbox, file import). Must be pushed into the editor. |

---

## `VersionVector` — reconnect

```ts
interface VersionVector {
  encode(): Uint8Array;
}

interface VersionVectorStatic {
  decode(bytes: Uint8Array): VersionVector;
}
```

Encoded form has to stay under 4 KiB for realistic peer counts. Marks puts it on the socket URL as `?vv=` and falls back to a snapshot if it is larger. Independent of document length.

This is `site → max seq`, not a replica-sized vector clock.

`seq` is **not** the paper’s insertion counter `c`:

- `c` names an occupancy so a delete can wait for its insert.
- `seq` increments on every locally generated INS or DEL and is what the version vector tracks.

```ts
type EsbtOp =
  | { kind: 'ins'; site: SiteId; seq: number; id: EsbtItemId; content: string }
  | { kind: 'del'; site: SiteId; seq: number; id: EsbtItemId };

interface EsbtItemId {
  weight: string; // stable encoding of ⟨f, sn, sc, σ⟩
  counter: number; // paper's c
  site: SiteId;
}
```

---

## `UndoManager` — per-peer only

```ts
interface UndoManager {
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  destroy(): void;
}

interface UndoManagerStatic {
  new (doc: EsbtDoc): UndoManager;
}
```

- One `transact` = one undo step. Redo is the inverse stack.
- Only this replica’s ops are undoable (not imports).
- Undo emits **new** ops (delete our insert, or re-insert a deleted item with a new `c`) so peers converge.
- After a remote change, the undo stack stays valid.
- Do not use CodeMirror history. CodeMirror’s stack has no idea which edits are yours.

---

## `EphemeralStore` — presence (not in the paper)

Required for avatars and remote carets. Never persist it. Not in snapshots.

```ts
interface EphemeralStore {
  set(key: string, value: unknown): void;
  get(key: string): unknown;
  delete(key: string): void;
  getAllStates(): Record<string, unknown>;
  encodeAll(): Uint8Array;
  apply(bytes: Uint8Array): void;
  subscribe(listener: () => void): () => void;
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void;
  destroy(): void;
}

interface EphemeralStoreStatic {
  new (ttlMs: number): EphemeralStore; // marks uses 30_000
}

interface EsbtPresenceState {
  name?: string;
  colorClassName?: string;
  from?: number;
  to?: number;
  [key: string]: unknown;
}
```

Marks writes:

- `${siteId}-cm-user` — `{ name, colorClassName }` (`marks-user1` … `marks-user8`)
- `${siteId}-cm-sel` — `{ from, to }` (UTF-16 indices)

An entry not refreshed within `ttlMs` disappears from `getAllStates`. Values are JSON-cloneable.

Index-based presence is enough for the first cut. Stable cursor anchors by weight can be added later if needed.

---

## Why each piece exists

| Surface | Who uses it | Why it is not optional |
| --- | --- | --- |
| `EsbtDoc.insert/delete/replaceRange/setText` | CodeMirror sync, preview checkboxes, file import | The editor never talks in weights |
| `transact(fn, origin)` | Sync plugin, undo | `"editor"` origin must not echo back into CodeMirror or the replica corrupts |
| `subscribe` / `subscribeLocalUpdates` | Preview, wire | Local-first: apply, then emit bytes |
| `export({ mode: 'snapshot' })` | SQLite, IndexedDB | Server is a full replica; cold open is one blob |
| `export({ mode: 'shallow-snapshot' })` | `GET /api/documents/:id/snapshot?shallow=1` | Payload tracks document size, not history length |
| `export({ mode: 'update', from })` + `oplogVersion` | Reconnect URL `?vv=` | Warm open / offline resync is a delta |
| `import` | HTTP snapshot, WS frames, peer merge | Must **merge**, never clobber newer local ops |
| `UndoManager` | Mod-Z | Per-peer; must not revert a collaborator. Emits new ops |
| `EphemeralStore` | Avatars, remote carets | Not in the paper; 30s TTL; never persisted |

---

## Paper rules the editor will break without

Keep these from ESBT §3–6. If they slip, two windows of the same doc diverge.

1. Weights totally ordered by `(f, sn, sc, site)`.
2. `CREATE_WEIGHT` + `NEWSEQ` as specified; `Dmax` bounds the fraction layer.
3. `INS(ω, e, c)` always ready; `DEL(ω, c)` waits for that insert, then is idempotent via the delete log.
4. Reused weights get a new `c`. `c` does not change document order.
5. Same integrated op set ⇒ identical `getText()` (SEC), any delivery order.

### Delete / reuse (paper §5)

1. Insertions are always ready; they commute by weight order.
2. A delete is applied only after its matching insert `(ω, c)` exists; otherwise it is buffered.
3. A delete for an already-deleted `(ω, c)` is ignored (delete log).
4. Reinsertion at a released weight uses a new `c`.

---

## Encoding rules

- Snapshots and updates are `Uint8Array`. A single `import` must accept all three export modes (a type tag in the first bytes is enough).
- `VersionVector.encode()` should stay well under 4 KiB for realistic peer counts; marks omits `vv` from the URL above that and asks for a snapshot.
- Bytes are opaque to marks. Do not require JSON on the wire.
- `import` of a payload this replica already applied is a no-op.

---

## What marks will test

The smoke suite and a worker benchmark will assert:

- Two replicas exchanging only updates converge on the same string.
- Offline edits on A, then reconnect, appear on B (delta, not snapshot-only).
- A delete delivered before its insert does not drop the insert or throw.
- Concurrent inserts between the same pair of characters are both present, stably ordered.
- Undo on A removes A’s text and leaves B’s concurrent text.
- `replaceRange` while the editor is unmounted (preview-only) still updates `getText()` and syncs.
- `setText` then `export({ mode: 'snapshot' })` then `import` on a fresh doc reproduces the string.
- Fork: snapshot → two docs → N edits each → exchange updates → equal text.

---

## Out of scope (marks implements)

- WebSocket framing (`tag` byte + payload; see `client/src/collab/protocol.ts`)
- Room lifecycle, SQLite, HTTP snapshot route
- CodeMirror two-way sync and remote cursor decorations
- Auth, access control, engine migration from old Loro/Yjs blobs

---

## Suggested file split on the ESBT-web side

```
weight.ts        CREATE_WEIGHT, NEWSEQ, compare
tree.ts          order-statistic red-black tree of (weight, content)
ops.ts           INS/DEL, pending queue, delete log, CounterMap
encode.ts        snapshot / shallow / update / version vector
doc.ts           EsbtDoc — index API + transact + subscriptions
undo.ts          UndoManager
ephemeral.ts     EphemeralStore
```
