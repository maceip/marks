# Marks client plumbing

The production browser replica is the Rust `esbt` crate exposed through its
WIT WebAssembly Component and generated Jco binding, owned through
`client/src/collab/wasm` (`EsbtDocument` over the typed
`esbt:document/engine` interface). The loops the engine deliberately does
**not** run — configuration,
compaction, persistence, transport — live in `client/src/collab/esbt-engine.ts`.

Normative API and safety rules:
[maceip/ESBT-web `docs/marks-client-plumbing.md`](https://github.com/maceip/ESBT-web/blob/main/docs/marks-client-plumbing.md).

Marks implements that guide as follows:

| Guide | Marks wiring |
| --- | --- |
| §1 Document config | `MARKS_DOCUMENT_CONFIG` generated from `engine-profile.json`: midpoint + adaptive Dmax, 1M UTF-16 units, 64 MiB canonical message ceiling |
| §2 Compaction loop | On `MSG_SERVER_VV`, prune through the committed version when retained ops exceed 32,768 or the idle interval expires, then checkpoint a full snapshot |
| §2 Crash recovery | IndexedDB record `{ siteId, snapshot, version, pending[{id, kind, bytes}] }` restored before reconnect; mutation IDs and site IDs are stable across retry/restart |
| §3 Reconnect | `exportUpdate(serverVV)`, `HistoryUnavailable` → `MSG_SNAPSHOT` compact snapshot; `MissingLocalHistory` / `SnapshotHasSequenceGaps` surface to the user |
| §4 Transactions | Each CodeMirror change-set is one `doc.transact`; `MessageTooLarge` splits the insert |
| §5 Error codes | Allocation / depth / size refusals snap the editor back and toast; corrupt frames are dropped |
| §6 Telemetry | Performance panel reads retained/pending ops, `currentDmax()`, last update bytes, and local journal saved-ness |

The component set under `client/public/esbt.*` is built from the same
`ESBT-web` revision pinned in `crates/marks-server/Cargo.toml`. Rebuild it and
the generated TypeScript binding with `scripts/build-esbt-component.sh`.
Production loading validates the component manifest, hashes every declared
core module before compiling it, and instantiates only the generated Jco
binding. `npm run verify:esbt` checks the server pin, clean source provenance,
product profile, WIT source/hash/package, exact official transpiler version,
component and core
Wasm headers/hashes/lengths, generated TypeScript value types, and the WIT
export extracted from the component binary. There is no raw ABI fallback or
retired ESBT envelope decoder.
