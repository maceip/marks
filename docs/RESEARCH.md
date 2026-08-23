# CRDT research survey, January 2025 – August 2026

> **Current tree:** marks ships one Rust ESBT core natively in `marks-server`
> and as a checked-in Wasm artifact in the browser. Loro, Yjs, Hocuspocus, and
> the duplicate TypeScript ESBT implementations are gone. The survey below is
> the historical record that led here.

Why this project uses the algorithms and libraries it uses. Every claim below
is attributed: numbers taken from a paper are labelled as such, and numbers we
measured ourselves say so.

## Summary

The interesting work in this window is not a new sequence CRDT — it is the
realisation that a text CRDT does not have to keep its structure resident at
all. Eg-walker stores plain operations and materialises CRDT state only while
merging. That idea shipped in Loro during the survey window; marks later
replaced Loro/Yjs with a first-party ESBT engine.

| Current | For |
| --- | --- |
| [Rust ESBT](https://github.com/maceip/ESBT-web) | Only document engine; native server + generated, ABI-checked Wasm binding |
| [`PresenceStore`](../client/src/collab/presence-store.ts) | Marks-owned transient cursor/avatar relay; never document state |

| Survey-era (removed in PR #6) | Was used for |
| --- | --- |
| [Loro](https://github.com/loro-dev/loro) `loro-crdt@1.14.1` | Then-default document engine |
| [loro-codemirror](https://github.com/loro-dev/loro-codemirror) `0.3.3` | Remote cursor and selection layers |
| [Yjs](https://github.com/yjs/yjs) `13.6.32` + [y-codemirror.next](https://github.com/yjs/y-codemirror.next) | Alternate engine |
| [Hocuspocus](https://github.com/ueberdosis/hocuspocus) `4.6.0` | Yjs sync server |

## Papers

### Collaborative Text Editing with Eg-walker: Better, Faster, Smaller

Joseph Gentle, Martin Kleppmann. **EuroSys 2025**, March 2025.
[ACM](https://dl.acm.org/doi/10.1145/3689031.3696076) ·
[arXiv:2409.14252](https://arxiv.org/abs/2409.14252) ·
[paper repo](https://github.com/josephg/egwalker-paper) ·
[reference implementation](https://github.com/josephg/eg-walker-reference)

The central result of the period. Instead of storing transformed operations
(OT) or a list of intermediate items (CRDT), Eg-walker stores an append-only,
immutable log of the original operations with their causal information, and
reconstructs CRDT state only for the span between two branches' common
ancestor and their tips.

Reported: an order of magnitude less memory in the steady state, document load
from disk orders of magnitude faster than existing CRDTs, and merging
long-running branches orders of magnitude faster than OT.

**Usable implementations.** The authors'
[diamond-types](https://github.com/josephg/diamond-types) (Rust) with
`diamond-types-web` / `diamond-types-node` WASM bindings, and
`eg-walker-reference` (unoptimised TypeScript, written for the paper). Both are
plain-text only, and diamond-types' own README describes the API as in flux —
too thin a base for an editor that also needs presence, persistence and a
CodeMirror binding.

**What we did instead.** Loro is heavily informed by Eg-walker and packages the
same properties behind a maintained API. This is the practical route to the
paper's result.

### ESBT: A Scalable and Deterministic Sequence CRDT for Distributed Collaborative Editing

Moulay Driss Mechaoui, Abdessamad Imine. [arXiv:2607.28101](https://arxiv.org/abs/2607.28101),
submitted 30 July 2026.

An identifier allocation scheme built on an extended Stern–Brocot tree,
targeting the identifier growth that degrades Logoot/LSEQ-style CRDTs during
long, highly concurrent sessions. Reported: 86–93% lower execution time and
50–75% less identifier memory than the best-performing baseline sequence CRDTs
on beginning and random insertion patterns.

**Adopted.** The survey originally parked this paper because no implementation
existed. Marks now pins the Rust implementation once, links it natively in the
server, and builds the browser artifact from the same revision. A versioned
engine-owned IDL generates the TypeScript ABI and is embedded in the Wasm.

### The Art of the Fugue: Minimising Interleaving in Collaborative Text Editing

Matthew Weidner, Martin Kleppmann. Pre-dates this window but is what Loro's
list algorithm implemented, which is why Loro was the survey-era default:
Fugue provably achieves *maximal non-interleaving*, ruling out a class of
anomaly where two people typing in the same place get their words shuffled
together. YATA and RGA can both produce it in edge cases. ESBT is the current
engine; this paper is why Loro was chosen first.

### Peritext: A CRDT for Collaborative Rich Text Editing

Ink & Switch / Weidner et al.
[ACM](https://dl.acm.org/doi/10.1145/3555644) ·
[loro-dev/crdt-richtext](https://github.com/loro-dev/crdt-richtext)

Relevant only if the editor moves to rich text. marks stores markdown *source*
in a plain text CRDT, so formatting is characters in the document rather than
overlapping annotations, and Peritext's problem does not arise.

## Implementations evaluated

| Project | Version checked | Verdict |
| --- | --- | --- |
| [ESBT-web](https://github.com/maceip/ESBT-web) | pinned Rust revision + Wasm ABI v1 | **Current engine.** One Rust source for browser and server. |
| [loro-crdt](https://github.com/loro-dev/loro) | 1.14.1, published 2026-08-10 | **Survey default, then removed.** Fugue over an Eg-walker style event graph. |
| [loro-codemirror](https://github.com/loro-dev/loro-codemirror) | 0.3.3 | **Survey, then removed.** Cursor layers were kept until the ESBT presence layer replaced them. |
| [Yjs](https://github.com/yjs/yjs) | 13.6.32 | **Survey alternate, then removed.** |
| [Hocuspocus](https://github.com/ueberdosis/hocuspocus) | 4.6.0, MIT | **Survey Yjs server, then removed.** |
| [Automerge](https://github.com/automerge/automerge) | 3.0, released August 2025 | **Not adopted.** Automerge 3.0 reports >10× lower memory than 2.0 (a Moby-Dick-sized document dropping from ~700 MB to ~1.3 MB) and correspondingly faster loads. Excellent for JSON-shaped local-first apps, but for a single text field the CodeMirror integration story is thinner than Loro's or Yjs's. |
| [diamond-types](https://github.com/josephg/diamond-types) | `diamond-types-web` | **Not adopted.** The reference Eg-walker implementation, plain text only, API explicitly unstable. |
| [Y-Sweet](https://github.com/jamsocket/y-sweet) | MIT | **Not adopted, worth knowing about.** Rust Yjs server persisting to S3-compatible storage with document-level access tokens. The right answer if this needed to scale horizontally instead of running from one SQLite file. |
| [json-joy](https://github.com/streamich/json-joy) | 18.28.0 | **Not adopted.** High-performance JSON and rich-text CRDT; more surface than a markdown source buffer needs. |

## Product integration decisions

Marks owns both directions of the CodeMirror bridge. A CodeMirror change-set is
one Rust transaction; engine-originated changes return exact sequential UTF-16
replacements, which are dispatched after the current view callback. The normal
path never asks the engine for the whole document. A full-text reconciliation
exists only as an invariant-recovery path.

Undo remains in Rust and emits compensating CRDT operations. Presence is not an
engine feature: a bounded Marks codec relays expiring avatar/caret state and is
never persisted, snapshotted, or mixed with authorship.

## Our own measurements

Run the **Engine performance receipt** in the sidebar for engine-path evidence,
and `npm run measure` for the separate editor-to-preview product path. The
engine receipt hashes the production Wasm and deterministic trace, discards a
warm-up, records raw trials, reports median/p95, and identifies the source,
ABI, seed, browser, memory, and byte counts. Interactive edits are one
transaction/update each; offline branch edits are explicitly batched.

No static timing table lives in this survey because it immediately loses its
machine, browser, thermal, and artifact context. Downloaded JSON receipts are
the evidence. This is also not a comparative suite: a claim against Loro, Yjs,
Logoot, or LSEQ requires equivalent pinned adapters and the same transaction
policy. The paper's percentages are reported paper results, not Marks results.

## Also tracked, not used

- **[crdt-benchmarks](https://github.com/dmonad/crdt-benchmarks)** — the
  standard suite. Its B4 trace (a real 260 K-character editing session) is the
  right thing to run against if you want comparable numbers; our in-app
  benchmark generates its trace locally so the page has no data dependency.
- **FOSDEM 2026** ran a dedicated
  [local-first, sync engines and CRDTs track](https://fosdem.org/2026/schedule/track/local-first/),
  a reasonable index of what is active in the space.
- **cr-sqlite**, **Turso Sync** — CRDTs at the database layer. A different
  architecture: they would replace the sync server, not the editor.

## Sources

- [Collaborative Text Editing with Eg-walker: Better, Faster, Smaller](https://dl.acm.org/doi/10.1145/3689031.3696076) (EuroSys 2025) · [arXiv](https://arxiv.org/abs/2409.14252)
- [josephg/egwalker-paper](https://github.com/josephg/egwalker-paper) · [josephg/eg-walker-reference](https://github.com/josephg/eg-walker-reference) · [josephg/diamond-types](https://github.com/josephg/diamond-types)
- [ESBT: A Scalable and Deterministic Sequence CRDT](https://arxiv.org/abs/2607.28101) (arXiv, July 2026)
- [Peritext: A CRDT for Collaborative Rich Text Editing](https://dl.acm.org/doi/10.1145/3555644)
- [Loro: Event Graph Walker](https://loro.dev/docs/advanced/event_graph_walker) · [loro-dev/loro](https://github.com/loro-dev/loro) · [loro-dev/loro-codemirror](https://github.com/loro-dev/loro-codemirror)
- [Automerge 3.0](https://automerge.org/blog/automerge-3/) · [automerge/automerge](https://github.com/automerge/automerge)
- [ueberdosis/hocuspocus](https://github.com/ueberdosis/hocuspocus) · [jamsocket/y-sweet](https://github.com/jamsocket/y-sweet) · [dmonad/crdt-benchmarks](https://github.com/dmonad/crdt-benchmarks)
- [FOSDEM 2026: local-first, sync engines, CRDTs](https://fosdem.org/2026/schedule/track/local-first/)
