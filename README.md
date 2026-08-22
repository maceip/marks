# marks

Collaborative Markdown editing designed to stay responsive on large documents.

A HackMD-style split editor — source on the left, live preview on the right —
where every keystroke lands in a local CRDT replica first, and the preview
repaints only the blocks you actually changed.

![Split view](docs/screenshots/split-light.png)

## Why it feels different

Most markdown editors debounce the preview and re-render the whole document.
That is fine for a page of notes and miserable for a long one. marks takes the
work apart:

| | Typical markdown editor | marks |
| --- | --- | --- |
| Preview | debounce, then re-render everything | per-block content hash, only dirty blocks repaint |
| Parsing | on the main thread, blocking input | in a Web Worker |
| Off-screen content | laid out and painted | skipped via `content-visibility` |
| Merging | operational transform, server-ordered | CRDT, converges without a server |
| Opening a document | replay the edit history | one snapshot over cacheable HTTP |
| Performance claims | none | a panel in the app, and a benchmark you can run |

The result on a 53 KB, 757-block document, typing in the middle of it:

```
edit → preview painted     p50 55 ms · p95 114 ms
blocks re-rendered         1 of 757
DOM operations             3
```

Typing itself never waits on any of that — the editor and the CRDT are on the
main thread, the markdown parser is not.

## Running it

```bash
npm install
npm run dev          # browser client on :5173
cargo test --workspace
```

The Vite client proxies `/v1` and `/collab` to `MARKS_SERVER`, which defaults
to `http://localhost:3000`. The disposable Node backend has been removed; a
connected local session therefore also needs the production Rust server once
that binary lands. The browser artifact itself builds with:

```bash
npm run build
npm run preview      # static preview only; no API or collaboration backend
```

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `MARKS_SERVER` | `http://localhost:3000` | Rust API/WebSocket target used by the Vite development proxy |

## Editing

Everything you would expect from a markdown editor, plus what HackMD taught
people to expect:

- **Split, editor-only and preview-only** modes (`Ctrl`/`Cmd` + `\` cycles them)
- **Synchronised scrolling** mapped by source line, not by percentage
- **Formatting toolbar** and shortcuts — bold, italic, strikethrough, highlight,
  headings, links, lists, task lists, quotes, tables, code blocks
- **Live outline** built from the document's headings (`Ctrl`/`Cmd` + `Shift` + `O`)
- **Clickable task lists** — ticking a box in the preview edits the source
- **Tables, footnotes, definition lists, abbreviations, sub/sup, marks, emoji**
- **Math** via KaTeX, **diagrams** via Mermaid, **syntax highlighting** via highlight.js
- **Callouts** — `:::info`, `:::success`, `:::warning`, `:::danger`, `:::note`
- **Presence**: avatars, live remote cursors and selections
- **Per-user undo** — undoing reverts your edits, never a collaborator's
- **Offline editing**, with local persistence, multi-tab replica sync, and automatic resync
- **Voice input** where the browser exposes SpeechRecognition
- **Document-scoped copy / paste / select-all / right-click**, including HTML→markdown paste
- **Light and dark themes**, and a layout that works on a phone
- **Export** to `.md`; the Rust server will add revocable,
  permission-checked share links

## Architecture

```
client/                     Vite + React + TypeScript
  auth/                     scratch/device primitives and room admission
  browser/                  clipboard, context menu, voice, tab sync, cache
  collab/                   CollabSession interface, the ESBT engine,
                            presence decorations for CodeMirror
  markdown/                 markdown-it setup, block diffing, DOM patching
  workers/                  markdown.worker.ts, bench.worker.ts
  editor/                   CodeMirror 6 setup, commands, theme
  components/ pages/        UI
esbt/                       temporary TypeScript ESBT browser adapter
crates/marks-auth/          in-progress identity/authorization primitives
```

The next backend artifact is one Rust `marks-server` process owning HTTP,
sessions, ACLs, durable document rooms, and the native ESBT replica. There is
intentionally no Node server or compatibility layer.

### The rendering path

1. A keystroke applies to the local CRDT replica and paints in CodeMirror. No
   network, no worker, no wait.
2. The new text goes to the markdown worker. It parses the **whole** document —
   link references and footnotes are document-wide, so partial parsing would be
   wrong — but renders only the blocks whose source hash changed.
3. The worker returns HTML **only for blocks the main thread does not already
   have**. A one-word edit in a 700-block document ships a few hundred bytes.
4. The main thread sanitises those blocks and reconciles them into the DOM by
   key. Unchanged blocks keep their exact nodes, so their layout, their rendered
   diagrams and any text selection inside them survive.

Block keys are content hashes plus an occurrence counter, so inserting a
paragraph at the top of a document does not invalidate everything below it.

### The CRDT engine

Documents are stored in **ESBT** (Mechaoui & Imine,
[arXiv:2607.28101](https://arxiv.org/abs/2607.28101)), a sequence CRDT that
orders characters by weighted identifiers — Stern–Brocot fractions with an
integer ladder and a sequence path behind them — so deletes remove state
instead of leaving tombstones. The browser currently runs the temporary
`@marks/esbt` TypeScript workspace synchronously on the main thread. It
preserved the `CollabSession` seam while the editor was being built, but it is
not a second production engine. The authoritative implementation is the Rust
core in [maceip/ESBT-web](https://github.com/maceip/ESBT-web); v1 will use that
same core natively in the room server and through Wasm in the browser after its
undo, local-journal, and native/Wasm conformance gates pass. Comments are
intentionally absent until authenticated metadata storage and a
commenter-specific authorization path exist. The binding and release boundary
is [docs/V1-SCOPE.md](docs/V1-SCOPE.md).

**Benchmark engine** in the sidebar runs an editing trace against it, in a
worker, in your browser. One run of the 25,000-edit trace in Node on one
machine (your numbers will differ):

| | ESBT |
| --- | --- |
| Type the trace | 311 ms |
| Receive updates | 194 ms |
| Merge two branches | 47 ms |
| Open from snapshot | 236 ms |
| Snapshot size | 1.6 MB |
| Update traffic | 1.4 MB |

Per keystroke that is ~12 µs, far below anything typing can notice. The
encoded sizes are the honest cost today: identifiers are stored explicitly,
one item per UTF-16 unit (sequence paths are prefix-delta-coded; HTTP
responses gzip well). The paper lists compact identifier encoding as future
work, and run-length item coalescing fits behind `export`/`import` without
touching the contract.

### Sync protocol

The current client still contains the prototype tag-byte room protocol. It is
not the production trust boundary. The Rust server/client binding will use a
versioned, bounded, authenticated envelope with a retry-safe message ID and an
exact principal/session/document/site/role binding. A room applies a valid
update to staged in-memory state, commits the exact envelope and revision to
the durable journal, and only then publishes the staged state, broadcasts it,
and returns one `committed` acknowledgement. Retry IDs make a crash between
commit and acknowledgement idempotent. Snapshots are asynchronous compaction.
That server is not present yet, so this paragraph is a target contract rather
than a runtime claim.

## Performance panel

`Ctrl`/`Cmd` + `Shift` + `M` opens a live readout: edit-to-paint p50/p95/max,
how many blocks were dirty on the last pass, how many DOM operations that cost,
parse and render time, bytes on the wire, and the encoded size of the document.

![Performance panel](docs/screenshots/performance.png)

## Tests

```bash
npm run test:esbt        # 41 CRDT engine contract tests, including fuzzed convergence
npm run test:browser     # clipboard, context-menu, select-all, tab isolation
npm run test:markdown    # document-global preview invalidation
npm run test:auth        # browser/Rust canonical auth wire and scratch helpers
npm run test:harness     # chrome discovery, measure budgets, wait-for-server
cargo test --workspace  # Marks-owned Rust authn/authz validators
npm run harness:probe    # print Playwright / Puppeteer / agent-browser + Chrome paths
npm run smoke            # Playwright two-peer / REST smoke
npm run smoke:platforms  # portable glass checks on Playwright, Puppeteer, agent-browser
npm run measure          # latency on a large generated document
```

`npm run smoke` is Playwright-only and checks the things that need two real
browsers or the REST surface. It is retained as the acceptance suite for the
Rust server and is not runnable against a static Vite preview.

`npm run smoke:platforms` runs the same document-glass checks (select-all,
context menu, voice affordance, theme, offline status) on all three
local platforms. How each platform is found, and which Chrome binary they
launch, is in [docs/TEST-HARNESS.md](docs/TEST-HARNESS.md).

Connected suites need a build and an independently running Rust server:

```bash
npm run build
MARKS_URL=http://127.0.0.1:3000 npm run smoke
MARKS_URL=http://127.0.0.1:3000 npm run smoke:platforms
```

## Known limits

- The markdown worker re-parses the whole document on every keystroke. Parsing
  is ~20 ms for a 50 KB document and it is off the main thread, but incremental
  block-level parsing is the obvious next win.
- The browser still uses the temporary TypeScript CRDT adapter. The qualified
  Rust/Wasm binding, per-replica undo, and IndexedDB update journal are not yet
  integrated into Marks.
- Encoded documents are larger than the retired engines' columnar formats —
  identifiers are stored explicitly, one item per UTF-16 unit. Compact
  encoding is the paper's stated future work and fits behind `export`/`import`.
- The production Rust HTTP/room server is not implemented yet. The old Node
  prototype was deliberately deleted rather than becoming an accidental
  compatibility target. The browser now refuses to open a collaboration socket
  without a one-use room ticket. No runtime claim is made until the Rust server
  consumes the identity system's narrow admission result and proves a validated
  principal/session/document/site/role binding end to end.

## Built on

[ESBT](https://github.com/maceip/ESBT-web) (Mechaoui & Imine,
[arXiv:2607.28101](https://arxiv.org/abs/2607.28101)) ·
[CodeMirror 6](https://codemirror.net) ·
[markdown-it](https://github.com/markdown-it/markdown-it) · [KaTeX](https://katex.org) ·
[Mermaid](https://mermaid.js.org) · [highlight.js](https://highlightjs.org) ·
[DOMPurify](https://github.com/cure53/DOMPurify) · [React](https://react.dev) ·
[Vite](https://vite.dev) · [Rust](https://www.rust-lang.org/)

The research behind the CRDT choices, with papers and implementations from
January 2025 to August 2026, is in [docs/RESEARCH.md](docs/RESEARCH.md). The
browser-surface review — right-click, clipboard, voice, caching,
multi-tab, slow/offline — is in [docs/BROWSER-SURFACE.md](docs/BROWSER-SURFACE.md).
