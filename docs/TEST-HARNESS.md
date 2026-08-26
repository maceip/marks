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
  `smoke:platforms` or the repository CI matrix.

marks is exercised on three local browser platforms:

| Platform | Role | How it is found |
| --- | --- | --- |
| **Playwright** | Production two-browser service proof, performance, and the portable surface suite | `playwright` in this repo. Uses its bundled Chromium unless `CHROMIUM_PATH` is set. |
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

`agent-browser` 0.34 declares `engines.node >= 24`. This repository pins Node
24.19.0 with its bundled npm 11.17.0, and locked installs run with
`engine-strict`; an engine mismatch is a failure, not a tolerated warning. Do
not run `agent-browser install` here — system Chrome is already present.

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
plan=$(node --experimental-strip-types scripts/product-variant.ts resolve \
  --variant stable --data-mode service --format canonical)
digest=$(node --experimental-strip-types scripts/product-variant.ts resolve \
  --variant stable --data-mode service --format sha256)
VITE_MARKS_TEST_SERVICE_WORKER=1 npm run build:variant -- \
  --variant stable --data-mode service \
  --out-dir "$PWD/client/dist" --require-deployable
MARKS_PRODUCT_VARIANT=stable MARKS_BUILD_PLAN_JSON="$plan" \
  MARKS_BUILD_PLAN_SHA256="$digest" \
  cargo build -p marks-server --locked --no-default-features
MARKS_TEST_SERVICE_WORKER=1 npm run ci:service -- --bin target/debug/marks-server --static-dir client/dist --browser chromium
MARKS_TEST_SERVICE_WORKER=1 npm run ci:service -- --bin target/debug/marks-server --static-dir client/dist --browser firefox
MARKS_TEST_SERVICE_WORKER=1 npm run ci:service -- --bin target/debug/marks-server --static-dir client/dist --browser webkit

# The scheduled release-shaped workflow uses ci:service, then measure.
```

The retired Node prototype has been removed. `npm run preview` serves only the
static browser build and cannot satisfy REST, WebSocket, offline-resync, or
two-peer acceptance cases.

## What each suite covers

**Portable surface** (`scripts/harness/suites/surface.mjs`) — create a document,
first paint, scoped select-all, preview context menu, honest voice availability,
theme toggle, and honest local/offline status. This is the set that must stay
green on all three platforms.

**Production service matrix** (`scripts/ci-service-ui.mjs` plus
`crates/marks-server/tests/live_service.rs`) — coherent runtime artifact,
session/scratch first paint, atomic document creation, snapshot and one-use
ticket admission, two isolated browser profiles with separate storage and room
tickets, server-mediated convergence, remote caret/presence, per-peer undo,
preview checkbox writeback, outline/scroll behavior, durable server-visible
mutation, reload recovery, IndexedDB checkpoint, Markdown import/export, and
absence of uncaught application errors or `/api` aliases. With
`MARKS_TEST_SERVICE_WORKER=1`, Chromium and Firefox additionally prove a cold
offline service-worker boot, offline journal edit, reconnect, and commit.
Playwright WebKit aborts offline top-level navigation before a controlling
worker can answer, so its honest branch proves real network isolation, an
offline edit in the already-mounted Wasm replica, and reconnect commit. The
receipt then admits two native peers to the same UI-created document and proves
convergence.

**Measure** (`scripts/measure.mjs`) — types a ~60 KB document, then 60
keystrokes in the middle, and prints the HUD. `--budget-*` flags fail the
process when first-render, p50/p95, dirty blocks, or DOM ops exceed a cap.
`.github/workflows/scheduled-service-smoke.yml` builds the release-shaped Rust
server and service-mode browser artifact, reruns the admitted Chromium
service/native-peer proof, and then measures that same production shape with
15 s first-render, 150 ms p50, 300 ms p95, two dirty blocks, and six DOM ops as
hard limits. It runs daily, manually, and on changes to its own contract.
`scripts/wait-for-server.sh` provides its bounded readiness check.

## Adding a check

Put a policy unit test in `client/src/browser/*.test.ts` when the logic is a
function. Put a DOM/gesture check in `scripts/harness/suites/surface.mjs` when
all three drivers should run it. Put browser collaboration, service durability,
reload, offline, and import/export checks in `scripts/ci-service-ui.mjs`; put
live native-peer room invariants in `live_service.rs` or `room_collab.rs`.
