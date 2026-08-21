# `@marks/esbt`

API contract for using ESBT as the only CRDT in [marks](https://github.com/maceip/marks).

The algorithm lives in [maceip/ESBT-web](https://github.com/maceip/ESBT-web) (Mechaoui & Imine, arXiv:2607.28101). This package is the surface the markdown editor will call. Implement the types in `src/api.ts` and `src/ephemeral.ts`; export the constructors named in `src/constructors.ts`.

Marks will **not** ask ESBT to speak WebSocket, persist to SQLite, or bind CodeMirror. Those stay in the app.

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

Index every `insert` / `delete` / `replaceRange` in **UTF-16 code units**, the same as `string.length` and CodeMirror 6.

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

## Paper requirements that the editor depends on

Keep these from ESBT §3–6. If they slip, two windows of the same doc diverge.

1. Weights totally ordered by `(f, sn, sc, site)`.
2. `CREATE_WEIGHT` + `NEWSEQ` as specified; `Dmax` bounds the fraction layer.
3. `INS(ω, e, c)` always ready; `DEL(ω, c)` waits for that insert, then is idempotent via the delete log.
4. Reused weights get a new `c`. `c` does not change order.
5. Same integrated op set ⇒ identical `getText()` (SEC).

## Encoding rules

- Snapshots and updates are `Uint8Array`. A single `import` must accept all three export modes (a type tag in the first bytes is enough).
- `VersionVector.encode()` should stay well under 4 KiB for realistic peer counts; marks omits `vv` from the URL above that and asks for a snapshot.
- Bytes are opaque to marks. Do not require JSON on the wire.
- `import` of a payload this replica already applied is a no-op.

## Invariants marks will test

The smoke suite and a worker benchmark will assert:

- Two replicas exchanging only updates converge on the same string.
- Offline edits on A, then reconnect, appear on B (delta, not snapshot-only).
- A delete delivered before its insert does not drop the insert or throw.
- Concurrent inserts between the same pair of characters are both present, stably ordered.
- Undo on A removes A's text and leaves B's concurrent text.
- `replaceRange` while the editor is unmounted (preview-only) still updates `getText()` and syncs.
- `setText` then `export({ mode: 'snapshot' })` then `import` on a fresh doc reproduces the string.
- Fork: snapshot → two docs → N edits each → exchange updates → equal text.

## Out of scope (marks implements)

- WebSocket framing (`tag` byte + payload; see `client/src/collab/protocol.ts`)
- Room lifecycle, SQLite, HTTP snapshot route
- CodeMirror two-way sync and remote cursor decorations
- Auth, access control, engine migration from old Loro/Yjs blobs

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
