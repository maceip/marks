# Browser test harness

There are two layers:

- **`scripts/harness/`** — product suite. Discovers Playwright, Puppeteer, and
  agent-browser on this machine and runs the portable glass checks against a
  running Marks web app. The default local workspace is sufficient. This is
  what `npm run smoke:platforms` drives.
- **`.cursor/harness/`** — Cloud Agent CGNAT runtimes. Optional isolated
  namespaces (`cg-playwright`, `cg-puppeteer`, `cg-agent`) with hot Chrome on
  CDP 9222/9223/9224. Used by `.cursor/harness/run-marks-tests.sh` for
  cross-namespace collab against a running **Rust** `marks-server`. It will
  not start the retired Node `server/` workspace. Not required for
  `npm run smoke` or `smoke:platforms`.

marks is exercised on three local browser platforms:

| Platform | Role | How it is found |
| --- | --- | --- |
| **Playwright** | Deep collab smoke (`npm run smoke`) and the portable surface suite | `playwright` in this repo. Uses its bundled Chromium unless `CHROMIUM_PATH` is set. |
| **Puppeteer** | Same portable surface suite | `puppeteer-core` (preferred) or `puppeteer`. Never downloads Chrome; it launches the system binary. |
| **agent-browser** | Same portable surface suite | The Vercel Labs CLI (`node_modules/.bin/agent-browser` or `PATH`). A CLI, not a Node library — the harness wraps it. |

That driver portability suite is distinct from the production service matrix.
`scripts/ci-service-ui.mjs` runs the built service client in Playwright's
Chromium, Firefox, and WebKit engines against one live Rust binary.

`npm run harness:probe` prints what this machine actually has.

## Chrome this environment ships

The Cloud Agent snapshot has two different Chrome entry points. They are not interchangeable.

| Path | What it is | Harness |
| --- | --- | --- |
| `/opt/google/chrome/chrome` | Real Google Chrome 148 binary | **Used** for Puppeteer and agent-browser |
| `/opt/google/chrome/google-chrome` | Upstream wrapper around that binary | Fallback |
| `/usr/bin/google-chrome` | Alternatives link to the upstream wrapper | Fallback |
| `/usr/local/bin/google-chrome` (and `/usr/local/bin/chrome`) | Desktop wrapper that pins `--remote-debugging-port=9222` and `--user-data-dir=/home/ubuntu/.config/google-chrome` | **Skipped**. A second launch joins the desktop instance. |
| `~/.cache/ms-playwright/chromium-1234/.../chrome` | Playwright's bundled Chromium | **Used** by Playwright |

`PLAYWRIGHT_SERVICE_URL` may be set (hosted Playwright). The harness does not use it — tests stay on local Chrome/Chromium.

`agent-browser` 0.34 declares `engines.node >= 24`. This repo's engine is Node 22; npm warns, the CLI still runs. Do not run `agent-browser install` here — system Chrome is already present.

Override any of this with `CHROMIUM_PATH`, `CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH`, or `AGENT_BROWSER_EXECUTABLE_PATH`.

## Commands

```bash
npm run harness:probe              # discover platforms (no browser)
npm run harness:probe -- --launch  # plus a userAgent check on each driver
npm run test:harness               # chrome-discovery, measure budgets, wait-for-server
npm run test:bench                 # deterministic engine fixture + receipt statistics

# app must already be running
npm run measure                    # large-doc preview latency (print only)
npm run measure -- --budget-p50 150 --budget-p95 300 --budget-first-ms 20000
npm run smoke                      # Playwright two-peer / REST / engines
npm run smoke:surface              # portable glass checks, Playwright
npm run smoke:puppeteer
npm run smoke:agent-browser
npm run smoke:platforms            # glass checks on all three
```

Every runner accepts `--help`. `scripts/harness/run.mjs` also takes `--driver`, `--url`, `--headed`, `--list`.

```bash
npm run dev
MARKS_URL=http://127.0.0.1:5173 npm run smoke:platforms

# CI-shaped proof: live binary + service-mode UI + native two-peer room.
VITE_MARKS_DATA_MODE=service VITE_MARKS_TEST_SERVICE_WORKER=1 npm run build
cargo build -p marks-server
MARKS_TEST_SERVICE_WORKER=1 npm run ci:service -- --bin target/debug/marks-server --static-dir client/dist --browser chromium
MARKS_TEST_SERVICE_WORKER=1 npm run ci:service -- --bin target/debug/marks-server --static-dir client/dist --browser firefox
MARKS_TEST_SERVICE_WORKER=1 npm run ci:service -- --bin target/debug/marks-server --static-dir client/dist --browser webkit

# The deeper two-browser smoke is service-only and still local.
# Start the Rust Marks server separately on :3000, then:
MARKS_URL=http://127.0.0.1:3000 npm run smoke
```

The retired Node prototype has been removed. `npm run preview` serves only the
static browser build and cannot satisfy REST, WebSocket, offline-resync, or
two-peer acceptance cases.

## What each suite covers

**Portable surface** (`scripts/harness/suites/surface.mjs`) — create a document,
first paint, scoped select-all, preview context menu, honest voice availability,
theme toggle, and honest local/offline status. This is the set that must stay
green on all three platforms.

**Playwright smoke** (`scripts/smoke.mjs`) — the above plus incremental preview, two ESBT peers, per-user undo, checkbox write-back, outline, scroll sync, snapshot/export REST, live-room delete, retired-engine refusal.

**Production service matrix** (`scripts/ci-service-ui.mjs` plus
`crates/marks-server/tests/live_service.rs`) — coherent runtime artifact,
session/scratch first paint, atomic document creation, snapshot and one-use
ticket admission, writable CodeMirror, durable server-visible mutation,
reload recovery, IndexedDB checkpoint, Markdown import/export, and absence of
uncaught application errors or `/api` aliases. With
`MARKS_TEST_SERVICE_WORKER=1`, Chromium and Firefox additionally prove a cold
offline service-worker boot, offline journal edit, reconnect, and commit.
Playwright WebKit aborts offline top-level navigation before a controlling
worker can answer, so its honest branch proves real network isolation, an
offline edit in the already-mounted Wasm replica, and reconnect commit. The
receipt then admits two native peers to the same UI-created document and proves
convergence.

**Measure** (`scripts/measure.mjs`) — types a ~60 KB document, then 60
keystrokes in the middle, and prints the HUD. `--budget-*` flags fail the
process when first-render, p50/p95, dirty blocks, or DOM ops exceed a cap. The
old scheduled workflow was removed with the Node server; restore it only after
it boots and measures the production Rust artifact. `scripts/wait-for-server.sh`
remains the bounded readiness helper for that workflow.

## Adding a check

Put a policy unit test in `client/src/browser/*.test.ts` when the logic is a
function. Put a DOM/gesture check in `scripts/harness/suites/surface.mjs` when
all three drivers should run it. Put service durability, reload, offline, and
import/export checks in `scripts/ci-service-ui.mjs`; put live native-peer room
invariants in `live_service.rs` or `room_collab.rs`.
