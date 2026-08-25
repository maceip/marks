# Marks UI ↔ `marks-server` contract

**Status:** implementer contract for the browser against the live Rust server
**Owner:** Marks
**Last updated:** 2026-08-23
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
| [`PRESENCE.md`](PRESENCE.md) | Presence states, identity aggregation, transient frames, preview following, privacy, and rollout |

Do not re-litigate ESBT encoding here. Durable room replica bytes use the
canonical Rust-core `ESBT` envelope and its six artifact kinds. The browser
uses the same Rust source through the generated WIT component binding; no
transcoding package or raw ABI fallback exists.

## 2. Two product modes

`VITE_MARKS_DATA_MODE` is `local` unless set to `service` at build time
(`client/src/lib/product.ts`).

| Mode | UI may do | UI must not do |
| --- | --- | --- |
| `local` | Own catalog, CRDT journal, images, comments, and named versions in IndexedDB; stage sharing UI | Claim invitations were sent, rooms exist, or a principal is signed in |
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

“Temporary” describes the caller capability, not the page: anonymous pages
are public editors by opaque slug and become explicitly persisted after their
seventh anonymous edit.

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
| Catalog, create, rename, duplicate, trash/restore, export, assets | `/v1/documents…` with cookie only | `/v1/documents…` with `MarksScratch` |
| Snapshot | `GET /v1/documents/{id}/snapshot` | `GET /v1/scratch/documents/{id}/snapshot` |
| Room ticket | `POST /v1/documents/{id}/session` | `POST /v1/scratch/documents/{id}/session` |
| Shares and link grants | `/v1/documents/{id}/shares` and `/link` | The opaque document slug is already public-editor access. Scratch cannot manage named ACLs or narrower bearer grants. |
| Comments and named versions | `/v1/documents/{id}/comments` and `/versions` | Forbidden. Review metadata is principal-owned. |
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
| `503` | A bounded server subsystem is at capacity. Preserve local work and retry with backoff |

Raw paths, status text, and protocol jargon do not belong in user-facing copy
([`UI-SURFACE.md`](UI-SURFACE.md)).

## 4. Client modules

Keep new service-mode work inside these files. Do not grow a second API layer
under `components/`.

| Module | Job | State |
| --- | --- | --- |
| `client/src/auth/caller.ts` | Resolve session-vs-scratch; apply headers | Done for first paint |
| `client/src/auth/scratch.ts` | Tab-scoped `sessionStorage` credential | Done |
| `client/src/auth/device-key.ts` | Non-extractable P-256 key in IndexedDB | Bound during service first paint |
| `client/src/auth/protocol.ts` | Canonical grant / bootstrap / proof bytes | Done; must stay byte-identical to Rust |
| `client/src/auth/room-access.ts` | Snapshot + ticket mint + room URL checks | Done for both prefixes |
| `client/src/lib/api.ts` | Documents, trash, assets, sharing, review HTTP | Wired service adapter; components do not call `fetch` directly |
| `client/src/lib/service-api.ts` | Shared lazy boundary for the remote metadata graph | Local startup does not eagerly parse service request code |
| `client/src/data/documents.ts` | `DocumentRepository` local vs service | Service path uses `api.ts` |
| `client/src/data/review.ts` | Durable local/service comments and named versions | Local rows and quota metadata are transactional IndexedDB records; anchors stay ESBT bytes |
| `client/src/data/assets.ts` | Local content-addressed image store or service upload | PNG/JPEG/GIF/WebP only; document quotas match the service defaults |
| `client/src/hooks/useSession.ts` | Opens `CollabSession` only with a provider | Service requires `documentAccess` |
| `client/src/collab/` | `CollabSession` + WIT component `EsbtEngine` + journal | Local and service rooms speak canonical `ESBT` artifacts |

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
  "csrf": "<b64url>",
  "deviceBound": false
}
```

- Response `401`: no live session. Fall through to scratch.
- `deviceBound` reports a browser-managed DBSC hardware binding. Session
  cookies carry an explicit `Max-Age` (180-day default TTL, refreshed on
  rotation); the browser keeps them across restarts.

Cache `csrf` in memory for logout / device revoke. Do not persist it.

#### DBSC endpoints are browser-managed — the UI must not call them

`POST /v1/auth/dbsc/register` and `POST /v1/auth/dbsc/refresh` exist for the
browser's own Device Bound Session Credentials machinery, triggered by the
`Secure-Session-Registration` response header on login. Page JavaScript never
fetches them, never reads `__Host-marks_bound`, and never breaks when a
browser lacks DBSC: absence of the binding changes nothing. The UI's only
job is honest chrome — surface `deviceBound` where sessions are listed.

#### Storage durability the UI does owe

Call `requestDurableStorage()` (`client/src/auth/durable-storage.ts`) when a
device becomes durable — self-bootstrap, bootstrap, finalize, silent redeem
already do — and surface `storagePersisted()` in the Account sheet. Never
block authentication on the grant.

#### `DELETE /v1/auth/session`

- Authority: session + exact origin + `X-Marks-CSRF`
- Response `200`: `{ "revoked": true }` and a cleared cookie
- After this, probe session again and mint scratch if the tab stays open

### 6.2 Pending device and promotion

The login line the UI already owns:

> This page is already saved and public. Log in with your phone to keep owner
> access and use your account on other devices.

#### `PUT /v1/auth/scratch/{scratchId}/device`

- Authority: scratch, and `{scratchId}` must match the header
- Body: `{ "deviceId": "device_…", "publicKey": "<b64url SEC1>" }`
- Response `204`
- Bind once per tab after the key exists. Generating the key does not promote
  the workspace.

#### `POST /v1/auth/scratch/{scratchId}/bootstrap`

- Single-device keep: the visitor's only device promotes its own workspace.
  There is no pairing, nothing to scan, and no finalize step.
- Authority: scratch, and `{scratchId}` must match the header; the pending
  device must already be bound
- Body: `{ "bootstrap": { version, controllerId, scratchId, deviceId, devicePublicKeyHash, issuedAtMs, expiresAtMs }, "signature" }`
- `bootstrap` bytes are `encodeSelfBootstrap` / `marks-self-bootstrap-v1`,
  signed by the pending device key; the statement may live at most two minutes
- Response `201` plus `Set-Cookie` for **this** tab's session, and the session
  JSON from §6.1. The pending key is now a controller: this device approves
  future pairings.
- After `201`, clear scratch storage and treat the tab as a session caller
- A `409` means another promotion won. Do not retry into a second account.

#### `POST /v1/auth/pairings`

- Authority: scratch; pending device must already be bound
- Response `201`:

```json
{
  "pairingId": "pairing_…",
  "secret": "<b64url 32>",
  "words": "correct horse battery staple",
  "expiresAtMs": 0,
  "url": "https://origin/link#v1.<pairingId>.<secret>"
}
```

Put only `url` (or the `#v1.…` fragment) in the QR. Show `words` for
camera-less clients. The secret is the capability. Two-minute default TTL.

#### `POST /v1/auth/pairings/lookup`

- Authority: body `{ "words": "four bip39 words" }`, no session
- Rate limited per IP
- Response `200`: the inspect JSON below, including `pairingId` and `scratchId`
- Guessed or malformed words are `401`

#### `POST /v1/auth/pairings/{id}/inspect`

- Authority: body `{ "secret": "<b64url 32>" }` or `{ "words": "four bip39 words" }`, no session
- Response `200`: `{ "origin", "pairingId", "scratchId", "pendingDeviceId", "pendingDevicePublicKeyHash", "expiresAtMs" }`
- Phone confirmation only. A guessed id without the secret or words is `401`.
- `scratchId` is required so the phone can sign bootstrap/grant bytes. It is
  not a capability.

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
  "sessions": [{ "sessionId", "deviceId", "createdAtMs", "expiresAtMs", "revokedAtMs", "deviceBound" }]
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
  "slug": "document_…",
  "title": "Untitled",
  "engine": "esbt",
  "chars": 0,
  "public": true,
  "public_role": "editor",
  "anonymous_edits": 7,
  "persisted": true,
  "persisted_at": 0,
  "created_at": 0,
  "updated_at": 0,
  "deleted_at": null,
  "purge_at": null
}
```

Refuse any `engine` other than `esbt` (`documentIsOpenable`).

| Method | Path | Authority | Origin | Body | Success |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/v1/documents` | session or scratch | no | — | `{ "documents": [DocumentMeta] }` |
| `POST` | `/v1/documents` | session or scratch | session only | `{ "title"?, "markdown"? }` | `201 { "document" }` |
| `GET` | `/v1/documents/{id}` | session or scratch | no | — | `{ "document", "connections" }` |
| `PATCH` | `/v1/documents/{id}` | owner / scratch-owner | session only | `{ "title" }` | `{ "document" }` |
| `DELETE` | `/v1/documents/{id}` | owner / scratch-owner | session only | — | `{ "deleted": true }` tombstone |
| `POST` | `/v1/documents/{id}/duplicate` | readable | session only | `{}` | `201 { "document" }` |
| `GET` | `/v1/documents/{id}/export` | readable | no | — | `text/markdown` attachment |
| `GET` | `/v1/documents/{id}/export-bundle` | readable | no | — | streamed portable ZIP |
| `GET` | `/v1/trash` | owner / scratch-owner | no | — | `{ "documents", "retentionMs" }` |
| `POST` | `/v1/documents/{id}/restore` | owner / scratch-owner | session only | `{}` | `{ "document" }` |
| `DELETE` | `/v1/documents/{id}/purge` | owner / scratch-owner | session only | — | `{ "purged": true }` after retention |

`chars` is a UTF-16 code-unit count. Titles are 1–512 characters after trim.
Creation validates and publishes optional Markdown and its initial snapshot in
one transaction; templates/imports must not create a visible blank row and
fill it in with a second request.

Every scratch-created document is assigned a collision-resistant opaque slug,
stored by the service immediately, and marked `public: true` with the fixed
public role `editor`. Opening `/d/{slug}` in another browser creates or reuses
that browser's caller, mints a one-use ticket, and joins the same room without a
sharing-settings step. The slug is intentionally a public collaboration
capability: anyone who receives it may read and edit, but cannot rename, delete,
manage ACLs, or grant owner.

The room increments `anonymous_edits` only for committed public scratch text
mutations, not presence or receipt traffic. When the committed count becomes
seven, the same transaction sets `persisted_at` once. Losing or expiring the
creating scratch capability therefore loses owner authority, not the public
page or its committed Markdown. `persisted_at` is a retention milestone, while
the room journal remains durable from the first accepted mutation.

Delete is owner-only trash, not immediate reclamation. It closes the live
room, revokes tickets, and hides the document from collaborators. Only the
recovery owner sees `/v1/trash`; `purge_at` is 30 days after `deleted_at`.
Purge removes review metadata and asset references atomically, then reclaims
content-addressed bytes that no other document references.

### 6.6 Assets and portable export

| Method | Path | Authority | Origin | Request / response |
| --- | --- | --- | --- | --- |
| `POST` | `/v1/documents/{id}/assets` | text editor | session only | Raw image body + `X-Marks-Filename`; `201 { "asset": { id, url, filename, mediaType, bytes } }` |
| `GET` | `/a/{documentId}/{assetId}` | document-scoped capability URL | no | Streamed image bytes while the document is live |
| `GET` | `/v1/documents/{id}/export-bundle` | readable | no | `document.md`, `manifest.json`, and only referenced assets |

Uploads ignore a claimed MIME type and sniff PNG, JPEG, GIF, or WebP bytes;
SVG is deliberately refused. Defaults are 10 MiB per image, 128 MiB and 1,000
images per document, with hash deduplication. Asset IDs are scoped read
capabilities embedded in Markdown, not global public blob URLs. Trashing the
document revokes them.

The service bundle rewrites known `/a/…` links in one pass, verifies every
content hash before sending headers, and streams through a bounded channel;
`MARKS_MAX_BUNDLE_EXPORTS` bounds concurrent compression/I/O. Local mode emits
the same version-1 portable manifest from IndexedDB.

#### Document and URL import

| Method | Path | Authority | Origin | Request / response |
| --- | --- | --- | --- | --- |
| `POST` | `/v1/import/file` | session or scratch | session only | Raw body + `X-Marks-Filename`; Markdown, PDF, DOC, DOCX, XLS, or XLSX → `{ "title", "markdown" }` |
| `POST` | `/v1/import/url` | session or scratch | session only | `{ "url": "https://…" }` → `{ "title", "markdown", "sourceUrl" }` |

File imports are capped at 12 MiB, matching the public edge. OOXML archives
also have entry-count and expanded-byte limits. PDF import extracts embedded
text (no OCR). Word import keeps document structure as Markdown. Excel import
emits bounded pipe tables from displayed/cached cell values only; formulas,
formula source, scripts, macros, charts, and drawings are not imported.

The web UI intercepts PDF picker and drop imports before this route. It reads
the bytes locally and runs the MIT-licensed `@firecrawl/anydoc-wasm` converter
in a disposable module worker, so PDF bytes are not uploaded. The browser path
shares the 12 MiB limit and has a hard 35-second deadline; timing out terminates
the worker, including a synchronous Wasm conversion. The native route remains
available to non-browser API clients and as a separately bounded service
capability. Neither path performs OCR.

Both routes authenticate, rate-limit, and reserve bounded capacity before body
upload or outbound work. Capacity exhaustion is rejected immediately. One
30-second deadline covers upload, DNS, cumulative redirects, body streaming,
and conversion; PDF, Office, and HTML conversion run in a killable, reaped
worker process with a bounded response channel.

URL import accepts only public HTTP(S) destinations, revalidates and repins DNS
on every redirect, refuses loopback/private/link-local destinations, caps both
redirects and response bytes, and converts static HTML to Markdown after
dropping active/embedded content. It does not run page JavaScript.

### 6.7 Snapshot and room ticket

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

The creating scratch owner receives `role: null`; a different scratch caller
opening a public slug receives `role: "editor"`. Persist `siteId` per document
so reconnects reuse the replica site. Two devices never share a site.

Mint a fresh ticket immediately before every WebSocket open, including
reconnect. Tickets last 30 seconds and are one-use.

### 6.8 Sharing (session owner only)

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
callers cannot manage ACLs or bearer-link roles; their plain opaque document
slug already grants the fixed public editor role.

### 6.9 Comments and named versions (session principals)

Review is a bounded transactional metadata plane. Comments never become text
operations; versions store deduplicated, zstd-compressed canonical Markdown,
not engine snapshots.

| Method | Path | Authority | Body / success |
| --- | --- | --- | --- |
| `GET` | `/v1/documents/{id}/comments?cursor=<opaque>` | readable | At most 25 newest threads; returns `{ comments, hasMore, nextCursor, repliesTruncated }` |
| `POST` | `/v1/documents/{id}/comments` | commenter | Create body `{ body, startAnchor?, endAnchor?, quote?, startOffset?, endOffset? }`; returns `201 { comment }` |
| `PUT` / `DELETE` | `/v1/documents/{id}/comments/{comment}` | commenter; author for body/delete | `{ body?, resolved? }` → `{ updated }`, or `{ deleted }` |
| `POST` | `/v1/documents/{id}/comments/{comment}/replies` | commenter | `{ body }` → `201 { reply }` |
| `PUT` / `DELETE` | `/v1/documents/{id}/comments/{comment}/replies/{reply}` | reply author | `{ body }` → `{ updated }`, or `{ deleted }` |
| `GET` / `POST` | `/v1/documents/{id}/versions` | readable / text editor | Create `{ label }` only after pending edits are durable |
| `GET` / `DELETE` | `/v1/documents/{id}/versions/{version}` | readable / text editor | `{ version, markdown }`, or `{ deleted }` |

Paired `startAnchor` / `endAnchor` values are base64url canonical ESBT anchors;
the offsets and quote are display/recovery hints. The browser resolves anchors
against the current replica, so a concurrent insertion does not detach a
thread from its text. Deletes are tombstones to preserve thread shape.

There are at most 10,000 comments per document, 200 replies per comment, 100
named versions, and 64 MiB of compressed version content. Creating a service
version first waits for `CollabSession.whenDurable()`; the server then reads
committed room state. Restoring is an ordinary new CRDT replacement followed
by the same durable-commit barrier, so history is never rewritten.

Comment pagination is stable keyset pagination by `(createdAt, id)`, not an
offset over a moving list. The client appends and de-duplicates pages through
`nextCursor`. Because one page contains at most 25 threads and each thread at
most 200 replies, the bounded 5,000-reply join covers the whole page;
`repliesTruncated: true` is a contract violation, not silent data loss.

Local mode uses the same 25-thread keyset interface over compound IndexedDB
indexes. Comments, replies, version bodies, and per-document version-byte
accounting are transactional; legacy synchronous `localStorage` records are
migrated once. Local purge deletes review records before the catalog tombstone
is reclaimed, and local limits mirror 10,000 threads, 200 replies, 100 versions,
and a conservative 64 MiB uncompressed version budget.

### 6.10 EVT (experimental)

`POST /v1/auth/evt/challenges` and `POST /v1/auth/evt/redeem` exist behind
`MARKS_EVT_ENABLED`. When the flag is off they are `404`. Do not build a
primary account-creation UI on EVT. Phone pairing is the v1 upgrade rail.
If this UI is added later, follow [`AUTHN-AUTHZ-PROTOCOL.md`](AUTHN-AUTHZ-PROTOCOL.md)
§6 and keep raw email out of storage, logs, and toasts.

### 6.11 Operations and artifact identity

- `GET /healthz` proves a cheap process/database read.
- `GET /readyz` requires a recent process-owned `synchronous=FULL` SQLite
  heartbeat; probe traffic cannot manufacture readiness.
- `GET /v1/artifact` binds build revision, native ESBT revision, Wasm ESBT
  revision/hash, ABI/profile hashes, deployed-static verification, coherence,
  and release readiness. Startup refuses when the deployed manifest differs
  from the build-bound manifest or the deployed Wasm digest differs from it.

These are deployment/proof interfaces, not product UI. Release CI requires
`engineCoherent: true`, `profileCoherent: true`, and
`staticArtifactVerified: true`; strict release mode additionally requires
`releaseReady: true`.

## 7. Room interface

```text
GET /collab/esbt/{documentId}?vv=<optional base64url version>
```

Retired paths ` /collab/loro/{id}` and `/collab/yjs/{id}` are refused. Do not
call them.

Upgrade rules, already enforced in `room-access.ts`:

1. Offer `marks.esbt.v2` and `marks.ticket.v1.<ticketId>.<ticketSecret>`.
2. The server echoes **only** `marks.esbt.v2`. Never put the ticket in a URL,
   query, or header log.
3. `roomUrl` must stay on the page origin, `ws:`/`wss:` matching `http:`/`https:`,
   path prefix `/collab/`, no userinfo, hash, or query on the minted URL.
   Reconnect may add `?vv=` only.
4. Principal sockets also send the session cookie on the upgrade.
5. After claim, epoch change, logout, or revoke, the server closes the socket.
   The UI reconnects with a new ticket under the current caller.

Every binary frame is one tag byte followed by this payload:

| Tag | Direction | Payload |
| ---: | --- | --- |
| `0x01` | server → client | canonical ESBT update |
| `0x02` | both | bounded, lossy presence bytes; V1 is delivered and V2 is planned per [`PRESENCE.md`](PRESENCE.md) |
| `0x03` | server → client | canonical server version |
| `0x04` | server → client | canonical compact/full snapshot |
| `0x05` | server → client | empty initial-sync boundary |
| `0x06` | client → server | `MKMT` format byte 1, stable mutation ID, kind, and canonical artifact |
| `0x07` | server → origin client | `MKCM` format byte 1, mutation ID, durable revision, and committed Version artifact |

Clients never send bare `0x01`/`0x04` under v2. Viewer and commenter sockets
may not send `0x06`. A mutation remains `saving` until its exact `0x07` receipt
has been reflected atomically into IndexedDB. Retrying an ID with the same
digest returns its original receipt; reusing it for different bytes is a
protocol violation. Comments are not ESBT bytes.

The room currently delivers per-site presence and ESBT causal-position
selection rendering. It does **not** yet deliver authenticated participant
aggregation, server bootstrap/removal, activity states, deterministic room
colors, or preview-follow modes in [`PRESENCE.md`](PRESENCE.md). Loss or
rejection of presence is the defined degraded path: keep editing and durable
sync working, and hide stale decorations rather than inventing identity or
positions.

**Service-mode text sync uses the Rust/WIT-component `CollabSession`.** The room
and browser speak the same unified `ESBT` artifact codec. Do not add a
TypeScript transcoder. Catalog, identity, admission, snapshot fetch, and room
bytes all go through that one binding.

## 8. Product behavior invariants

The data/auth/collaboration modules implement these paths. Desktop, phone,
fold, and ribbon presentations may change without duplicating their logic.

1. **First paint (service):** run `ensureServiceCaller` before catalog or
   editor work. There is no registration form.
2. **Honest scratch:** every service-mode anonymous page has its own public
   slug and is saved immediately. Closing an unpromoted tab can lose owner
   authority, but it does not erase the page; after seven committed public
   edits the server records the anonymous persistence milestone.
3. **Upgrade:** bind the pending device, create a QR/four-word pairing, finish
   promotion, clear scratch state, and reconnect under the session caller.
4. **Mobile login:** on phone posture, lead with opening the same public page
   on a laptop and using the phone-link login flow. Put `selfBootstrap` behind
   a secondary disclosure labelled as phone-only login. On larger postures the
   QR leads and single-device login stays the quiet fallback. Say plainly that
   one device means one key and never silently merges with an account elsewhere.
5. **Return visit:** probe the cookie, attempt silent device redeem, and only
   then mint scratch.
6. **Sharing:** a scratch-created service page is public-editor by slug with no
   settings change. Named ACLs and narrower bearer roles remain owner/session
   operations in §6.8; local mode is explicit staging.
7. **Reconnect/durability:** mint a new ticket, reuse the journaled `siteId`,
   send the stable pending mutation IDs, and keep “saving” visible until their
   commit receipts are checkpointed.
8. **Offline:** retain cached document metadata and the Wasm/IndexedDB journal
   on transport errors. Only an authoritative service `404` means absence.
9. **Review:** role capabilities control comment/version actions. Creating and
   restoring a version crosses `whenDurable()`; it never edits history in
   place.
10. **Import/assets/export:** Import is the first ribbon tab on every posture.
    Its templates are Notes app, Meeting, and GitHub README; file/drop import
    converts Markdown, PDF, Word, and table-only Excel; protected URL import
    converts static public HTML. Every import becomes one populated create.
    Paste, drop, and picker images use stable editor ranges; portable export
    includes only referenced known assets.
11. **Errors:** map §3.4 to product copy; never dump record-sensitive protocol
    detail, credentials, or raw service bodies into a toast.

## 9. What the UI must not invent

- A `MarksSession` Authorization scheme
- Treating leftover scratch as stronger than a live session
- A second React app, Node document store, or `/api` alias
- A TypeScript ESBT transcoding bridge or dual-engine room
- Passwords, passkeys, magic links, OAuth, or durable short recovery codes
- Displaying scratch, device, or site IDs as people
- Sending comments as opaque text updates
- Logging tickets, scratch capabilities, pairing secrets, or CSRF tokens
- Calling `/v1/scratch/documents` for list/create (those routes do not exist)

## 10. Implementation map

This is the current source wiring. Runtime proof remains the browser/server
matrix in [`TEST-HARNESS.md`](TEST-HARNESS.md), not this table.

| Capability | Server | Browser |
| --- | --- | --- |
| Scratch mint + storage | Yes | Yes (`scratch.ts`, `caller.ts`) |
| Session probe prefers cookie | Yes (cookie wins) | Yes (`ensureServiceCaller`) |
| Catalog / atomic create / duplicate / export | Yes | Yes (`api.ts`, `documents.ts`) |
| Public anonymous slug + seventh-edit persistence | Yes | Yes (automatic `/` create, direct `/d/{slug}` room admission) |
| PDF / Word / table-only Excel / URL import | Yes (`routes/imports.rs`) | Yes (Import ribbon, picker, URL dialog, document drop) |
| Trash / restore / retained purge | Yes | Yes, local and service repositories |
| Snapshot + ticket mint | Yes, both prefixes | Yes (`room-access.ts`) |
| Pending device bind | Yes | Yes (`pending-device.ts`, first paint in service mode) |
| QR pairing + finalize | Yes | Yes (`identity.ts`, Log In); local mode does not mint |
| Single-device login (phone-only fallback) | Yes (`/scratch/{id}/bootstrap`) | Yes (`selfBootstrap`, disclosed below the laptop-first phone prompt) |
| DBSC hardware session binding | Yes (register/refresh, quiet fallback) | Browser-managed; UI surfaces `deviceBound` only |
| Durable storage request | n/a | Yes (`durable-storage.ts` on promotion + redeem) |
| Four-word pairing | Yes (`/lookup`) | Yes (Keep + `/link`) |
| Silent device redeem | Yes | Yes (`device-session.ts` before scratch mint) |
| Logout / device revoke + CSRF | Yes | Yes (Account / Sign out in service mode) |
| Shares / link grants | Yes | Yes in service; honest staging in local mode |
| Room bytes / multi-peer | Yes (native ESBT) | Yes (Wasm `EsbtEngine` + journal) |
| Retry receipts / truthful saving | Yes (`MKCM`) | Yes, atomic IndexedDB acknowledgement |
| Anchored comments / replies | Yes | Yes, local and service adapters |
| Named versions / durable restore | Yes | Yes, local and service adapters |
| Images / quotas / portable bundle | Yes | Yes, local and service adapters |
| Offline cold-open / reconnect | Journal-compatible | Chromium + Firefox cold boot; WebKit mounted-replica isolation path |
| Artifact provenance | Native/Wasm coherence endpoint | Dev gate green; strict release gate requires clean coordinated revisions |
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
