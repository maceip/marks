# CRDT research survey, January 2025 – August 2026

> **Current tree:** marks ships only ESBT (`@marks/esbt`). Loro, Yjs, and
> Hocuspocus were removed in PR #6. The survey below is the historical record
> that led here. The “Adopted” table is **not** the running stack.

Why this project uses the algorithms and libraries it uses. Every claim below
is attributed: numbers taken from a paper are labelled as such, and numbers we
measured ourselves say so.

## Summary

The interesting work in this window is not a new sequence CRDT — it is the
realisation that a text CRDT does not have to keep its structure resident at
all. Eg-walker stores plain operations and materialises CRDT state only while
merging. That idea shipped in Loro during the survey window; marks later
replaced Loro/Yjs with a first-party ESBT engine.

| Adopted | For |
| --- | --- |
| [Loro](https://github.com/loro-dev/loro) `loro-crdt@1.14.1` | Default document engine |
| [loro-codemirror](https://github.com/loro-dev/loro-codemirror) `0.3.3` | Remote cursor and selection layers |
| [Yjs](https://github.com/yjs/yjs) `13.6.32` + [y-codemirror.next](https://github.com/yjs/y-codemirror.next) | Alternate engine |
| [Hocuspocus](https://github.com/ueberdosis/hocuspocus) `4.6.0` | Yjs sync server, embedded in ours |

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

**Not adopted.** We could not find a released implementation, and the
comparison baselines are position-identifier CRDTs — the family Eg-walker and
YATA already outperform for this workload. Worth revisiting if an
implementation appears.

### The Art of the Fugue: Minimising Interleaving in Collaborative Text Editing

Matthew Weidner, Martin Kleppmann. Pre-dates this window but is what Loro's
list algorithm implements, so it is why the default engine is what it is: Fugue
provably achieves *maximal non-interleaving*, ruling out a class of anomaly
where two people typing in the same place get their words shuffled together.
YATA and RGA can both produce it in edge cases.

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
| [loro-crdt](https://github.com/loro-dev/loro) | 1.14.1, published 2026-08-10 | **Adopted as default.** Fugue over an Eg-walker style event graph. Actively developed, shallow snapshots, ephemeral presence store, cursor API. |
| [loro-codemirror](https://github.com/loro-dev/loro-codemirror) | 0.3.3 | **Adopted, partially.** Its cursor and selection layers are good. We replaced its sync and undo plugins — see below. |
| [Yjs](https://github.com/yjs/yjs) | 13.6.32 | **Adopted as the alternate engine.** The deepest ecosystem; still the fastest at applying a long trace of small edits. |
| [Hocuspocus](https://github.com/ueberdosis/hocuspocus) | 4.6.0, MIT | **Adopted.** Embedded via `handleConnection`, sharing our HTTP server. Multiplexes documents over one socket. |
| [Automerge](https://github.com/automerge/automerge) | 3.0, released August 2025 | **Not adopted.** Automerge 3.0 reports >10× lower memory than 2.0 (a Moby-Dick-sized document dropping from ~700 MB to ~1.3 MB) and correspondingly faster loads. Excellent for JSON-shaped local-first apps, but for a single text field the CodeMirror integration story is thinner than Loro's or Yjs's. |
| [diamond-types](https://github.com/josephg/diamond-types) | `diamond-types-web` | **Not adopted.** The reference Eg-walker implementation, plain text only, API explicitly unstable. |
| [Y-Sweet](https://github.com/jamsocket/y-sweet) | MIT | **Not adopted, worth knowing about.** Rust Yjs server persisting to S3-compatible storage with document-level access tokens. The right answer if this needed to scale horizontally instead of running from one SQLite file. |
| [json-joy](https://github.com/streamich/json-joy) | 18.28.0 | **Not adopted.** High-performance JSON and rich-text CRDT; more surface than a markdown source buffer needs. |

## Where we departed from the libraries

Two bugs in `loro-codemirror@0.3.3` made its sync and undo plugins unusable
here. Both are worked around in `client/src/collab/loro-engine.ts`:

1. **Its sync plugin ignores locally originated events** and its annotation is
   module-private. An undo, or any local write that does not come from the
   editor — ticking a checkbox in the preview, for instance — is therefore
   either invisible to the editor or echoed back into the CRDT, corrupting it.
   We own both directions instead, tagging editor-originated commits with a
   Loro commit `origin` so the two can be told apart.
2. **Its undo plugin re-dispatches its accumulated change set once per event**
   in a batch, and separately restores a saved selection from a deferred
   callback, by which time the position may no longer exist. Both throw
   out-of-range errors from CodeMirror. We drive Loro's `UndoManager` from a
   keymap and reconcile the editor with a minimal text diff.

Its cursor and selection layers are used as published.

## Our own measurements

Run them yourself: **Benchmark engines** in the sidebar, or `npm run measure`.

Identical 25,000-edit trace, headless Chromium in a container — indicative, not
a benchmark of your hardware:

| | Loro 1.14.1 | Yjs 13.6.32 |
| --- | --- | --- |
| Apply trace locally | 157 ms | 83 ms |
| Second replica applies all updates | 140 ms | 35 ms |
| Merge two branches (5,000 edits each) | 22.5 ms | 5.1 ms |
| Open from snapshot | 2.0 ms | 2.8 ms |
| Snapshot size | 18.8 KB | 27.3 KB |
| Update traffic | 456 KB | 128 KB |

This does not reproduce the ordering in the published `crdt-benchmarks` suite,
and the difference is worth stating plainly: we commit after every single
keystroke, which is what an editor actually does and what maximises Loro's
per-commit framing and WebAssembly boundary costs. The published suites apply
traces in bulk. Both readings are true of different workloads.

For this application the deciding numbers are snapshot size and cold-open time,
where Loro leads: they set how quickly a document appears when someone clicks
it, and how much a long-lived document costs to store. A 3 µs difference per
keystroke does not.

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
