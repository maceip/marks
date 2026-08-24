# Browser surface

This is a review of how marks talks to the browser — not the visual design of
the chrome, the *platform* work that decides whether the editor feels like a
document or like a web page. The implementation lives in `client/src/browser/`
and is wired through the ESBT engine, CodeMirror, and the preview.

## Google Docs feature map

Core / most-loved Docs behaviours, scored against marks. "Surface" means the
browser layer this pass owns. "CRDT" means the merge engine. "Product" is
intentionally out of scope here.

| Feature | Docs | marks | Owner |
| --- | --- | --- | --- |
| Keystroke lands locally, no spinner | yes | yes | CRDT |
| Presence, remote cursors, selections | yes | yes | CRDT |
| Per-user undo | yes | yes | CRDT |
| Autosave, no Save button | yes | yes | CRDT + persist lock |
| Offline editing + resync | yes | yes | CRDT + IDB + SW |
| Multiple tabs, same document | yes | yes (BroadcastChannel + Web Locks) | Surface |
| Multiple tabs, different documents | yes | yes | Surface |
| Fast cold open from a snapshot | yes | yes (HTTP snapshot + local cache first) | CRDT + Surface |
| Comments on a range | yes | no (removed pending authenticated metadata path) | Product |
| Suggestion mode / track changes | yes | no | Product |
| Version history UI | yes | no (history is in the CRDT) | Product |
| Named versions | yes | no | Product |
| Share link | yes | prototype URL only; no ACL or rotatable capability | Product |
| Find and replace | yes | yes (CodeMirror search) | already |
| Copy / paste, including from other apps | yes | yes (HTML→markdown, `text/markdown`) | Surface |
| Cut / copy / paste from a menu | yes | yes | Surface |
| Select all scoped to the document | yes | yes | Surface |
| Right-click / long-press | yes | yes (policy below) | Surface |
| Voice typing | yes | yes where the browser has SpeechRecognition | Surface |
| Spellcheck underlines | yes | yes (`spellcheck=true` on the editor) | Surface |
| Native mobile text callouts | yes | kept when there is a selection | Surface |
| Print the document | yes | yes (`@media print` hides chrome) | Surface |
| Export | yes | `.md` download | already |
| Mentions / email notifications | yes | no | Product |
| Paginated layout / headers / footnotes UI | yes | markdown footnotes only | Product |
| Smart caching that does not nag | yes | yes (rules below) | Surface |
| Works on a slow link | yes | yes (timeouts, local-first, deferred mermaid) | Surface |

## Answers

### Does right-click work across browsers and on mobile?

Yes, with a policy that prefers the platform menu when it is the better tool.

- **Preview** always gets the marks menu (Copy, Select all, Copy markdown).
  There is no native editing menu worth keeping.
- **Editor, mouse** gets the marks menu (Cut / Copy / Paste / Select all /
  Voice). Paste from the menu uses the async Clipboard API so it
  works in Chrome, Firefox and Safari as long as the gesture is the click.
- **Editor, coarse pointer + a live selection** does *not* steal the event.
  iOS and Android already put Copy / Look Up / Speak on the selection
  callout; replacing that is how web editors become worse than Notes.
- Long-press (520 ms, 12 px slop) opens the same menu on preview and on an
  empty editor cursor. Moving the finger cancels it so a scroll is a scroll.

Spellcheck underlines stay on. Desktop users lose the browser's "correct
spelling to…" items on the editor, which is the same trade Docs and Notion
make; the underlines remain.

### Does copy and paste work?

Yes.

- Inside a `copy` / `cut` event we write `text/plain` and `text/markdown`
  synchronously. The async Clipboard API is a fallback and is too late for
  many browsers once the gesture token is gone.
- Paste of a URL over a selection still becomes a markdown link.
- Paste of rich HTML (Google Docs, a browser, Word) is converted to markdown
  by a small, dependency-free converter. A CodeMirror copy that is just the
  same characters wrapped in a `<div>` is left as plain text so we do not
  rewrite the user's own markdown.
- Preview copy writes HTML + plain text, and "Copy markdown" writes the
  source.

### Does select all work?

Yes, and it stays inside the document.

- In the editor, CodeMirror owns `Mod-A`.
- In the preview, or when the last focused surface was the preview,
  `Mod-A` selects the preview contents only. The sidebar, top bar and
  status bar are not part of the range.
- Inputs (the document filter) keep the browser default.

### Does voice input work?

Yes in Chromium and Edge, which expose `SpeechRecognition` /
`webkitSpeechRecognition`. Safari is limited; Firefox does not ship the API.
The toolbar and context menu disable the action there instead of faking it.

Interim hypotheses stay out of the CRDT — committing every partial result
would generate a storm of inserts and make undo unusable. Only final chunks
are inserted at the cursor. `Mod-Shift-S` toggles listening while the editor
is focused.

### Why are comments absent?

The previous implementation stored comments as ordinary operations in an
ESBT keyed map. At the server's opaque update boundary, a commenter could not
be allowed to send those operations without also being able to send markdown
edits. The UI and integration were removed until Marks has principals, ACLs,
an authenticated comments table, and a separate metadata message path. The
sequenced work is in [ESBT-COMPLETION-PLAN.md](ESBT-COMPLETION-PLAN.md).

Old snapshots can still contain the legacy map payload so their markdown stays
readable, but the browser does not render or generate those records.

### Are we caching in a way that is smart but will not annoy users?

Yes. The rules:

1. **Never overwrite a newer local replica with an older HTTP snapshot.**
   Import is a CRDT merge. The service worker does not cache `/v1` or
   `/collab`.
2. **Local cache paints first.** The HTTP snapshot is a refinement with a
   budget that shrinks when we already have a copy or the network is slow.
3. **Document list + per-id engine** live in IndexedDB so an offline open of
   a retired `loro` / `yjs` row is refused instead of being opened as ESBT
   (the encodings are incompatible).
4. **The service worker is an app shell**, production only, never under
   WebDriver. First install may claim clients. Later updates wait for the
   next navigation. There is no "refresh to update" toast.
5. **Hashed `/assets/*` are immutable.** `index.html` is `Cache-Control:
   no-cache` so a deploy is not pinned by the shell.
6. **No beforeunload dialog.** Hiding the tab flushes the local snapshot
   instead of asking the user whether they want to leave.

### Can marks work in multiple tabs, on similar or different documents?

Yes.

- Different documents use different channel names and different IndexedDB
  keys. They never see each other.
- The same document is two CRDT replicas. `BroadcastChannel` fans local
  updates between tabs so they converge without the server (including
  offline). The tab that is still on the socket forwards those updates so
  an online sibling can publish an offline sibling's edits.
- IndexedDB writes take `navigator.locks` around the ESBT snapshot export
  **and** the write so two tabs cannot last-write-wins a stale capture over
  a newer one. Tab updates land on the in-memory replica first, so the
  second writer exports a union.

Each tab keeps its own peer id. Seeing yourself twice in presence is
correct: there are two replicas.

### Does the markdown renderer stay fast while you edit?

Yes, and this pass made the first open cheaper.

The worker still parses the whole document (link references and footnotes
are document-wide) and ships HTML only for dirty blocks. The main thread
reconciles by key. New here:

- First paint of a long document inserts the first 48 blocks immediately
  and the rest on idle callbacks, so the editor can take input before the
  footer exists.
- Mermaid runs when a diagram approaches the viewport, not for every
  off-screen block on open.
- `content-visibility: auto` is unchanged.

Typing still never waits on any of that.

### Are the loading animations crisp?

The opening shell is a transform-only shimmer (compositor thread) over a
static skeleton. `prefers-reduced-motion` already zeroes animation duration
globally. The overlay is `pointer-events: none` so a late hydration cannot
eat the first keystroke. Copy is "Opening document…", "Showing your last
copy…", or "Opening your last local copy…" — not a branded theatre.

### Would this pass a Google code review?

The bar we used:

- Small modules with the invariant in the file comment, not in a wiki.
- Every browser capability is optional; missing SpeechRecognition / Web
  Locks / `clipboard.read` degrades, it does not throw.
- User gestures stay on the stack that needs them (`setData` inside
  `copy`, async clipboard only from a click).
- Tests cover the policy functions and the HTML→markdown converter
  (`npm run test:browser`).
- No new dependencies. No prompt-to-refresh. No stealing iOS callouts.

ESBT still owns merge; this layer owns the glass.

### Does it work on a slow connection or offline?

- Offline is a first-class status. Edits apply to the local replica,
  persist to IndexedDB, and sync on reconnect as a version-vector delta on
  `/collab/esbt`. Every reconnect first obtains a fresh one-use Marks room
  ticket; there is no unauthenticated socket fallback. Sibling tabs keep
  merging via BroadcastChannel while the socket is down.
- Slow (`saveData`, `2g`, `slow-2g`, or a tiny downlink) shortens the
  snapshot fetch and is shown in the status bar. The editor does not wait.
- The app shell service worker lets a reload paint when `/` is unreachable;
  the document itself comes from IndexedDB, not from a cached API response.

## Testing

```bash
npm run test:browser
npm run test:harness
npm run harness:probe
npm run typecheck
# against a production build with the Rust server already running:
VITE_MARKS_DATA_MODE=service npm run build
npm run ci:service         # Playwright service UI plus native second peer
npm run smoke:platforms    # Playwright + Puppeteer + agent-browser glass checks
```

See [TEST-HARNESS.md](TEST-HARNESS.md) for how the three platforms are
discovered and which Chrome they launch.
