# Marks UI surface contract

This is the ownership and integration contract for the Marks browser product.
It deliberately stops at the service boundary: persistence, admission, sync,
identity, and review services may change underneath the UI as long as their
client-facing interfaces remain stable. Those interfaces are written down in
[`UI-SERVICE-CONTRACT.md`](UI-SERVICE-CONTRACT.md). Presentation work should
not invent new HTTP, cookie, or room-admission rules.

## One canonical UI

Marks has one web application implementation:

- `client/src/main.tsx` is the only React root.
- `client/src/App.tsx` is the only application shell and route compositor.
- `client/src/pages/` owns route-level screens (`Home`, `Benchmark`).
- `client/src/components/` owns reusable product surfaces, grouped the way
  current product apps group them:
  `shell/` for the app frame, `chrome/` for the ribbon and phone composer,
  `workspace/` for the document panes, `overlays/` for dialogs and toasts,
  `identity/` for keep-workspace and account sheets, `glyphs/` for 3D command
  icons, and `ui/` for shared primitives.
- `client/src/content/` owns canonical documents that are themselves product
  surfaces. The marketing page (`Google Docs for Markdown`) lives here as
  Markdown and opens in the real editor.
- `client/src/styles/` owns the single token and component-style stack.
- `client/index.html` is the application entry.

`client/welcome/index.html` is a bounce page, not a second website. It has no
React root, editor, or duplicate design system. It immediately opens
`/d/about-marks`, which is the same document workspace every other page uses.
The benchmark is a lazy route inside the canonical app.

Do not introduce another `web`, `webapp`, `frontend`, `ui`, React root, app
shell, token set, or document editor. New UI work should extend the canonical
route/component tree or add an adapter beneath it. A genuinely new browser
entry must first amend this contract and receive its own loading budget.

The August 22 audit found exactly two source HTML entries and one React root.
The retired `EmptyState` component duplicated the new workspace dashboard and
had no callers, so it was removed together with its dead component-specific
styles.

## Product posture

Marks is a quiet writing surface with a powerful command layer. The visual
model is **cold glass, hot core**:

- Cool silver, white, and deep navy establish the workspace.
- Electric blue identifies intent, selection, and primary action.
- Green identifies revision, local completion, and healthy state.
- Teal and amber are supporting semantic accents, not ambient decoration.
- The folded Markdown page is the product mark. It is code-native and inline,
  so neither the app nor marketing waits for an image or icon-font request.
- Liquid glass belongs to persistent chrome: the ribbon, drawers, floating
  inspectors, menus, dialogs, and marketing navigation.
- The editor and preview remain opaque. Scrolling text must never continuously
  repaint a full-screen backdrop filter.
- The ribbon may be dense; the page itself must remain calm.
- Raw request, storage, and protocol errors never belong in user-facing copy.

The supplied folded-document icon and replacement editor screenshot are fuzzy
directional references, not source code or pixel-exact specifications.

## Surface ownership

| Surface | Entry | Loading rule | Owner |
| --- | --- | --- | --- |
| Workspace home | `/` | App shell, local catalog, and home CSS only | `App` + `pages/Home` |
| Document | `/d/:id` | Session, CodeMirror, workspace, preview, and review overlays load on demand | `App` + `TopBar` + `components/workspace` |
| Benchmark | `/bench` | Benchmark view, CSS, and worker load only on this route | `pages/Benchmark` |
| About / welcome | `/welcome/` → `/d/about-marks` | Tiny HTML bounce, then the real document editor showing the Markdown marketing page | `content/about.ts` + document chrome |

The welcome URL exists so a public deployment can keep a stable marketing
address. The page people read is a Marks document: source, preview, ribbon,
and the same Markdown that describes the product, accounts, and machinery.

Identity chrome is presentation-complete in local mode on desktop, phone, and
fold: Temporary chip, Keep workspace with an on-brand QR of `/link`, phone
confirmation, Account devices/controllers/sessions, Share principal and link
grants, mapped service-error toasts, and reconnect copy. It uses the same
tokens as the desktop app. It does not claim a pairing ticket, a sent
invitation, or a signed-in principal. The HTTP contract lives in
[`UI-SERVICE-CONTRACT.md`](UI-SERVICE-CONTRACT.md).

## Replaceable data plumbing

The complete visible product runs without the backing service. Local mode is
not a pile of component fixtures: it implements the same narrow interfaces the
service adapters use.

| Contract | Local implementation now | Service implementation |
| --- | --- | --- |
| `DocumentRepository` | Local catalog, create, template, rename, duplicate, delete, and subscriptions | `/v1/documents` via `client/src/lib/api.ts` — see [`UI-SERVICE-CONTRACT.md`](UI-SERVICE-CONTRACT.md) §6.5 |
| `CollabSession` | Wasm `EsbtEngine`: journaled replica, CodeMirror sync, per-replica undo, stats, text subscriptions | Ticket + `/collab/esbt/{id}` with the same Rust-core encodings; do not transcode |
| `ReviewRepository` | Local comments, resolve/reopen, named versions, preview, and restore | No review HTTP service yet; keep the local adapter |

Local mode is the default. Set `VITE_MARKS_DATA_MODE=service` at build time when
the document service is ready. Components do not branch on transport details;
`useDocuments`, `useDocumentMeta`, and `useSession` select the implementation at
the boundary. This is the seam to wire, not a reason to create another app.

Local data is intentionally useful:

- a seeded workspace demonstrates realistic Markdown and product behavior;
- templates create independent editable documents;
- edits, titles, comments, access staging, and version snapshots persist in
  browser storage;
- the same editor commands and preview renderer run in local and service modes;
- collaboration claims remain explicit—local sharing stages access UI but
  never claims to have sent an invitation.

## Adaptive application ribbon

The ribbon is route-aware and borrows the command hierarchy of a mature
desktop document editor, especially the Word mechanics that remain valuable
in a Markdown workspace:

- **Quick Access** — undo and redo stay on the titlebar, independent of the
  active tab.
- **File** — new, templates, rename, duplicate, Markdown export, print, share,
  delete.
- **Home** — clipboard (paste, cut, copy, format painter), a heading-style
  gallery, font marks (bold, italic, insert, strike, highlight, code, clear),
  grow/shrink heading, lists, indent/outdent, find, and Dictate.
- **Insert** — pictures (URL or local file), shapes, tables with row/column
  tools, links, footnotes, comments, code fences, math, Mermaid, callouts,
  breaks, and a contents marker.
- **Draw** — rectangle, ellipse, diamond, arrow, and bubble figures plus
  callout tones.
- **AI** — compose, rewrite, shorten, expand, summarize, outline, and
  continue. These are on-device composition helpers with honest copy until a
  model is wired behind the same insert path.
- **Review** — comments, history, find, and the live performance inspector.
- **View** — Edit/Split/Preview, outline, focus, appearance, theme, and
  performance.
- **Contextual tabs** — Picture, Table, and Shape appear only when the caret
  is in those objects, the same way Word reveals Picture Tools.

Commands use custom 3D folded-glass glyphs. Tilt is CSS-variable driven from
pointer position so hover and touch respond without a private animation loop.
Reduced motion and the foundation glass tier keep the glyphs flat.

The full desktop and studio ribbon is 148px in comfortable density and 132px
in compact density. It collapses to the 48px titlebar with its titlebar
control or `Control+F1`; the preference persists locally. Phone posture is a
separate composer (write / preview / insert / AI / more) and does not expose
an inapplicable collapsed state or Split mode.

Dictate remains visible as part of the command model. On browsers without the
speech API it is disabled with an honest explanation; no interaction silently
pretends to record.

## Menus, dialogs, and review surfaces

The no-service UI is expected to be fully interactive:

- title click opens Rename;
- Share stages people and roles locally and copies a link when clipboard access
  is available;
- More opens Appearance, Performance, and About actions;
- the command palette filters and executes the shared action registry;
- template, rename, delete, share, and preferences use the shared modal;
- comments support add, resolve, and reopen;
- history supports named snapshots, selection, preview, and restore;
- outline, performance, context menu, toast, voice, and document drawers have
  explicit close behavior.

Dialogs use a portal, modal semantics, initial focus, focus containment, Escape
dismissal, backdrop dismissal where appropriate, focus restoration, and inert
background content. Delete uses an in-product confirmation instead of
`window.confirm`. Overlay code and CSS load only after the first overlay is
requested.

Application shortcuts:

| Shortcut | Action |
| --- | --- |
| `Command/Ctrl+N` | New document |
| `Command/Ctrl+Shift+P` | Command palette |
| `Command/Ctrl+Shift+F` | Focus mode |
| `Command/Ctrl+Shift+O` | Outline |
| `Command/Ctrl+Shift+M` | Performance inspector |
| `Command/Ctrl+Shift+D` | Document rail |
| `Command/Ctrl+\` | Cycle available view modes |
| `Control+F1` | Collapse or expand the desktop ribbon |
| `Command/Ctrl+P` | Preview and print |

Editor-specific shortcuts remain in the CodeMirror keymap.

## Responsive postures

Shells are chosen by `client/src/lib/posture.ts` from viewport segments, the
Device Posture API, pointer type, and the visual viewport. Width is only a
fallback when those signals are absent. Shared fallback widths live in
`client/src/lib/product.ts`.

- **phone** — a distinct composer: swipe between Write and Preview, chip
  formatting, and bottom-sheet Insert / AI / More grids. Not a squeezed
  desktop ribbon. Virtual-keyboard inset parks chrome above the keyboard and
  pauses liquid-glass shaders.
- **studio** — tablet mid-width: compact top ribbon, modal document drawer.
- **desktop** — persistent document rail, full ribbon, selection mini-toolbar,
  and the floating liquid dock.
- **fold-book** — two horizontal viewport segments: editor on the left,
  companion stage (Preview / Outline / AI / Review) on the right, hinge gap
  from segment geometry.
- **fold-laptop** — stacked segments: editor above, preview below, hinge as
  the splitter.

`?marks-posture=fold-book` (or `fold-laptop`) forces a shell for walkthroughs
when hardware segments are unavailable.

The overlay document rail is a modal dialog: scrim dismissal, visible close
action, Escape dismissal, initial focus, focus containment, and focus
restoration are component requirements. No shell may make the root document
horizontally scroll.

## Motion and material

- Motion uses transform and opacity for response, deck changes, popovers,
  drawers, dialogs, toasts, and view entrances.
- Typical durations are 120–180ms for command response and 220–280ms for a
  surface entering or leaving.
- Layout itself is not continuously animated.
- `prefers-reduced-motion` and the in-product reduced-motion preference collapse
  animation and transition duration.
- `prefers-reduced-transparency` and the reduced-glass preference replace blur
  with opaque raised surfaces.
- The only allowed continuous movement communicates live state: opening,
  dictation, caret, or a bounded loading skeleton.
- Ambient gradients and grids remain static paint layers.

## Runtime and loading budgets

Budgets are deterministic level-9 gzip transfer sizes for production output,
not raw artifact size:

| Entry or phase | Budget |
| --- | ---: |
| Welcome bounce JavaScript | <= 5 KB |
| Welcome bounce HTML + CSS + JS | <= 25 KB |
| App-shell JavaScript before a document opens | <= 100 KB |
| App-shell CSS | <= 10 KB |
| Work done by the HUD with no live session | 0 intervals |

Additional rules:

- CodeMirror, ESBT session code, KaTeX styles, and preview code do not enter the
  home critical path. The welcome bounce stays HTML-only.
- Local and service sessions load only after a document route asks for one.
- Review dialogs/drawers load only after the first overlay interaction.
- Mermaid and language/diagram implementations load only when document content
  requests them.
- The benchmark runs in its worker and never imports on app home.
- Production source maps are opt-in with `MARKS_SOURCEMAP=1`.
- The service worker keeps versioned shell/asset caches, removes previous Marks
  cache versions, and never caches `/v1` or `/collab` data.
- Polling and sampling stop in hidden documents, irrelevant routes, local
  repository mode, or absent sessions as applicable.

### Production receipt — 2026-08-22

From a clean `npm run build` followed by `npm run check:ui-budgets`:

- Welcome bounce: **0.57 KB gzip** HTML only, then the real document editor.
- App-home critical path: **99.12 KB gzip** total—0.83 KB HTML, 88.51 KB
  JavaScript, and 9.78 KB CSS.
- App overlays remain a feature-paid 5.33 KB JavaScript and 3.51 KB CSS gzip by
  Vite's report; they are absent from initial home references.
- Plain Markdown worker: **72.62 KB gzip** measured at level 9. Syntax
  highlighting, KaTeX JavaScript/styles/fonts, and Mermaid remain separate
  feature-paid requests.
- Production output: **7.43 MiB**, 300 files, and 0 source-map files. Most of
  the total consists of optional renderer languages, diagrams, and math assets,
  not critical-path transfer.

These numbers prove the production bundle boundary. They do not substitute for
network timing on the eventual deployment and CDN.

## Rendering invariants

- Collaborative/local document text does not flow through React state.
- The workspace subtree is route-split away from the home shell.
- Preview blocks retain `content-visibility: auto` and intrinsic-size memory.
- Editor teardown remains a layout-phase operation so a detached CodeMirror
  view cannot receive a session update.
- Glass never wraps the scrolling editor or preview.
- Animations do not run permanent requestAnimationFrame loops.
- The local repository emits the same catalog/session subscriptions consumed by
  the service path.

## Verification matrix

Before a UI handoff, verify at minimum:

- About Marks (`/welcome/` → `/d/about-marks`) and workspace home at `1440x900` and `390x844`;
- document ribbon at `1440x900`, `390x844`, `853x1280`, and `1280x853`;
- persistent desktop rail and modal tablet/phone drawer behavior;
- File, Home, Insert, Draw, AI, Review, and View ribbon decks plus contextual
  Picture / Table / Shape tools;
- phone composer and fold-book companion (including `?marks-posture=`);
- ribbon collapse/expand and focus-mode escape path;
- template creation, rename, duplicate, formatting, comments, history, share
  staging, preferences, command palette, outline, performance, and custom
  delete confirmation;
- light, dark, compact, reduced-motion, and reduced-transparency behavior;
- `npm run typecheck`, browser/auth/markdown/harness/ESBT tests, production
  build, service-worker syntax check, and `npm run check:ui-budgets`;
- production critical references and route-specific chunks, not only total
  `dist` size.

The current receipt proves local document creation, persistence, editing,
preview, review scaffolding, and UI interaction. It does **not** claim that
remote admission, multi-peer collaboration, server persistence, invitations,
or service-backed history work end to end. Those capabilities must be proven
again after `VITE_MARKS_DATA_MODE=service` is wired to runnable services.
