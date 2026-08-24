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
| §1 Document config | `MARKS_DOCUMENT_CONFIG` generated from `engine-profile.json`: midpoint + adaptive Dmax, 1M UTF-16 units, 64 MiB canonical message ceiling |
| §2 Compaction loop | On `MSG_SERVER_VV`, prune through the committed version when retained ops exceed 32,768 or the idle interval expires, then checkpoint a full snapshot |
| §2 Crash recovery | IndexedDB record `{ siteId, snapshot, version, pending[{id, kind, bytes}] }` restored before reconnect; mutation IDs and site IDs are stable across retry/restart |
| §3 Reconnect | `exportUpdate(serverVV)`, `HistoryUnavailable` → `MSG_SNAPSHOT` compact snapshot; `MissingLocalHistory` / `SnapshotHasSequenceGaps` surface to the user |
| §4 Transactions | Each CodeMirror change-set is one `doc.transact`; `MessageTooLarge` splits the insert |
| §5 Error codes | Allocation / depth / size refusals snap the editor back and toast; corrupt frames are dropped |
| §6 Telemetry | Performance panel reads retained/pending ops, `currentDmax()`, last update bytes, and local journal saved-ness |

The Wasm artifact `client/public/esbt.wasm` is built from the same
`ESBT-web` revision pinned in `crates/marks-server/Cargo.toml`. Rebuild it and
the generated TypeScript ABI with `scripts/build-esbt-wasm.sh`; the artifact
embeds the IDL it implements. Production loading fetches the format-2 manifest
beside the Wasm, hashes the received bytes, and returns no runtime until that
digest matches; streaming compilation runs in parallel but never bypasses the
hash or embedded-ABI checks. `npm run verify:esbt` checks the pin, clean source
provenance, profile/ABI/artifact hashes, empty import surface, and every export
name/arity.
