# Marks client plumbing

The production browser replica is the Rust `esbt` crate compiled to Wasm,
owned through `client/src/collab/wasm` (`EsbtDocument` over the `esbt_doc_*`
ABI). The loops the engine deliberately does **not** run — configuration,
compaction, persistence, transport — live in `client/src/collab/esbt-engine.ts`.

Normative API and safety rules:
[maceip/ESBT-web `docs/marks-client-plumbing.md`](https://github.com/maceip/ESBT-web/blob/main/docs/marks-client-plumbing.md).

Marks implements that guide as follows:

| Guide | Marks wiring |
| --- | --- |
| §1 Document config | `MARKS_DOCUMENT_CONFIG`: midpoint + `adaptiveDmax` defaults, `maxDocumentUnits` 1M, `maxMessageBytes` 4 MiB (the room frame budget) |
| §2 Compaction loop | On `MSG_SERVER_VV`, prune through the acked version when retained ops exceed 50k or 10 minutes have passed, then checkpoint `exportFullSnapshot()` |
| §2 Crash recovery | IndexedDB record `{ siteId, snapshot, updates, ackedVersion }` restored before reconnect; site IDs are never re-minted when a snapshot exists |
| §3 Reconnect | `exportUpdate(serverVV)`, `HistoryUnavailable` → `MSG_SNAPSHOT` compact snapshot; `MissingLocalHistory` / `SnapshotHasSequenceGaps` surface to the user |
| §4 Transactions | Each CodeMirror change-set is one `doc.transact`; `MessageTooLarge` splits the insert |
| §5 Error codes | Allocation / depth / size refusals snap the editor back and toast; corrupt frames are dropped |
| §6 Telemetry | Performance panel reads retained/pending ops, `currentDmax()`, last update bytes, and local journal saved-ness |

The Wasm artifact `client/public/esbt.wasm` is built from the same
`ESBT-web` revision pinned in `crates/marks-server/Cargo.toml`. Rebuild with
`scripts/build-esbt-wasm.sh`.
