# Marks UI ↔ `marks-server` contract

**Status:** implementer contract for the browser against the live Rust server
**Owner:** Marks
**Last updated:** 2026-08-22
**Server source of truth:** `crates/marks-server/src/app.rs` plus the handlers
it routes to
**Protocol source of truth:** [`AUTHN-AUTHZ-PROTOCOL.md`](AUTHN-AUTHZ-PROTOCOL.md)

The presentation UI can keep moving. This document is what the frontend must
implement, or keep implementing, so it stays aligned with `marks-server` while
that crate evolves. It is not a visual spec. Visual ownership stays in
[`UI-SURFACE.md`](UI-SURFACE.md).

If a server change alters a path, header, cookie, JSON field, status code, or
room admission rule, update this file in the same change.

## 1. Relationship to other docs

| Document | Owns |
| --- | --- |
| This file | Browser-visible HTTP, cookies, headers, JSON, and room-admission interfaces |
| [`AUTHN-AUTHZ-PROTOCOL.md`](AUTHN-AUTHZ-PROTOCOL.md) | Security invariants, identity state machine, role matrix, threat model |
| [`UI-SURFACE.md`](UI-SURFACE.md) | One React app, postures, ribbon, loading budgets, local-mode UX |
| [`BROWSER-SURFACE.md`](BROWSER-SURFACE.md) | Clipboard, context menu, voice, cache, tab sync |
| [`V1-SCOPE.md`](V1-SCOPE.md) | Release boundary; ESBT is identity-blind |
| [`ESBT-INTEGRATION.md`](ESBT-INTEGRATION.md) | Engine/wire work; not a second identity system |

Do not re-litigate ESBT encoding here. Room replica and wire stay canonical
Rust-core `ESBM` / `ESBS` / `ESBF`. The temporary TypeScript `@marks/esbt`
package is not a production transcoding bridge.

## 2. Two product modes

`VITE_MARKS_DATA_MODE` is `local` unless set to `service` at build time
(`client/src/lib/product.ts`).

| Mode | UI may do | UI must not do |
| --- | --- | --- |
| `local` | Own catalog, editor, review, share *staging*, history in the browser | Claim invitations were sent, rooms exist, or a principal is signed in |
| `service` | Call only the interfaces below, through the modules in §4 | Invent a second auth header, a Node backend, or a second room URL |

Components stay mode-agnostic. `useDocuments`, `useDocumentMeta`, and
`useSession` pick the adapter at the boundary. Presentation work should not
grow new `/v1` callers inside ribbon or overlay components.

## 3. Authority: two callers, never merged

The server has exactly two request authorities:

| Caller | How it arrives | What it is |
| --- | --- | --- |
| Session | HTTP-only cookie `__Host-marks_session=<sessionId>.<secret>` | A durable principal + device |
| Scratch | `Authorization: MarksScratch <scratchId>.<capability>` | Temporary tab-scoped workspace capability |

There is **no** `MarksSession` header. JavaScript cannot read the session
cookie. Session presence is discovered with `GET /v1/auth/session` and
`credentials: "same-origin"`.

### 3.1 Resolution order

This order is protocol, not a UI preference:

1. If `GET /v1/auth/session` is `200`, the tab is a session caller. Clear any
   leftover scratch from `sessionStorage`.
2. Else if a live scratch credential is in `sessionStorage`, the tab is a
   scratch caller.
3. Else `POST /v1/auth/scratch`, persist the capability in `sessionStorage`,
   and become a scratch caller.

A leftover scratch credential must never hide a live session. After promotion
the scratch row is claimed; sending `MarksScratch` then fails closed. The
server also prefers a valid session cookie over a leftover scratch header on
shared `/v1/documents*` routes. The UI must still stop sending that header.

Implemented in `client/src/auth/caller.ts` as `ensureServiceCaller`,
`resolveServiceCaller`, and `applyServiceCallerHeaders`.

### 3.2 Where each caller talks

| Need | Session | Scratch |
| --- | --- | --- |
| Catalog, create, rename, duplicate, delete, export | `/v1/documents…` with cookie only | `/v1/documents…` with `MarksScratch` |
| Snapshot | `GET /v1/documents/{id}/snapshot` | `GET /v1/scratch/documents/{id}/snapshot` |
| Room ticket | `POST /v1/documents/{id}/session` | `POST /v1/scratch/documents/{id}/session` |
| Shares and link grants | `/v1/documents/{id}/shares` and `/link` | Forbidden. Scratch cannot share. |
| Pairing / EVT / pending device | Not these endpoints | Scratch header |

There is no `/v1/scratch/documents` list or create route. Scratch catalog
traffic uses `/v1/documents` plus the scratch header. The scratch prefix
exists only for snapshot and room-ticket mint.

### 3.3 Origin and CSRF

Browser `fetch` must use `credentials: "same-origin"`.

Cookie-authenticated **mutations** require the exact configured origin
(`MARKS_ORIGIN`). The browser sends `Origin` on those POSTs/PATCHes/DELETEs
automatically when the page origin matches. Do not send a forged Origin.

These auth-critical mutations also require `X-Marks-CSRF` set to the `csrf`
value from `GET /v1/auth/session` (or the finalize/redeem session body):

- `DELETE /v1/auth/session`
- `DELETE /v1/auth/devices/{id}`

Document create/rename/delete/share currently require origin, not CSRF. Do
not add CSRF on those routes in the UI until the server and this contract
change together.

### 3.4 Errors

Every JSON error is `{ "error": "<stable message>" }`.

| Status | Meaning the UI may show |
| --- | --- |
| `400` | Malformed body or unknown field on a security-relevant object |
| `401` | Authentication failed. Same answer for missing, guessed, expired, or claimed credentials |
| `403` | Authenticated but not allowed (CSRF, foreign origin, non-controller revoke) |
| `404` | Unknown, deleted, or unauthorized document. Do not distinguish those cases |
| `409` | Promotion or share conflict. Do not create a second principal |
| `429` | Rate limited. Back off; do not mint another scratch in a tight loop |
| `500` | Internal. Toast a generic failure |

Raw paths, status text, and protocol jargon do not belong in user-facing copy
([`UI-SURFACE.md`](UI-SURFACE.md)).

## 4. Client modules

Keep new service-mode work inside these files. Do not grow a second API layer
under `components/`.

| Module | Job | State |
| --- | --- | --- |
| `client/src/auth/caller.ts` | Resolve session-vs-scratch; apply headers | Done for first paint |
| `client/src/auth/scratch.ts` | Tab-scoped `sessionStorage` credential | Done |
| `client/src/auth/device-key.ts` | Non-extractable P-256 key in IndexedDB | Crypto done; not bound on first paint |
| `client/src/auth/protocol.ts` | Canonical grant / bootstrap / proof bytes | Done; must stay byte-identical to Rust |
| `client/src/auth/room-access.ts` | Snapshot + ticket mint + room URL checks | Done for both prefixes |
| `client/src/lib/api.ts` | Catalog/document HTTP | Headers done; CSRF/share/pairing not wired |
| `client/src/data/documents.ts` | `DocumentRepository` local vs service | Service path uses `api.ts` |
| `client/src/hooks/useSession.ts` | Opens `CollabSession` only with a provider | Service requires `documentAccess` |
| `client/src/collab/` | `CollabSession` + current TS engine | Local collab works; service room bytes wait on Rust/Wasm |

Presentation (`App.tsx`, ribbon, overlays) consumes these modules. It does
not parse cookies, mint tickets, or choose `/v1` vs `/v1/scratch` itself
beyond calling `ensureServiceCaller` / `createMarksDocumentAccess`.

## 5. Identifiers and encoding

- Opaque IDs are `[A-Za-z0-9_-]{8,128}` (`OPAQUE_ID_PATTERN`).
- Secrets, capabilities, tickets, and pairing fragments are 32 raw bytes,
  base64url without padding.
- Public keys are the 65-byte uncompressed SEC1 P-256 point, base64url.
- Signatures are 64-byte IEEE P1363, base64url.
- JSON never enters a signature. Canonical bytes live in `protocol.ts` and
  `marks-auth`. Changing field order in JSON is not a security change;
  changing `signing_bytes` is.

Do not display `principalId`, `scratchId`, `sessionId`, `deviceId`, or
`siteId` as a person’s name. Scratch is not a person.

## 6. HTTP interfaces the UI must speak

Bodies that use `#[serde(deny_unknown_fields)]` reject extra keys with `400`.
Do not send leftover client fields on auth objects.

### 6.1 First paint and session

#### `POST /v1/auth/scratch`

- Authority: none, rate limited
- Response `201`:

```json
{ "scratchId": "scratch_…", "capability": "<b64url 32>", "expiresAtMs": 0 }
```

Store `{ version: 1, scratchId, capability, expiresAtMs }` in
`sessionStorage` only (`marks.auth.scratch.v1`). Never `localStorage`, URL,
cookie, or analytics.

#### `GET /v1/auth/session`

- Authority: session cookie
- Response `200` (may also `Set-Cookie` if the secret rotated):

```json
{
  "principalId": "principal_…",
  "deviceId": "device_…",
  "sessionId": "session_…",
  "csrf": "<b64url>"
}
```

- Response `401`: no live session. Fall through to scratch.

Cache `csrf` in memory for logout / device revoke. Do not persist it.

#### `DELETE /v1/auth/session`

- Authority: session + exact origin + `X-Marks-CSRF`
- Response `200`: `{ "revoked": true }` and a cleared cookie
- After this, probe session again and mint scratch if the tab stays open

### 6.2 Pending device and promotion

The durable-upgrade line the UI already owns:

> This workspace is temporary. Scan with your phone to keep it and use it on
> other devices.

#### `PUT /v1/auth/scratch/{scratchId}/device`

- Authority: scratch, and `{scratchId}` must match the header
- Body: `{ "deviceId": "device_…", "publicKey": "<b64url SEC1>" }`
- Response `204`
- Bind once per tab after the key exists. Generating the key does not promote
  the workspace.

#### `POST /v1/auth/pairings`

- Authority: scratch; pending device must already be bound
- Response `201`:

```json
{
  "pairingId": "pairing_…",
  "secret": "<b64url 32>",
  "expiresAtMs": 0,
  "url": "https://origin/link#v1.<pairingId>.<secret>"
}
```

Put only `url` (or the `#v1.…` fragment) in the QR. The secret is the
capability. Two-minute default TTL.

#### `POST /v1/auth/pairings/{id}/inspect`

- Authority: body `{ "secret": "<b64url 32>" }`, no session
- Response `200`: `{ "origin", "pendingDeviceId", "pendingDevicePublicKeyHash", "expiresAtMs" }`
- Phone confirmation only. A guessed id without the secret is `401`.

#### `POST /v1/auth/pairings/{id}/bootstrap`

- First phone on an unseen controller. Server creates the principal.
- Body: `{ "secret", "bootstrap": { version, controllerId, controllerDeviceId, controllerPublicKeyHash, pairingId, scratchId, pendingDeviceId, pendingDevicePublicKeyHash, issuedAtMs, expiresAtMs }, "controllerPublicKey", "signature" }`
- `bootstrap` bytes are `encodeControllerBootstrap` / `marks-controller-bootstrap-v1`
- Response `201` plus `Set-Cookie` for the **phone** session, and the session JSON from §6.1

#### `POST /v1/auth/pairings/{id}/approve`

- Existing controller enrolls this browser into its principal
- Authority: controller session cookie + exact origin
- Body: `{ "secret", "grant": { …DeviceGrant fields… }, "signature" }`
- Grant bytes are `encodeDeviceGrant` / `marks-device-grant-v1`
- Response `200`: `{ "approved": true }`
- Desktop tab then calls finalize

#### `POST /v1/auth/pairings/{id}/finalize`

- Authority: **claimed** scratch header (the same capability, now claimed)
- Response `201` plus `Set-Cookie` for the **browser** session, and session JSON
- After `201`, clear scratch storage and treat the tab as a session caller
- Claimed scratch sockets are closed; reconnect with a principal ticket

Phone bootstrap and desktop finalize are one principal. A `409` means another
request won. Do not retry into a second account.

### 6.3 Silent return visit

When `GET /v1/auth/session` is `401` but IndexedDB still has an enrolled
device key:

1. `POST /v1/auth/device/challenges` with `{ "deviceId" }`
   - Response `{ "challengeId", "challenge", "audience", "expiresAtMs" }`
   - Unknown devices get an indistinguishable body; signing still fails closed
2. Sign `encodeDeviceSessionProof` / `marks-device-session-v1`
3. `POST /v1/auth/device/redeem` with `{ "proof": { version, challengeId, deviceId, deviceKeyEpoch, audience, challenge, issuedAtMs, expiresAtMs }, "signature" }`
4. Response `201` plus `Set-Cookie` and session JSON

No WebAuthn, no user-presence prompt, no password. Challenge replay is `401`.

### 6.4 Device list and revoke

#### `GET /v1/auth/devices`

- Authority: session
- Response:

```json
{
  "devices": [{ "deviceId", "capabilities", "keyEpoch", "createdAtMs", "lastUsedAtMs", "revokedAtMs" }],
  "controllers": [{ "controllerId", "deviceId", "createdAtMs", "revokedAtMs" }],
  "sessions": [{ "sessionId", "deviceId", "createdAtMs", "expiresAtMs", "revokedAtMs" }]
}
```

#### `DELETE /v1/auth/devices/{id}`

- Authority: controller session + origin + `X-Marks-CSRF`
- Response `{ "revoked": true }`
- Live sockets for that device close immediately

### 6.5 Documents

Document JSON uses **snake_case timestamps**. Auth JSON uses **camelCase
`expiresAtMs`**. Do not “normalize” one into the other at the HTTP boundary.

```json
{
  "id": "document_…",
  "title": "Untitled",
  "engine": "esbt",
  "chars": 0,
  "created_at": 0,
  "updated_at": 0
}
```

Refuse any `engine` other than `esbt` (`documentIsOpenable`).

| Method | Path | Authority | Origin | Body | Success |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/v1/documents` | session or scratch | no | — | `{ "documents": [DocumentMeta] }` |
| `POST` | `/v1/documents` | session or scratch | session only | `{ "title"? }` | `201 { "document" }` |
| `GET` | `/v1/documents/{id}` | session or scratch | no | — | `{ "document", "connections" }` |
| `PATCH` | `/v1/documents/{id}` | owner / scratch-owner | session only | `{ "title" }` | `{ "document" }` |
| `DELETE` | `/v1/documents/{id}` | owner / scratch-owner | session only | — | `{ "deleted": true }` |
| `POST` | `/v1/documents/{id}/duplicate` | readable | session only | `{}` | `201 { "document" }` |
| `GET` | `/v1/documents/{id}/export` | readable | no | — | `text/markdown` attachment |

`chars` is a UTF-16 code-unit count. Titles are 1–512 characters after trim.

### 6.6 Snapshot and room ticket

#### Snapshot

- Session: `GET /v1/documents/{id}/snapshot?shallow=1`
- Scratch: `GET /v1/scratch/documents/{id}/snapshot?shallow=1`
- Headers: `Accept: application/octet-stream` plus caller auth
- Body: raw ESBT snapshot bytes (`application/octet-stream`)
- `shallow=1` is the cold-open compact snapshot; the server may fall back to
  a full snapshot

`createMarksDocumentAccess().fetchSnapshot` already selects the prefix.

#### Ticket mint

- Session: `POST /v1/documents/{id}/session` with cookie + exact origin
- Scratch: `POST /v1/scratch/documents/{id}/session` with `MarksScratch`
- Body: `{ "siteId": "<previous site or omit>" }` (`siteId` may be a string
  or number; unknown values allocate a new site)
- Response:

```json
{
  "roomUrl": "/collab/esbt/document_…",
  "ticketId": "ticket_…",
  "ticketSecret": "<b64url 32>",
  "role": "owner" | "editor" | "commenter" | "viewer" | null,
  "siteId": "<u32 as string>"
}
```

Scratch tickets omit a principal role (`role` is `null`). Persist `siteId`
per document so reconnects reuse the replica site. Two devices never share a
site.

Mint a fresh ticket immediately before every WebSocket open, including
reconnect. Tickets last 30 seconds and are one-use.

### 6.7 Sharing (session owner only)

Share UI in local mode is staging only. In service mode these endpoints are
the real invitations.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| `GET` | `/v1/documents/{id}/shares` | — | `{ "shares": [{ "principalId", "role" }] }` |
| `PUT` | `/v1/documents/{id}/shares/{principalId}` | `{ "role": "editor"\|"commenter"\|"viewer" }` | `{ "role" }` |
| `DELETE` | `/v1/documents/{id}/shares/{principalId}` | — | `{ "revoked": true }` |
| `POST` | `/v1/documents/{id}/link` | `{ "role", "ttlMs"? }` | `{ "token", "role", "expiresAtMs" }` |
| `DELETE` | `/v1/documents/{id}/link` | — | `{ "revoked": true }` |
| `POST` | `/v1/documents/{id}/link/redeem` | `{ "token" }` | `{ "role" }` |

Shares cannot grant `owner`. Link redeem requires a live session. Scratch
callers receive `401`/`404`, not a staged success.

### 6.8 EVT (experimental)

`POST /v1/auth/evt/challenges` and `POST /v1/auth/evt/redeem` exist behind
`MARKS_EVT_ENABLED`. When the flag is off they are `404`. Do not build a
primary account-creation UI on EVT. Phone pairing is the v1 upgrade rail.
If this UI is added later, follow [`AUTHN-AUTHZ-PROTOCOL.md`](AUTHN-AUTHZ-PROTOCOL.md)
§6 and keep raw email out of storage, logs, and toasts.

### 6.9 Health

`GET /healthz` → `{ "ok": true }`. Not a product surface.

## 7. Room interface

```text
GET /collab/esbt/{documentId}?vv=<optional base64url version>
```

Retired paths ` /collab/loro/{id}` and `/collab/yjs/{id}` are refused. Do not
call them.

Upgrade rules, already enforced in `room-access.ts`:

1. Offer `marks.esbt.v1` and `marks.ticket.v1.<ticketId>.<ticketSecret>`.
2. The server echoes **only** `marks.esbt.v1`. Never put the ticket in a URL,
   query, or header log.
3. `roomUrl` must stay on the page origin, `ws:`/`wss:` matching `http:`/`https:`,
   path prefix `/collab/`, no userinfo, hash, or query on the minted URL.
   Reconnect may add `?vv=` only.
4. Principal sockets also send the session cookie on the upgrade.
5. After claim, epoch change, logout, or revoke, the server closes the socket.
   The UI reconnects with a new ticket under the current caller.

Frame tags the current test peer already speaks: `0x01` update, `0x02`
ephemeral, `0x03` server version, `0x04` snapshot, `0x05` synced. Viewer and
commenter sockets may not send `MSG_UPDATE`. Comments are not ESBT bytes.

**Service-mode text sync is not finished in the browser.** The room speaks
Rust-core encodings. The temporary TypeScript engine does not. Catalog,
identity, admission, and snapshot *fetch* can land now; applying room bytes
waits for the Rust/Wasm `CollabSession` binding. Do not add a TypeScript
transcoder to “make the UI work.”

## 8. Product behavior the UI still owes

These are UI jobs. The server already implements the other side.

1. **First paint (service):** `ensureServiceCaller` before catalog or editor
   work. No registration form.
2. **Honest scratch:** closing an unpromoted tab is unrecoverable. Say so.
3. **Upgrade QR:** bind pending device, create pairing, render `url`, poll or
   wait, then `finalize` and switch caller to session.
4. **Return visit:** session probe, then silent device redeem, then scratch.
5. **Share dialog:** local mode stays staged; service mode calls §6.7 and
   does not claim success on `401`/`404`.
6. **Logout / devices:** CSRF header from the session bootstrap.
7. **Reconnect:** new ticket, same `siteId`, `?vv=` when the replica has one.
8. **Role copy:** owner / editor / commenter / viewer as in the protocol
   matrix. Scratch is “temporary workspace,” never a named account.
9. **Comments and history:** keep the local adapters until a review HTTP
   service exists. There are no comment routes on `marks-server` today.
10. **Errors:** map §3.4 to toasts; never dump `{ "error": … }` strings that
    leak which record failed.

Presentation surfaces for 2, 3, 5, 6, and 8 exist in local mode: Temporary
chip, Keep workspace, Account and devices, and Share with protocol role copy.
They stay honest. They do not mint pairings, send CSRF, or claim a session.

## 9. What the UI must not invent

- A `MarksSession` Authorization scheme
- Treating leftover scratch as stronger than a live session
- A second React app, Node document store, or `/api` alias
- A TypeScript ESBT transcoding bridge or dual-engine room
- Passwords, passkeys, magic links, OAuth, or short pairing codes
- Displaying scratch, device, or site IDs as people
- Sending comments as opaque text updates
- Logging tickets, scratch capabilities, pairing secrets, or CSRF tokens
- Calling `/v1/scratch/documents` for list/create (those routes do not exist)

## 10. Current gap map

Use this as the frontend checklist. Server boxes are closed unless noted.

| Capability | Server | Browser |
| --- | --- | --- |
| Scratch mint + storage | Yes | Yes (`scratch.ts`, `caller.ts`) |
| Session probe prefers cookie | Yes (cookie wins) | Yes (`ensureServiceCaller`) |
| Catalog / CRUD / export | Yes | Partial (`api.ts`); needs origin-safe mutations and service-mode UX |
| Snapshot + ticket mint | Yes, both prefixes | Yes (`room-access.ts`) |
| Pending device bind | Yes | Key exists; bind-on-paint not wired |
| QR pairing + finalize | Yes | No product UI |
| Silent device redeem | Yes | No product UI |
| Logout / device revoke + CSRF | Yes | No product UI |
| Shares / link grants | Yes | Local staging only |
| Room bytes / multi-peer | Yes (native ESBT) | Blocked on Wasm `CollabSession` |
| Comments / history service | No | Local adapters only |
| EVT | Flagged | Do not prioritize |

## 11. How to evolve this contract

- Additive JSON fields the UI may ignore are allowed without a protocol bump.
- New required request fields, renamed paths, or a new caller kind need a
  change here plus `AUTHN-AUTHZ-PROTOCOL.md` when security-relevant.
- `deny_unknown_fields` auth bodies are closed: new keys are a coordinated
  client/server change.
- Presentation-only UI work does not need a server PR. If it touches
  `client/src/auth`, `client/src/lib/api.ts`, or `client/src/data/`, it must
  stay inside this contract.

The identity composition the server already follows is
`crates/marks-auth/tests/identity_wiring.rs`. The browser should not invent a
second path.
