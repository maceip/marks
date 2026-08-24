# Presence verification and budgets

Presence uses the delivered JSON-value semantics in the ordered PresenceStore
envelope inside WebSocket frame `0x02`. The envelope carries version `2`, a
connection-instance identifier, and a monotonic sequence; it is distinct from
the richer `MKPR` target protocol described as planned in `PRESENCE.md`.
Presence is a best-effort UI hint, never document state. The shared fixtures in
`fixtures/presence-store-v2.json` are the compatibility authority for the
shipped Rust and TypeScript codecs. Decoders must validate the entire payload
before applying any entry.

## Browser matrix

The retained pre-auth Playwright smoke suite opens each collaborator in an
independent browser context, but those contexts do not currently establish
separate valid scratch/session authorities. It is therefore not admitted CI
evidence. The scenarios below remain the browser/browser acceptance target;
current release CI instead proves one authorized Playwright client plus a
native second peer. The target two-browser checks cover avatar/caret arrival,
selection placement, removal/expiry, edits inserted before a remote cursor,
and section navigation while the editor is unmounted in preview-only mode.
Every release run exercises split, editor, and preview modes plus:

* hidden/background tabs and two tabs for one principal;
* offline edits followed by reconnect and bootstrap;
* a 390x844 mobile viewport and desktop viewport;
* `prefers-reduced-motion: reduce` and normal motion.

Failures must report the context, posture, mode, and deterministic peer label;
tests must not infer identity from execution order.

## Performance budgets

Measurements are taken with one editor publishing cursor movement continuously
and seven peers publishing identity plus selection frames. Record p50 and p95;
the p95 limits below are release gates on a local production build:

| Metric | Budget |
| --- | ---: |
| keydown to CodeMirror DOM update (local input) | 16 ms |
| keydown to commit receipt (durable edit, excluding configured 10 ms batch) | 100 ms |
| cursor/selection publication frequency per tab | at most 20 Hz |
| identity heartbeat frequency per tab | at most 1 per 15 s |
| one presence payload | 64 KiB codec limit; 1,536-byte server relay admission limit; 1 KiB operating target |
| resident presence relay memory per room | 2 MiB (128 sockets × 16 KiB bounded queues) |
| presence-caused main-thread scripting/render work | 4 ms per animation frame |
| long frames during saturation | fewer than 1% above 50 ms |

Durable latency is measured from mutation enqueue to `MSG_COMMITTED`; local
input latency is measured separately so networking can never disguise input
jank. Presence saturation must not consume the durable mutation rate limiter.

## Privacy assertions

Tests use unique canary strings and require them to be absent from the SQLite
database (including WAL), coordinated backups, Markdown and bundle exports,
server logs, Cache Storage/service-worker caches, IndexedDB CRDT snapshots, and
downloaded snapshot bytes. Only an in-memory presence frame and peer DOM may
contain a canary. Checks happen both while the room is resident and after clean
shutdown/backup; searching only exported Markdown is insufficient.
