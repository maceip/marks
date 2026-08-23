# marks-server

The one Rust Marks process from [`docs/V1-SCOPE.md`](../../docs/V1-SCOPE.md):
identity and sessions, document ACL admission, the `/v1` document API, and one
durable native ESBT room per live document.

Security decisions are the pure validators in [`marks-auth`](../marks-auth);
the collaboration algorithm is the pinned
[maceip/ESBT-web](https://github.com/maceip/ESBT-web) `esbt` crate. This crate
adds exactly what those leave out: HTTP, randomness, storage, transactions,
rate limits, origin/CSRF checks, rooms, and live-socket revocation. ESBT
receives site IDs and bytes only — never a session, an email, or a role.

## Running

```bash
cargo run -p marks-server
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `MARKS_LISTEN` | `127.0.0.1:3000` | Bind address |
| `MARKS_DB` | `marks.db3` | SQLite database (WAL, synchronous FULL) |
| `MARKS_ORIGIN` | `http://<listen>` | Exact origin for `Origin` checks, device audiences, pairing links |
| `MARKS_STATIC_DIR` | unset | Built browser client to serve with an SPA fallback |
| `MARKS_EVT_ENABLED` | off | Feature flag for the experimental Chrome EVT rail |
| `MARKS_EVT_LOCATOR_KEY` | — | Hex HMAC key (≥32 bytes) for verified-email locators; required when EVT is on |
| `MARKS_AGENT_PROVIDER` | `disabled` | Optional in-page planner: `disabled` or `openai` |
| `MARKS_OPENAI_API_KEY_FILE` | — | OpenAI key file (regular file, ≤16 KiB, mode `0600` or stricter); required with the OpenAI provider |
| `MARKS_OPENAI_MODEL` | — | Server-owned OpenAI model identifier; required with the OpenAI provider |

The EVT redeem endpoint additionally refuses to run without a trusted issuer
adapter; `MARKS_EVT_INSECURE_TEST_ADAPTER=1` enables the test-only shim that
integration tests use to exercise the transaction path.

The optional agent gateway is disabled unless all three provider settings are
explicitly configured. The browser cannot provide or override the key, model,
or endpoint and does not send Markdown source to the planner. Admission,
timeouts, event retention, and output ceilings have additional bounded
`MARKS_AGENT_*` variables documented in
[`RIBBON-PRACTICAL-INTERFACES.md`](../../docs/RIBBON-PRACTICAL-INTERFACES.md).

Production on `marks.secure.build` is documented in [`deploy/`](../../deploy/).

## HTTP surface

The identity endpoints are `docs/AUTHN-AUTHZ-PROTOCOL.md` §10 verbatim:
scratch creation and pending-device binding, QR and four-word pairings
(create/inspect/bootstrap/approve/finalize), silent device
challenges/redemption, rotating session bootstrap/logout, device
enumeration/revocation, and the flagged EVT challenge/redeem pair.

Documents: list/create/get/rename/duplicate/delete, `GET …/export` (markdown),
`GET …/snapshot[?shallow=1]` (canonical engine bytes), plus one-use room
tickets via `POST /v1/documents/{id}/session` (rotating session + ACL) and
`POST /v1/scratch/documents/{id}/session` (scratch capability). Sharing is a
separate capability from the document ID: named grants
(`PUT/DELETE …/shares/{principal}`) and rotatable link grants
(`POST/DELETE …/link`, `POST …/link/redeem`), each change bumping the
document's authorization epoch so live sockets re-resolve or close.

Unknown, deleted, and unauthorized documents are one indistinguishable 404.
Authentication failures are one indistinguishable 401.

The session-only agent surface is `GET /v1/agent/capabilities`,
`POST /v1/agent/runs`, `GET /v1/agent/runs/{id}/events`,
`POST /v1/agent/runs/{id}/tool-results`, and
`DELETE /v1/agent/runs/{id}`. Mutations use the existing exact-origin and CSRF
guards; run creation also performs the existing document read-ACL check.

## Rooms

`GET /collab/esbt/{id}` upgrades only with the subprotocol offer
`marks.esbt.v1, marks.ticket.v1.<ticketId>.<secret>`; the server echoes only
`marks.esbt.v1` and consumes the ticket atomically during the upgrade,
binding an immutable `RoomActor`. `?vv=` carries the replica's version vector
(base64url of the engine encoding); credentials never ride the URL.

Frames are one tag byte plus payload — `0x01` update, `0x02` ephemeral
presence relay, `0x03` server version vector, `0x04` snapshot, `0x05` synced —
where update/snapshot payloads are the ESBT core's canonical `ESBM`/`ESBF`
encodings. A client update is role-checked before any CRDT decoding, applied
to the staged room replica, journaled in one transaction (which re-checks the
document's liveness and authorization epoch), and only then broadcast.
Duplicate updates commit and broadcast nothing. Snapshot compaction is
asynchronous and never defines saved-ness. Deletion closes sockets with
`4404`; revocation and role changes close or demote live sockets with `4401`;
rejected writers get `4403` and never reach the engine or the journal.

## Storage

One SQLite database owns ordered migrations for the protocol schema
(principals, scratch workspaces, pending devices, devices, controllers,
sessions, pairings, challenges, locators, documents, ACLs, link grants,
replica sites, tickets, the update journal, and the `op_authors` authorship
sidecar). Migration 10 additionally owns bounded agent run/event/tool-receipt
metadata when the optional gateway is used; it stores no Markdown or tool
arguments. Documents keep a compacted full snapshot plus every journaled update
above it; rooms rehydrate by replaying exactly those bytes.

## Tests

```bash
cargo test -p marks-server
```

`tests/auth_flow.rs` drives scratch → pairing → bootstrap → finalize →
CSRF logout → silent device recovery (with replays failing closed) and the
EVT transaction path. `tests/room_collab.rs` drives real ESBT replicas over
real WebSockets: two-peer convergence, offline deltas via the version-vector
exchange, viewer write rejection, editor grant/revocation on live sockets,
session logout closing sockets, deletion close codes, one-use/stale ticket
refusal, and restart recovery from the journal.
