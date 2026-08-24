# ESBT integration contract

**Status:** production Rust/native + WIT WebAssembly Component path

**Last updated:** 2026-08-23

**Application owner:** Marks

**Engine owner:** ESBT-web

This is the implementation boundary between Marks and ESBT. It is deliberately
shorter than the historical compatibility inventory it replaces: there is one
document engine, one byte protocol, and one place for each policy.

## 1. Ownership

| Concern | Owner | Source of truth |
| --- | --- | --- |
| Character identity, ordering, causal delivery, convergence, snapshots, history floor, undo | Rust ESBT | `ESBT-web/src/` |
| Browser host ABI | ESBT | `ESBT-web/wit/esbt.wit` |
| Durable/transmitted CRDT bytes | ESBT | `ESBT-web/docs/esbt-codec.md` and `ESBT-web/src/wire.rs` |
| Product resource/compaction profile | Marks | `engine-profile.json` |
| IndexedDB durability, reconnect, room transport, editor bridge | Marks client | `client/src/collab/` |
| Admission, authorization, durable revisions, retry receipts | Marks server | `crates/marks-server/src/room/` |
| Avatars and carets | Marks presence protocol | [`PRESENCE.md`](PRESENCE.md) |

There is no TypeScript CRDT, native/Wasm transcoder, Node room server, or
second undo implementation. Presence is lossy product state, not an ESBT data
type. Selection presence uses ESBT causal-position artifacts; the retired
identity-less offset shape is rejected. Identity aggregation, preview mappings,
and richer server validation remain **planned** in [`PRESENCE.md`](PRESENCE.md).
A missing or invalid presence frame is a degraded presence experience, never an
ESBT document error.

## 2. One source identity and generated WIT component

`crates/marks-server/Cargo.toml` pins ESBT-web by a full Git revision. The
server links that crate natively. `scripts/build-esbt-component.sh` checks out
(or is given) the same source, builds the `esbt:document@1.0.0` component, and
runs the exactly pinned official Jco transpiler library to generate the browser
TypeScript/JavaScript binding and its core Wasm modules. The numeric WIT package
and wire versions identify
the only current contracts; there is no older ABI or codec reader to maintain.

The checked-in artifact set is:

- `client/public/esbt.component.wasm`, the canonical component binary;
- `client/public/esbt.wit`, the reviewed source contract;
- `client/public/esbt.core*.wasm`, the Jco-generated browser modules;
- `client/src/collab/wasm/generated/`, the generated binding and types;
- `client/public/esbt.component.manifest.json`, the bounded provenance record;
- `client/public/esbt.component.rev`, the exact engine revision stamp.

The manifest binds the engine revision and source fingerprint, clean/dirty
state, product profile, WIT hash/package, codec format, exact transpiler,
component and generated-wrapper hashes, every core module hash/length, compiler,
and target. `npm run verify:esbt` rejects dirty source, revision drift, malformed
component/core headers, undeclared or corrupt modules, WIT drift, profile drift,
generated TypeScript value-type drift, and a component whose WIT export—read
back from the binary by the same transpiler library—does not contain the engine
interface.
`npm run verify:esbt:dev` relaxes only the dirty-source release condition.

The production `EsbtRuntime.load` validates the manifest before allocation,
fetches only declared core modules, checks each byte length and SHA-256 digest,
compiles it with the browser's standard `WebAssembly` API, and instantiates the
generated Jco binding. Browsers do not need native Component Model or WIT
support; Jco lowers the component to ordinary core Wasm modules plus JavaScript.

The Rust process independently compares `MARKS_STATIC_DIR` with the manifest
bound into its binary and stream-hashes the deployed component, WIT, and every
core module at startup. A mismatched binary/static set refuses startup.
`/v1/artifact` reports physical verification and profile/engine coherence;
`releaseReady` additionally requires clean source receipts and a real build
revision.

## 3. Browser document surface

Marks calls the opaque `EsbtDocument` wrapper, not raw weights or tree nodes:

- `create({ siteId, config })`, `destroy`, `length`, `getText`, `stateHash`;
- `transact`, `insert`, `delete`, `replaceRange`, `undo`, `redo`;
- `applyUpdate`, `applySnapshot`, `exportUpdate`, full/compact snapshots;
- `version`, `historyFloor`, `pruneHistoryThrough`;
- `retainedOperations`, `pendingOperations`, `currentDmax`;
- `onLocalUpdate` and `onChange`.

Indices and visible edits are UTF-16 code units, matching JavaScript strings
and CodeMirror. Public bytes are canonical, versioned, bounded Rust encodings;
Marks never decodes an operation to implement CRDT behavior.

Each outer `transact` commits atomically and emits at most one local update.
Nested transactions join the outer one. A failed limit or allocation check
rolls the entire transaction back. Undo/redo emits ordinary compensating CRDT
operations and therefore converges on peers.

## 4. Delta-only visible path

Every mutating Rust receipt carries exact sequential visible replacements:

```ts
interface TextEdit {
  from: number;
  to: number;
  insert: string;
}
```

WIT returns those edits as `list<visible-edit>` in typed local-change and apply
receipts. The wrapper checks that `visibleChanged` agrees with the edit list.
Remote edits are queued to a microtask and dispatched to CodeMirror in sequence.
Editor-originated edits are already painted and are not echoed. A full-string
reconciliation exists only when an offset invariant fails.

The same deltas feed the markdown worker. The worker owns its current source
and patches it before incremental block parsing, so neither the editor bridge
nor preview transport materializes/transfers the whole document per keystroke.

## 5. Browser durability and retry truth

The IndexedDB record contains a stable site, checkpoint snapshot/version, and
pending mutations with stable 128-bit IDs. Append, checkpoint, acknowledgement,
and compaction use one per-document lock and atomic IDB transactions.

An edit moves through these states:

1. apply locally and paint;
2. append `{ mutationId, kind, canonicalBytes }` durably in IndexedDB;
3. send/retry the same mutation envelope;
4. receive the server's committed receipt;
5. atomically checkpoint the acknowledged version and remove only that ID.

The UI reports `saving` until step 4/5. Socket delivery, broadcast, and snapshot
creation are not save acknowledgements.

## 6. Room wire protocol

Every WebSocket binary message is one tag byte plus a payload:

| Tag | Direction | Payload |
| ---: | --- | --- |
| `0x01` update | server → client | canonical ESBT Update artifact |
| `0x02` presence | both | bounded Marks presence bytes specified in [`PRESENCE.md`](PRESENCE.md); never persisted |
| `0x03` server version | server → client | canonical ESBT Version artifact |
| `0x04` snapshot | server → client | canonical compact/full ESBT Snapshot artifact |
| `0x05` synced | server → client | empty initial-sync boundary |
| `0x06` mutation | client → server | `MKMT` format byte 1 + ID + kind + canonical artifact |
| `0x07` committed | server → client | `MKCM` format byte 1 + ID + durable revision + Version artifact |

The socket negotiates `marks.esbt.v2` alongside its one-use admission ticket.
The server authorizes before decoding document bytes. Consecutive mutations in
one room are staged in order and group-committed, but each retains its own
revision and receipt. ACK/broadcast occurs only after the FULL-synchronous
SQLite transaction commits.

Retrying the same ID and digest returns the original receipt. Reusing an ID for
different bytes closes the protocol. If persistence fails, the room poisons
itself and emits neither acknowledgement nor broadcast.

## 7. Reconnect, snapshots, and compaction

Admission includes the client's version when it fits the query budget. The
server sends a delta when retained history covers that version and otherwise a
snapshot. After `MSG_SYNCED`, the client also exports any missing local delta.
`HistoryUnavailable` explicitly selects the compact-snapshot fallback;
unrelated export failures are not swallowed.

`engine-profile.json` generates native and TypeScript policy values, including
message/document ceilings and the retained-operation threshold. Client and
server compact by operation count/idle policy, not by arbitrary blob size.
Snapshot + journal truncation is one SQLite transaction; browser checkpoint +
pending-tail preservation is one IndexedDB transaction.

## 8. Identity and metadata boundary

ESBT sites are stable replica identities, not people. Room admission binds a
site to an authorized actor. Apply receipts expose accepted operation
references so the server can record authorship without parsing private engine
bytes. Display names, principals, roles, timestamps, comments, document titles,
and share capabilities stay outside snapshots and weights.

Document title is stable server metadata. Editing the first Markdown heading
does not rename the catalog record.

## 9. Required evidence

- ESBT native unit, adverse-network, identifier-size, and large-snapshot tests;
- generated WIT/Jco binding freshness and compiled-component verification;
- Marks component two-replica/delta/large-edit/large-snapshot tests;
- IndexedDB concurrent append/checkpoint/retry tests;
- server crash/retry, batching, compaction, restart, capacity, and rate tests;
- real-browser two-peer/offline/reconnect smoke before release.

A source build alone is not end-to-end proof. The release artifact must pass
its strict identity gate and boot through the production server/browser path.
