# marks

Collaborative markdown editing that stays responsive at any document size.

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
npm run dev          # server on :3000, client on :5173
```

Then open http://localhost:5173. For a production build:

```bash
npm run build
npm start            # serves the built client and the sync server on :3000
```

Open the same document URL in two windows to see collaboration.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `MARKS_DATA_DIR` | `./data` | Where the SQLite database lives |
| `MARKS_DB` | `$MARKS_DATA_DIR/marks.sqlite` | Database path |
| `MARKS_PERSIST_DEBOUNCE` | `1500` | Idle milliseconds before a snapshot is written |
| `MARKS_PERSIST_MAX_WAIT` | `10000` | Longest a stream of edits can defer a write |
| `MARKS_ROOM_IDLE` | `60000` | How long an empty room stays in memory |

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
- **Comments** anchored to a source range, stored on the same CRDT as the markdown
- **Voice input** where the browser exposes SpeechRecognition
- **Document-scoped copy / paste / select-all / right-click**, including HTML→markdown paste
- **Light and dark themes**, and a layout that works on a phone
- **Export** to `.md`, and a share link that is just the URL

## Architecture

```
client/                     Vite + React + TypeScript
  browser/                  clipboard, context menu, voice, comments, tab sync, cache
  collab/                   CollabSession interface, the ESBT engine,
                            presence decorations for CodeMirror
  markdown/                 markdown-it setup, block diffing, DOM patching
  workers/                  markdown.worker.ts, bench.worker.ts
  editor/                   CodeMirror 6 setup, commands, theme
  components/ pages/        UI
esbt/                       @marks/esbt — the ESBT sequence CRDT (TypeScript)
server/                     Express + ws + SQLite
  esbt-room.ts              in-memory ESBT replica per document
  store.ts api.ts           persistence and REST
```

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
instead of leaving tombstones. The implementation is the `@marks/esbt`
workspace: pure TypeScript, no WASM, synchronous on the main thread, developed
against the contract in [docs/ESBT-INTEGRATION.md](docs/ESBT-INTEGRATION.md)
alongside the Rust reference in
[maceip/ESBT-web](https://github.com/maceip/ESBT-web). It replaced Loro and
Yjs; everything above the `CollabSession` interface never noticed. Comments
ride the engine's keyed last-writer-wins map with weight-stable anchors, so
they sync and merge exactly like the text they annotate.

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

Rooms speak a small binary protocol over one WebSocket per document — a tag
byte plus a payload. Clients announce the version vector they already hold in
the connection URL, so a reconnect or a warm open costs a delta rather than a
snapshot. The server is a full replica rather than a relay, which is what lets
it answer a cold open with a single snapshot instead of a replay of history;
its replica keeps a stable per-document site id across restarts, so reconnect
vectors stay small.

Documents persist to SQLite, and the document title is derived from the first
heading server-side, so every client agrees on it without extra coordination.

## Performance panel

`Ctrl`/`Cmd` + `Shift` + `M` opens a live readout: edit-to-paint p50/p95/max,
how many blocks were dirty on the last pass, how many DOM operations that cost,
parse and render time, bytes on the wire, and the encoded size of the document.

![Performance panel](docs/screenshots/performance.png)

## Tests

```bash
npm run test:esbt        # 40 CRDT engine contract tests, including fuzzed convergence
npm run test:browser     # clipboard, comments, context-menu, select-all, tab isolation
npm run test:harness     # chrome discovery, measure budgets, wait-for-server
npm run harness:probe    # print Playwright / Puppeteer / agent-browser + Chrome paths
npm run smoke            # Playwright two-peer / REST smoke
npm run smoke:platforms  # portable glass checks on Playwright, Puppeteer, agent-browser
npm run measure          # latency on a large generated document
```

`npm run smoke` is Playwright-only and checks the things that need two real
browsers or the REST surface: rendering, incremental repainting, scroll sync,
outline, convergence, presence and remote cursors, per-user undo,
preview-to-source edits, offline resync, live-room delete, and refusal of the
retired engines' socket paths.

`npm run smoke:platforms` runs the same document-glass checks (select-all,
context menu, comments, voice affordance, theme, offline status) on all three
local platforms. How each platform is found, and which Chrome binary they
launch, is in [docs/TEST-HARNESS.md](docs/TEST-HARNESS.md).

Needs a build and a running server:

```bash
npm run build && npm start &
npm run smoke
npm run smoke:platforms
```

## Known limits

- The markdown worker re-parses the whole document on every keystroke. Parsing
  is ~20 ms for a 50 KB document and it is off the main thread, but incremental
  block-level parsing is the obvious next win.
- Documents created by the retired Loro/Yjs engines are listed but cannot be
  opened; there is no converter from their binary formats, so their sockets
  are refused and their exports are empty.
- Encoded documents are larger than the retired engines' columnar formats —
  identifiers are stored explicitly, one item per UTF-16 unit. Compact
  encoding is the paper's stated future work and fits behind `export`/`import`.
- There is no authentication. Anyone who can reach the server can open any
  document by id. Put it behind something before exposing it.

## Built on

[ESBT](https://github.com/maceip/ESBT-web) (Mechaoui & Imine,
[arXiv:2607.28101](https://arxiv.org/abs/2607.28101)) ·
[CodeMirror 6](https://codemirror.net) ·
[markdown-it](https://github.com/markdown-it/markdown-it) · [KaTeX](https://katex.org) ·
[Mermaid](https://mermaid.js.org) · [highlight.js](https://highlightjs.org) ·
[DOMPurify](https://github.com/cure53/DOMPurify) · [React](https://react.dev) ·
[Vite](https://vite.dev) · [Express](https://expressjs.com)

The research behind the CRDT choices, with papers and implementations from
January 2025 to August 2026, is in [docs/RESEARCH.md](docs/RESEARCH.md). The
browser-surface review — right-click, clipboard, voice, comments, caching,
multi-tab, slow/offline — is in [docs/BROWSER-SURFACE.md](docs/BROWSER-SURFACE.md).
