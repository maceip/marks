# Marks UI surface contract

This document is the working contract for the browser product. It intentionally
stops at the UI/service boundary: document admission, persistence, sync, and
identity can change underneath it as long as their public client contracts stay
stable.

## Product posture

Marks is a quiet writing surface with a powerful command layer. The visual model
is **cold glass, hot core**:

- Glass belongs to persistent chrome: the ribbon, drawers, floating inspectors,
  and marketing navigation.
- The editor and preview stay opaque. Scrolling text must never continuously
  repaint a full-screen backdrop filter.
- Purple identifies intent or the current state. It is not general decoration.
- The ribbon may be dense; the document must not feel dense.
- Service failures are expressed in product language. Raw request errors never
  belong in the user-facing surface.

The code-native bolt is the product mark. UI icons remain inline SVG so neither
the app nor the marketing page waits for an icon font or image request.

## Surfaces and ownership

| Surface | Entry | Loading rule | Chrome |
| --- | --- | --- | --- |
| App home | `/` | React shell and document catalog only | Compact titlebar |
| Document | `/d/:id` | Collaboration, editor, preview, and document CSS load on demand | Full adaptive ribbon |
| Benchmark | `/bench` | Worker and benchmark CSS load only on this route | Compact titlebar |
| Marketing | `/welcome/` | Independent static-first HTML/CSS entry; no React or editor dependency | Floating glass navigation |

The marketing page is a separate Vite input so a public website deployment can
map its domain root to `welcome/index.html` without changing the application
router or existing `/` smoke-test contract.

## Adaptive ribbon

The ribbon is route-aware rather than a global toolbar:

- **Home** owns text styles, structure, and dictation.
- **Insert** owns references and block insertion.
- **Review** owns comments, history, and review instrumentation. Unavailable
  service-backed controls are visibly disabled and explain why in their title.
- **View** owns editor/preview posture, outline, theme, and performance.

Desktop and unfolded postures use the full top ribbon. Phone portrait and short
coarse-pointer landscape use a fixed bottom ribbon with the document title at
the top. Split view is removed from the phone command set rather than presenting
a selected mode the layout cannot render.

## Responsive postures

The shared values live in `client/src/lib/product.ts` and must stay aligned with
the media rules in `client/src/styles/layout.css`.

- `0–720px`: phone posture, 44px targets, safe-area bottom ribbon, single pane.
- Short coarse-pointer landscape (`height <= 560px`): phone posture even when
  its CSS width is wider than 720px.
- `721–1099px`: tablet and portrait-foldable posture, full top ribbon and modal
  document drawer.
- `1100px+`: desktop posture with persistent document rail.

The drawer is a modal dialog in overlay postures: scrim dismissal, an always
visible close action, Escape dismissal, initial focus, focus containment, and
focus restoration are part of the component contract.

## Motion and material

- Layout animation is not allowed. Motion uses `transform` and `opacity`.
- Standard durations are 120ms for response and 220ms for a panel entering.
- `prefers-reduced-motion` collapses animation and transition duration.
- `prefers-reduced-transparency` replaces blurred materials with opaque
  surfaces.
- The only allowed continuous motion is status feedback with direct meaning
  (opening, voice, caret, or a bounded loading skeleton).
- Ambient gradients and grids are static paint layers.

## Runtime and loading budgets

Budgets are gzip transfer sizes for production output, not raw artifact size:

| Entry or phase | Budget |
| --- | ---: |
| Marketing JavaScript | <= 5 KB |
| Marketing critical HTML + CSS + JS | <= 25 KB |
| App-shell JavaScript before a document opens | <= 100 KB |
| App-shell CSS | <= 10 KB |
| Work done by the HUD with no live session | 0 intervals |

Additional rules:

- CodeMirror, ESBT session code, KaTeX styles, and preview code must not enter the
  home or marketing critical path.
- Mermaid and language/diagram implementations load only when requested by
  document content.
- The benchmark always runs in its worker and never imports on app home.
- Production source maps are opt-in with `MARKS_SOURCEMAP=1`.
- The service worker keeps versioned shell and asset caches, removes prior Marks
  cache versions, and never caches `/v1` or `/collab` data.
- Polling and sampling stop in hidden documents, irrelevant routes, or absent
  sessions.

### Production receipt — 2026-08-22

From `npm run build`, with default source-map settings:

- Marketing critical path: approximately **8.8 KB gzip** by Vite's report;
  **8.50 KB** in the deterministic level-9 budget check.
- App-home critical path: approximately **86.2 KB gzip** by Vite's report;
  **83.25 KB** in the deterministic level-9 budget check (HTML, CSS, app JS,
  and the small bundler runtime).
- Plain Markdown worker: approximately **74.4 KB gzip**. Syntax highlighting,
  KaTeX JavaScript, KaTeX CSS/fonts, and Mermaid remain separate feature-paid
  requests.
- Phone edit posture does not mount or fetch the preview renderer/worker until
  Preview or Outline asks for it.
- Production output: **7.4 MB**, 0 source-map files. The earlier audited build
  was 26 MB with 467 files.

These numbers prove the production bundle boundary. They do not substitute for
network timing on the eventual deployment/CDN.

## Rendering invariants

- Collaborative text does not flow through React state.
- The workspace subtree is memoized and route-split away from the shell.
- Preview blocks retain `content-visibility: auto` and intrinsic-size memory.
- Editor teardown remains a layout-phase operation so a detached CodeMirror
  view cannot receive a CRDT update.
- Glass must not wrap the scrolling editor or preview.
- No breakpoint may make the root document horizontally scroll.

## Verification matrix

Before a UI handoff, verify at minimum:

- marketing and app home at `1440x900` and `390x844`;
- document ribbon at `1440x900`, `390x844`, `853x1280`, and `1280x853`;
- drawer open/close and keyboard behavior in an overlay posture;
- Home, Insert, Review, and View ribbon decks;
- light, dark, reduced-motion, and reduced-transparency behavior;
- `npm run typecheck`, browser/auth/markdown/harness tests, and a production
  build;
- `npm run check:ui-budgets` against that production build;
- production critical references and route-specific chunks, not only total
  `dist` size.

Until the backing document service is runnable, an unavailable-document render
proves shell and ribbon behavior only. It is not evidence that editor hydration,
collaboration, persistence, or live preview works end to end.
