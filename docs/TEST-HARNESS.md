# Browser test harness

There are two layers:

- **`scripts/harness/`** — product suite. Discovers Playwright, Puppeteer, and
  agent-browser on this machine and runs the portable glass checks against a
  running marks server. This is what `npm run smoke:platforms` drives.
- **`.cursor/harness/`** — Cloud Agent CGNAT runtimes. Optional isolated
  namespaces (`cg-playwright`, `cg-puppeteer`, `cg-agent`) with hot Chrome on
  CDP 9222/9223/9224. Used by `.cursor/harness/run-marks-tests.sh` for
  cross-namespace collab. Not required for `npm run smoke` or `smoke:platforms`.

marks is exercised on three local browser platforms:

| Platform | Role | How it is found |
| --- | --- | --- |
| **Playwright** | Deep collab smoke (`npm run smoke`) and the portable surface suite | `playwright` in this repo. Uses its bundled Chromium unless `CHROMIUM_PATH` is set. |
| **Puppeteer** | Same portable surface suite | `puppeteer-core` (preferred) or `puppeteer`. Never downloads Chrome; it launches the system binary. |
| **agent-browser** | Same portable surface suite | The Vercel Labs CLI (`node_modules/.bin/agent-browser` or `PATH`). A CLI, not a Node library — the harness wraps it. |

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
npm run test:harness               # chrome-discovery unit tests

# app must already be running
npm run smoke                      # Playwright two-peer / REST / engines
npm run smoke:surface              # portable glass checks, Playwright
npm run smoke:puppeteer
npm run smoke:agent-browser
npm run smoke:platforms            # glass checks on all three
```

Every runner accepts `--help`. `scripts/harness/run.mjs` also takes `--driver`, `--url`, `--headed`, `--list`.

```bash
npm run build && npm start &
MARKS_URL=http://127.0.0.1:3000 npm run smoke:platforms
```

## What each suite covers

**Portable surface** (`scripts/harness/suites/surface.mjs`) — create a document, first paint, scoped select-all, preview context menu, comment composer, voice button, theme toggle, offline status. This is the set that must stay green on all three platforms.

**Playwright smoke** (`scripts/smoke.mjs`) — the above plus incremental preview, two ESBT peers, per-user undo, checkbox write-back, outline, scroll sync, snapshot/export REST, live-room delete, retired-engine refusal.

## Adding a check

Put a policy unit test in `client/src/browser/*.test.ts` when the logic is a function. Put a DOM/gesture check in `scripts/harness/suites/surface.mjs` when all three platforms should run it. Put a two-browser or HTTP check in `scripts/smoke.mjs`.
