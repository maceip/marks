# ESBT integration contract

Marks replaced Loro and Yjs with ESBT (Mechaoui & Imine, [arXiv:2607.28101](https://arxiv.org/abs/2607.28101); [maceip/ESBT-web](https://github.com/maceip/ESBT-web)).

This document is the API the ESBT implementation must satisfy so the existing markdown editor can keep CodeMirror sync, preview writes, offline delta reconnect, per-peer undo, and presence — without changing the algorithm later.

## Status: TypeScript contract inventory; production browser path is Wasm

The normative Rust native/Wasm binding and release boundary is
[`V1-SCOPE.md`](V1-SCOPE.md). This file remains useful as an inventory of the
current `CollabSession` surface, but statements below such as “TypeScript, no
WASM,” legacy snapshot compatibility, and Node room behavior do not constrain
the production implementation. There are no released clients or production
documents requiring a compatibility path.

The contract below is the inventory the temporary [`@marks/esbt`](../esbt)
workspace still satisfies (canonical sources in
[maceip/ESBT-web `ts/`](https://github.com/maceip/ESBT-web)). The production
browser engine is the Rust/Wasm document in `client/src/collab/wasm`, wired by
`client/src/collab/esbt-engine.ts` per
[maceip/ESBT-web `docs/marks-client-plumbing.md`](https://github.com/maceip/ESBT-web/blob/main/docs/marks-client-plumbing.md).
`@marks/esbt` remains for ephemeral presence and the TypeScript contract
suite. The retired Node room has been deleted; `crates/marks-server` owns the
live room. `loro-crdt`, `loro-codemirror`, `yjs`, `y-codemirror.next`,
`y-indexeddb`, and both Hocuspocus packages are gone from the dependency tree.

This is a working browser integration, not a completed connected product or a
verified implementation of every paper claim. In particular, the current
version-summary logic must be repaired for same-origin operation reordering;
the existing fuzz test shuffles sender blocks but preserves each sender's
internal operation order. The dependency-ordered work and the ownership split
between Marks and ESBT-web are in
[ESBT-COMPLETION-PLAN.md](ESBT-COMPLETION-PLAN.md).

Auditing the exact Loro/Yjs surface marks called (the audit lives next to the
engine as `ts/COVERAGE.md` in ESBT-web) produced four compatibility additions:

1. **`EphemeralStore.keys(): string[]`** — the server room gates its first
   presence frame on `keys().length > 0`; `getAllStates()` alone forced an
   allocation per join.
2. **`UndoManagerOptions.mergeIntervalMs` and `excludeOriginPrefixes`** —
   both replaced engines group a burst of keystrokes into one undo step
   (Loro's merge interval, Yjs's `captureTimeout`). Marks currently uses only
   `mergeIntervalMs`; origin exclusion remains a generic engine capability.
3. **`EsbtDoc.indexToAnchor(i)` / `anchorToIndex(a)`** — the weight-stable
   anchors §7 asks for, available before long-lived metadata ranges return.
   `EsbtAnchor { weight, offset }`; a deleted anchor resolves to the index its
   item would occupy today, so ranges collapse instead of drifting.
4. **`EsbtDoc.mapSet` / `mapDelete` / `mapGet` / `mapEntries`** — a keyed
   last-writer-wins register map riding the same oplog, snapshots (both
   flavours), version vectors, and deltas as the text. This remains decodable
   for snapshot compatibility, but Marks no longer uses it for comments.
   Future comments live in the authenticated metadata plane, not document
   updates. Values are opaque strings; the highest `(lamport, site)` write per
   key wins; deletes leave mergeable tombstones.

Two behaviours this document required are worth naming as delivered exactly:
snapshots restore a stable server site's generators (§6 — a restarted room
resumes `seq` and `c` from the snapshot instead of minting a fresh site id),
and remote cursor decorations were rebuilt marks-side
(`client/src/collab/presence.ts`, publishing the `${siteId}-cm-user` /
`${siteId}-cm-sel` keys named below on a 15 s heartbeat), since the crate
deliberately does not speak CodeMirror.

**Contents:** crate API (constructors, `EsbtDoc`, version vectors, undo, presence) · [§6 one-process server](#6-the-server-is-one-process) · [§7 identity / Docs-shaped product](#7-identity-and-the-docs-shaped-product)

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
| `export({ mode: 'shallow-snapshot' })` | Same visible text, no oplog. `GET /v1/documents/:id/snapshot?shallow=1`. |
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

Index-based presence is enough for **cursors in v1**. Comments, suggestions, and follow-mode need weight-stable anchors — see [Identity and the Docs-shaped product](#7-identity-and-the-docs-shaped-product). Do not persist presence. Do not treat `siteId` as a person.

---

## Why each piece exists

| Surface | Who uses it | Why it is not optional |
| --- | --- | --- |
| `EsbtDoc.insert/delete/replaceRange/setText` | CodeMirror sync, preview checkboxes, file import | The editor never talks in weights |
| `transact(fn, origin)` | Sync plugin, undo | `"editor"` origin must not echo back into CodeMirror or the replica corrupts |
| `subscribe` / `subscribeLocalUpdates` | Preview, wire | Local-first: apply, then emit bytes |
| `export({ mode: 'snapshot' })` | SQLite, IndexedDB | Server is a full replica; cold open is one blob |
| `export({ mode: 'shallow-snapshot' })` | `GET /v1/documents/:id/snapshot?shallow=1` | Payload tracks document size, not history length |
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

## Out of scope for the ESBT crate (marks implements)

The CRDT does not speak HTTP, SQLite, or OAuth. Marks still has to *design* those correctly or the engine will look unfinished to users. The two places we have spent the least time — and the ones that decide whether this feels like Google Docs — are below.

- WebSocket framing (`tag` byte + payload; see `client/src/collab/protocol.ts`)
- Rust room lifecycle, journal, and persistence
- CodeMirror two-way sync and remote cursor decorations
- Marks-owned auth, ACL, sharing, comments, and version history
- Engine migration from old Loro/Yjs blobs

---

## Product gaps the API does not yet cover

The contract above is enough to *type and merge*. It is not enough for the product users compare us to. Google Docs is not “a sequence CRDT in the browser.” It is three stacked systems:

1. A **session** — live replica + WebSocket fan-out for one document.
2. A **store** — snapshots and an operation log that survive process death.
3. A **metadata plane** — who you are, who may see/edit/comment, share links, version history.

The retired Node prototype collapsed (1) and (2) into one process and skipped
(3) entirely. It has been removed. The Rust server must implement all three
without baking process-local or identity assumptions into ESBT weights,
snapshots, or presence.

Sources used while writing this: Google’s Jupiter/Wave-style Docs architecture (central session per document, ACL on the handshake, presence off the op log), [Y-Sweet](https://github.com/jamsocket/y-sweet) (S3 files + document tokens + session backends), [Hocuspocus Redis](https://tiptap.dev/docs/hocuspocus) (any-node-can-serve via pub/sub), [PartyKit / Durable Objects](https://docs.partykit.io/guides/scaling-partykit-servers-with-hibernation/) (one actor per room), [y-protocols awareness](https://github.com/yjs/y-protocols) (15 s refresh / 30 s expiry), Automerge-repo’s PeerId vs StorageId split, and Google Drive’s owner / editor / commenter / viewer + link roles.

---

## 6. Retired Node findings and the Rust room boundary

### What the deleted prototype demonstrated

The old `EsbtRoom.rooms` was an in-memory map on one PID. It used local SQLite,
kept delete tombstones in RAM for five minutes, created unknown documents from
WebSocket URLs, and relayed presence only inside that process. Those sources
are gone; these behaviors are regression cases for the Rust server, not a
compatibility contract.

It was useful prototype evidence. It was not a production backend.

### What breaks the moment there are two processes

| Failure | Why |
| --- | --- |
| Split-brain rooms | Alice lands on process A, Bob on B. Each holds a full replica. They never exchange updates. SQLite last-write wins and silently drops a branch. |
| Presence lies | Avatars and cursors only fan out inside one PID. The other tab looks empty. |
| Restart resurrects deletes | Tombstones are RAM. A client reconnects after bounce, the unknown id is treated as “create,” the doc comes back. |
| Cold replica is stale | The retired debounce could lose the tail after kill -9. The Rust room must journal before `committed`; reconnect delta remains a recovery path, not the durability mechanism. |
| No sticky routing | A load balancer that is “fair” is hostile. Live CRDT state is not interchangeable across PIDs unless you add a backplane. |
| SQLite is not the document | A blob in a row cannot be handed to another region, snapshotted independently, or restored without taking the whole DB. Figma and Y-Sweet treat documents as **files** in object storage for this reason. |

Google Docs does not put every document’s OT engine on every server. It pins a document to a **single serialisation point** (a shard / session) and keeps ACL and history in other stores. CRDTs relax the “server must transform,” but they do **not** relax “there should be one live room, or a defined merge path between rooms.”

### What users think “the server” is

They do not care about replicas. They care that:

- Opening the same link on a laptop and a phone shows one document.
- Closing the laptop lid does not invent a fork that later clobbers the phone.
- Deleting a doc stays deleted after we deploy.
- A viral doc with 40 viewers does not take down every other doc (one process = shared event loop, shared SQLite writer).
- History and share settings survive a restart.

Those are process and metadata problems, not ESBT weight problems.

### Scaling shapes that work with a CRDT (pick one on purpose)

We do **not** need Google’s OT sequencer. We do need an explicit story for “where is the live replica.”

**A. Stay one process until it hurts.** Honest default. Cap concurrent rooms, persist more aggressively, make tombstones durable. Fine for a team tool. Write the rest of this section so we can leave A without rewriting ESBT.

**B. Sticky session backend (Y-Sweet / Jamsocket model).** One live replica per document, scheduled onto a worker. Clients get a short-lived **document token** that includes the worker URL. Persistence is an S3-compatible object (snapshot + oplog), not a SQLite row. Horizontal scale is “more documents,” not “more copies of the same document.” This matches ESBT’s “server is a full peer” design.

**C. Multi-node + pub/sub (Hocuspocus Redis).** Any node accepts the socket. Document updates and ephemeral frames go through Redis. Persistence is Postgres/S3. Harder: every node that has a socket must either hold a replica or be a dumb relay. Dumb relay is simpler but then **no node can answer a shallow snapshot** without reading storage. Full replica on every node that has a subscriber wastes RAM.

**D. One actor per document (Durable Objects / PartyKit).** The platform *is* the sticky map. Hibernation drops RAM when idle; first message rehydrates from storage. A future ESBT room will need explicit snapshot/journal rehydration because its tree wants to stay warm while active.

Recommendation: **A for the first Rust release, B only after the single-owner
durability gate.** C is the fallback if Marks must sit behind a dumb load
balancer. Never run two room owners against one local database and hope.

### Persistence that can move rooms

Before a second process exists:

1. **Durable tombstones.** `documents.deleted_at` (or a `tombstones` table), not a RAM `Map`. Unknown id + tombstone ⇒ 404 / WS 4404, never create.
2. **Documents as objects.** Snapshot and oplog in object storage keyed by `docId`. SQLite (or Postgres) keeps *metadata only*: title, ACL, deleted_at, current snapshot etag.
3. **Flush on evict and on SIGTERM.** Also flush before a future scheduler moves the room.
4. **Client is a peer, not a cache.** Offline edits must be importable by *whichever* process next owns the room (`MSG_SERVER_VV` + `export({ mode: 'update', from })`). That is why ESBT’s version vector cannot be process-local.
5. **Idempotent create.** `PUT /documents/:id` with a create-token, not “unknown URL invents a row.” Share links and doc ids must be different namespaces (see identity).

### What this implies for ESBT (so the crate does not trap us)

The crate should assume **nothing** about a singleton process:

- `siteId` is a replica, including the server’s. The server replica must use a **stable** `siteId` per document (or per deployment), stored with the snapshot — not `random()` on every boot. A new server siteId every restart bloats the version vector and the URL `?vv=`.
- `export` / `import` are the only way rooms move. No hidden globals, no file locks, no `static Map` inside the crate.
- Shallow snapshots must be enough to paint; full snapshots must be enough to emit deltas again after rehydrate.
- Ephemeral state is **not** in the snapshot. A relocated room starts presence empty and waits for clients to `encodeAll()` — same as a refresh. That is correct.
- Read-only connections: the room must be able to apply and relay **updates** while refusing **local** `transact` from a viewer socket. Enforcement is marks; the crate just should not require generate-ops to stay alive.
- One document, many subscribers, one in-memory `EsbtDoc` on the owner process. Do not instantiate one `EsbtDoc` per socket.

### Logical room API Marks must implement in Rust (not in the crate)

```ts
interface RoomLease {
  docId: string;
  /** Stable server site id for this document. */
  serverSiteId: string;
  /** Object-store key / etag of the last durable snapshot. */
  snapshotRef: string;
}

interface DocumentStore {
  load(docId: string): Promise<{ meta: DocumentMeta; snapshot: Uint8Array | null }>;
  save(docId: string, snapshot: Uint8Array, meta: { title: string; chars: number }): Promise<void>;
  tombstone(docId: string): Promise<void>;
  isTombstoned(docId: string): Promise<boolean>;
}

type Role = 'owner' | 'editor' | 'commenter' | 'viewer';

interface CollabConnect {
  docId: string;
  siteId: string;
  /** One-use, 30-second room ticket issued after session + ACL validation. */
  ticket: string;
}
```

Handshake: authenticated HTTP mints a one-use ticket bound to document,
principal, session, device, site, role, and authorization epoch. WebSocket
upgrade consumes it and binds an `Actor`. Viewer/commenter sockets never reach
ESBT update decoding; editor/owner sockets may. Revocation closes or demotes
live sockets. The CRDT never sees the ticket or actor identity. The normative
flow is in [AUTHN-AUTHZ-PROTOCOL.md](AUTHN-AUTHZ-PROTOCOL.md).

---

## 7. Identity and the Docs-shaped product

Identity is a Marks concern. Its normative state machine is in
[AUTHN-AUTHZ-PROTOCOL.md](AUTHN-AUTHZ-PROTOCOL.md): a new tab has a temporary
scratch capability; phone QR or the feature-flagged EVT adapter promotes that
scratch into a random durable principal; controllers enroll per-device keys;
rotating sessions and one-use document tickets admit sockets.

### Identifiers Marks must not collapse

| ID | Lifetime | Purpose |
| --- | --- | --- |
| `scratchId` | Temporary tab/recovery window | Capability-scoped pre-account work |
| `principalId` | Durable Marks account | ACL, avatars, authorship |
| `deviceId` | Enrolled browser/controller key | Silent session recovery and revocation |
| `sessionId` | Rotating browser session | Connection attribution |
| `siteId` | One `EsbtDoc` replica | Weight uniqueness, version state, undo |
| `presenceKey` | Presence TTL | Cursor, selection, idle/follow state |

**ESBT must keep `siteId` unique and unguessable.** Never set
`siteId = principalId` or derive it from a device/session. Two devices owned by
one principal are still two sites; concurrent inserts require distinct final
tie-breakers.

```ts
type Role = 'owner' | 'editor' | 'commenter' | 'viewer';

interface Actor {
  principalId: string;
  deviceId: string;
  sessionId: string;
  siteId: string;
  documentId: string;
  role: Role;
}

interface SharePolicy {
  visibility: 'restricted' | 'link';
  linkRole?: Exclude<Role, 'owner'>;
  grants: Array<{ principalId: string; role: Role }>;
  viewersCanCopy: boolean;
}
```

Colour and display name come from the principal, never the site. Presence keys
by session so two live devices can show two carets while the avatar stack
collapses them to one principal.

### What “Google Docs–like” means as a checklist

Users will assume all of this exists. None of it belongs in ESBT. Marks now has
the Rust auth policy core and normative protocol, but the Rust server and these
product surfaces are not yet wired end to end.

**Sharing**

- Owner / Editor / Commenter / Viewer, matching [Drive roles](https://developers.google.com/drive/api/guides/ref-roles).
- Restricted (named principals) vs anyone-with-the-link (role on the link).
- The **share link is not the document id**. The document ID stays unguessable;
  the link is a rotatable capability. Room admission still uses a separate
  one-use document ticket after the server resolves that capability.
- Revoke or downgrade a role ⇒ close or demote live sockets. Do not wait for TTL.
- Viewer export policy is an owner-controlled Marks flag, not a CRDT flag.
- Scratch visitors remain visibly temporary and private until phone or EVT
  promotion. A generated animal label is presentation, never an ACL principal.

**Presence (separate channel from the document)**

Docs, y-protocols, and every system-design writeup of Docs put cursors on a **best-effort pub/sub**, not in the op log. Cursor traffic is ~10× edit traffic; mixing it into ESBT snapshots would bloat storage and `?vv=`.

Keep `EphemeralStore`. Grow the payload:

```ts
interface EsbtPresenceState {
  principalId?: string;    // absent for unpromoted scratch presence
  sessionId: string;
  name: string;
  colorClassName: string;
  photoUrl?: string;
  role?: Role;
  from?: number;           // v1: UTF-16. v2: see anchors
  to?: number;
  followSessionId?: string;
  idle?: boolean;          // no input for ~60 s
  device?: 'web' | 'mobile';
}
```

y-protocols: re-broadcast at least every 15 s, drop after 30 s. We already use 30 s TTL. Add the heartbeat; do not rely on “they will move the caret.”

Follow-mode (“watch Alice”) is a local UI choice plus her `sessionId`. It is not a CRDT event.

**Cursors vs comments: indices are not enough**

Index presence is fine for a caret that is rewritten 10 times a second. It is **wrong** for a comment that must survive an insert above it. The paper’s weights exist for this. v2 presence/comments should carry:

```ts
interface TextAnchor {
  /** Weight of the start item, plus offset inside a multi-char item if we ever store runs. */
  start: { weight: string; offset: number };
  end: { weight: string; offset: number };
}
```

Marks can keep publishing UTF-16 `from`/`to` for the caret layer. The ESBT crate should expose `indexToAnchor(i)` / `anchorToIndex(a)` as soon as comments exist. Without that we will fake comments as markdown `<!-- -->` and they will drift.

**Comments and suggestions (commenter role is otherwise meaningless)**

Drive’s Commenter cannot change the file and **can** attach discussions to ranges. Suggestions are proposed inserts/deletes that only Owner/Editor accept.

Two implementation paths, in order of honesty:

1. **Side table** (ship first). `comments(id, docId, authorId, anchor, body, created_at, resolved)`. Fan-out on the ephemeral channel or a `MSG_COMMENT` frame. Anchors use weights. Not in the ESBT snapshot. Survives like metadata.
2. **CRDT layer** (later). A second ESBT sequence or a map of marks (Peritext-style) if we move off markdown-source-as-truth. Suggestions become ops that are not in the visible text until accept, at which point they become normal INS.

Do not encode comments as characters in the markdown CRDT. They will show up in export, break hashes, and collide with user content.

**Version history and blame**

Docs: File → See version history, named, time-grouped, restore. Users will look for it the first week.

CRDT snapshots are not a UI history. A restore that “imports an old snapshot” on a live room **merges** (our `import` rule) and will not rewind collaborators. Restore must be a **new** transaction: compute a diff from current `getText()` to the historical string, `setText`/`replaceRange` as the acting user, so the CRDT moves forward.

To show names we must persist authorship **outside** `siteId`:

```ts
interface AuthoredOp {
  site: string;
  seq: number;
  principalId: string; // authenticated principal at acceptance time
  sessionId: string;
  at: number;          // wall clock, display only, not ordering
}
```

The ESBT crate does not need wall clocks in the order. Marks should store a
sidecar log `(docId, site, seq) → principalId` when it durably accepts an
authenticated operation. Blame maps each live character's creating
`(site, seq)` through that log. Without the sidecar, history is only site IDs.

**Undo vs identity**

Undo stays per `siteId` (this replica). Do **not** undo another device merely
because it has the same `principalId`; version history is the cross-device
recovery mechanism.

**Privacy**

Presence can leak profile data to everyone on the socket. V1 sends only an
opaque principal ID, chosen display name, colour, role, and cursor state. The
raw EVT email is neither a profile field nor an `EphemeralStore` requirement.

### Handshake and enforcement (marks)

```
Browser                    App server                 Room process
   |-- POST /v1/documents/:id/session -->|
   |                    session + ACL + one-use ticket
   |<-- { ticketId, ticketSecret, roomUrl, role } ------|
   |-- WS /collab/esbt/:id ------------------------------>|
       Sec-WebSocket-Protocol: marks.esbt.v1, marks.ticket...
                            |-- consume ticket ----------->|
                            |                    bind Actor
                            |                    reject UPDATE if role < editor
```

The browser half of this path is implemented: authenticated snapshots go
through `DocumentAccessProvider`, and each initial connection or reconnect
mints a fresh one-use ticket before constructing the socket. It rejects
cross-origin or credential-bearing room URLs and has no identity-free socket
fallback. The Rust HTTP/upgrade/room half is not implemented yet. It must never
expose an identity-free `/collab/esbt/:id` fallback: a guessed URL is not
authority.

Rate limits belong here too: Docs-scale writeups budget ~100 concurrent *editors* per document and treat presence as cheaper. Cap `MSG_UPDATE` per actor; do not cap heartbeat.

### Suggested schema (metadata plane)

```sql
principals     (id, display_name, created_at, disabled_at)
devices        (id, principal_id, public_key, key_epoch, revoked_at)
sessions       (id, principal_id, device_id, secret_hash, expires_at, revoked_at)
documents      (id, owner_id, title, snapshot_ref, chars, created_at, updated_at, deleted_at)
shares         (doc_id, principal_id, principal_kind, role)
link_grants    (doc_id, token_hash, role, created_at, revoked_at)
op_authors     (doc_id, site, seq, principal_id, session_id, at)
comments       (id, doc_id, author_id, anchor, body, resolved, created_at)
```

The complete identity schema and minimization rules are in
[AUTHN-AUTHZ-PROTOCOL.md](AUTHN-AUTHZ-PROTOCOL.md). The document **bytes** may
stay in the first transactional deployment until a measured need for movable
rooms; identity and ACL data remain Marks-owned either way.

### What we ask of the ESBT expert (identity-adjacent)

Not auth. These hooks, so marks can attach a principal without forking the algorithm:

1. Stable, injectable `siteId` (already on `EsbtConfig`).
2. `indexToAnchor` / `anchorToIndex` when they can; until then, document that items are addressable by `weight` string.
3. Do not put display names, roles, or emails in weights or snapshots.
4. Allow a server replica to exist with `subscribeLocalUpdates` unused (viewers; relay-only nodes).
5. Keep presence out of `export`.
6. Keep principal metadata out of update bytes. Marks records `op_authors` from
   the socket's authenticated `Actor` when the update is durably accepted.

### Shipping order

1. Durable tombstones + stop creating docs on unknown WS ids.
2. Scratch → phone/EVT promotion, rotating sessions, and principal-based colours.
3. One-use ticket on WS; roles viewer vs editor (commenter can wait one release).
4. Share dialog: restricted vs link, rotate link.
5. Sidecar `op_authors` + a read-only history panel (named snapshots, not true rewind).
6. Weight anchors + comments table.
7. Move snapshot blobs to object storage; then session-backend rooms.

Steps 1–4 change whether this is a toy. Steps 5–7 are what people mean by Google Docs. ESBT v1 does not block 1–4. It blocks 6 if weights stay private to the crate.

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
