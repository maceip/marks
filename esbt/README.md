# `@marks/esbt`

The ESBT sequence CRDT (Mechaoui & Imine, arXiv:2607.28101) — the only CRDT
engine in [marks](https://github.com/maceip/marks). Pure TypeScript, no WASM,
synchronous mutations, UTF-16 indices; runs on the main thread in the browser
and in Node. The canonical implementation lives in
[maceip/ESBT-web `ts/`](https://github.com/maceip/ESBT-web) next to the
Rust/wasm reference; this workspace is its build inside marks.

The API is the contract in [`docs/ESBT-INTEGRATION.md`](../docs/ESBT-INTEGRATION.md).
Everything the contract names is implemented, plus the three additions the
Loro/Yjs coverage audit forced (each documented in `src/api.ts`):

- `EphemeralStore.keys()` — the server room gates its first presence frame on it
- `UndoManagerOptions.mergeIntervalMs` — keystroke-burst undo grouping
  (Loro's merge interval / Yjs's `captureTimeout` equivalent; marks passes 500)
- `EsbtDoc.indexToAnchor` / `anchorToIndex` — weight-stable anchors (§7)

## What marks calls

```ts
import { EsbtDoc, EphemeralStore, UndoManager, VersionVector } from '@marks/esbt';

const doc = new EsbtDoc();
const undo = new UndoManager(doc, { mergeIntervalMs: 500 });
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

## Building and testing

The package compiles to `dist/` (plain ESM plus `.d.ts`). Vite, the Node
server, and dependent typechecks all consume that emit — `types` and
`exports.types` point at `dist/index.d.ts`, not at `src/`. A missing
`doc.ts` / `weight.ts` fails `tsc --noEmit` on this package, and a missing
`dist/doc.d.ts` / `dist/weight.d.ts` fails a consumer typecheck.

Root `npm run typecheck` builds this workspace first (`pretypecheck`) so the
declarations exist. That is the real surface, not a source-path workaround.

```bash
npm run build --workspace=@marks/esbt
npm test    --workspace=@marks/esbt   # contract tests + export-surface guard
npm run typecheck                     # builds @marks/esbt, then tsc
```

After editing engine sources during `npm run dev`, rebuild this workspace
so both runtime and types pick the changes up.

## File split

```
src/weight.ts     Fraction / Weight / total order (Def. 2), NEWSEQ (Alg. 1),
                  CREATE_WEIGHT + Tracker (Alg. 2, Def. 4)
src/tree.ts       order-statistic red-black tree of (weight, unit, counter)
src/ops.ts        INS/DEL, pending queue, delete log, site table, op codec
src/codec.ts      varint writer/reader, payload tags, version map codec
src/encode.ts     snapshot / shallow-snapshot / update payloads
src/vector.ts     VersionVector (site → max seq)
src/doc.ts        EsbtDoc — index API, transact, import/export, subscriptions,
                  anchors, undo hooks
src/undo.ts       UndoManager
src/ephemeral.ts  EphemeralStore
src/api.ts        contract types
src/constructors.ts  compile-time contract assertion
src/contract.test.ts invariants from the integration document
```

## Paper rules the tests pin

1. Weights totally ordered by `(f, sn, sc, site)`.
2. `CREATE_WEIGHT` + `NEWSEQ`; `Dmax` bounds the fraction layer
   (Situation 1: 3/7 rejected at Dmax = 5).
3. `INS(ω, e, c)` always ready; `DEL(ω, c)` waits for its insert, then is
   idempotent via the delete log.
4. Reused weights get a new `c`; `c` never affects order.
5. Same integrated op set ⇒ identical `getText()` (SEC), any delivery order —
   fuzzed across three sites with shuffled delivery.

Four hardening corrections to the reference algorithm (strict mediant
separation, neighbour-aware sn ladder, uncapped NEWSEQ retry at depth
exhaustion, twin-pinch gap widening) are documented inline in `src/weight.ts`
and in the coverage audit in ESBT-web.
