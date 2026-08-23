# Marks authentication and authorization protocol

**Status:** normative Marks protocol; validators in `crates/marks-auth`, HTTP/database/room integration in `crates/marks-server`; real-browser runtime gates still open
**Owner:** Marks
**Protocol version:** `marks-auth-v1`
**Last updated:** 2026-08-23

This document defines the authentication and authorization implementation
owned by Marks. [`V1-SCOPE.md`](V1-SCOPE.md) remains the overall editor/server
release boundary. The document room consumes only a validated principal,
session, role, document/site binding, and revocation signal through a narrow
internal seam. Provider, controller, device-enrollment, recovery, and
verified-email code remain inside Marks; none of them enter the ESBT sequence
algorithm or its wire formats. Engine and durability work may proceed in
parallel, but the authorized release gate requires this protocol end to end.

The implementation boundary is:

```text
Marks browser                    Rust marks-server                 ESBT
--------------                   -----------------                 ----
scratch capability       ----->  authenticate request
phone/controller proof   ----->  resolve principal
device key proof         ----->  issue/rotate session
session cookie           ----->  evaluate document ACL
site ID                   ----->  mint one-use room ticket
room ticket + authority   ----->  bind immutable RoomActor   ----> bytes only
                                                               site ID + ops
```

The ESBT crate may receive a collision-resistant `siteId`, validate and apply
encoded operations, produce snapshots and deltas, and expose stable anchors.
It must never parse a session, know an email, resolve a controller, assign a
role, or decide whether a socket may write.

## 1. Product decision

First paint has no registration form and no authentication ceremony. A new tab
starts as a temporary scratch workspace. Its durable-upgrade message is:

> This workspace is temporary. Scan with your phone to keep it and use it on
> other devices.

The three v1 promotion rails are:

1. **Phone controller:** scan a high-entropy QR link. The phone becomes, or uses,
   a controller for a durable random Marks principal. Each linked browser keeps
   its own silent device key.
2. **Single-device keep:** when the visitor's only device is the one holding
   the scratch workspace — a phone at the landing page with no laptop in
   reach, or a laptop with no phone — there is nothing to scan and nothing to
   link to. The pending device key already bound to that scratch signs its own
   promotion and becomes the first controller. The pairing UI stays one tap
   away for people who do have a second device.
3. **Verified email token:** on supported Chrome deployments, redeem fresh,
   key-bound Email Verification Token evidence. The raw verified email is
   immediately reduced to a server-keyed locator. This rail is experimental and
   feature-flagged.

All rails promote the same scratch workspace into the same principal model.
They are not separate account types. A user may attach several to one
principal after authenticating; Marks never automatically merges two existing
principals.

Normal return visits use a rotating HTTP-only session cookie. If that cookie is
gone but an enrolled browser key remains, the browser silently signs a one-use
Marks challenge and receives a new session. There is no WebAuthn/passkey
ceremony and no user-presence requirement on ordinary login.

## 2. Invariants

The server must preserve all of these invariants:

- A scratch capability is temporary authority over one scratch workspace. It
  is not a `principalId` and is never displayed as a person.
- A durable principal is a server-generated random identifier. A controller,
  device key, email address, provider account, IP address, or ESBT site is never
  the principal identifier.
- `principalId`, `controllerId`, `deviceId`, `sessionId`, `siteId`, and
  `presenceKey` are distinct namespaces and lifetimes.
- Every device has its own key and `deviceId`. Two devices owned by one person
  never share an ESBT `siteId`.
- The phone controller can enroll or revoke devices. An ordinary linked device
  can authenticate itself but cannot enroll another device.
- Every bearer capability is 256 random bits. Only a domain-separated digest is
  stored. The only short-word path is the live pairing accessibility code
  below; it is not a password, recovery phrase, or durable credential.
- Every signature covers a versioned domain string and a canonical binary
  encoding. JSON is never signed.
- Pairings, device challenges, EVT challenges, and document tickets expire and
  are consumed atomically. A successful pure validation followed by a separate
  unguarded update is not sufficient.
- Session cookies are checked before any durable principal operation. An
  enrolled device key may mint a new session only through a fresh, one-use,
  origin-bound challenge.
- A document room receives an immutable `RoomActor` only after the Marks server
  has validated either live scratch authority or a durable session/current ACL,
  plus the matching one-use document ticket.
- Owner/editor sockets may submit ESBT updates. Commenter/viewer sockets may
  not. Comments use a separate metadata operation and never ride inside an
  opaque ESBT update.
- Revocation and role downgrade affect open sockets; admission-time checking
  alone is not authorization.
- Unknown or deleted document IDs never create rooms.

## 3. Identity state machine

```text
new tab
  |
  v
SCRATCH
  |  temporary capability; private scratch documents only
  |
  +-- phone scans QR --------------------+
  |                                      |
  |     phone has controller             | first Marks use on phone
  |     sign device grant                | create controller + self-proof
  |                                      |
  +-- only device keeps itself ----------+
  |                                      |
  |     pending key signs                |
  |     marks-self-bootstrap-v1          |
  |                                      |
  +-------------------+------------------+
                      |
                      v
                 DURABLE PRINCIPAL
                      ^
                      |
  +-- Chrome EVT -----+
      verify issuer, nonce, audience, key binding
      HMAC(issuer, canonical email) -> locator

DURABLE PRINCIPAL
  |
  +-- valid session cookie ------------------> SESSION
  |
  +-- enrolled device signs fresh challenge -> SESSION
  |
  +-- add/revoke controller, device, or EVT locator while authenticated
```

The transition from scratch to durable is monotonic. It runs once. If two
promotion requests race, one serializable transaction wins and the other gets a
generic conflict. The losing request must not create a second principal or
move the same scratch documents twice.

### Account collision rules

- A phone controller always selects its existing principal.
- A first-phone bootstrap creates a new random principal.
- A single-device self-bootstrap creates a new random principal. It never
  attaches to an account that lives elsewhere; linking to an existing
  principal is always a pairing approved by that principal's controller.
- An EVT locator already attached to a principal selects that principal.
- A previously unseen EVT locator creates a new random principal.
- A scratch already claimed by a different principal causes a conflict.
- Attaching a locator already owned by another principal never merges accounts.
  Account merging is a separate, explicit recovery design and is deferred.

## 4. Scratch workspace

### Creation

`POST /v1/auth/scratch` creates:

- `scratchId`: 128 or more random bits, base64url;
- `scratchCapability`: exactly 256 random bits, base64url on the wire;
- `expiresAt`: v1 default 24 hours;
- a private, unshared scratch document namespace.

The server stores only `H("marks-bearer-secret-v1", capability)`. The browser
stores the capability in `sessionStorage`, never `localStorage`, a URL, a
cookie, analytics, or crash telemetry. Scratch requests carry it in an
`Authorization: MarksScratch <scratchId>.<capability>` header.

Reloading the same tab may continue. A browser-restored tab may continue. Marks
does not promise recovery after the tab or its storage is lost. A duplicated
tab may inherit browser session storage; server idempotency and claim
serialization handle that race, but the UI must still describe the workspace
as temporary.

Scratch authority may create and edit its own private documents and export the
current local Markdown. It may not create shares, public links, invitations,
comments, durable history, or additional devices.

Scratch synchronization uses the same room transport without pretending the
capability is a person. An authenticated scratch request mints a 30-second,
one-use scratch document ticket bound to scratch ID, document ID, site ID, and
authorization epoch. Upgrade rechecks that the scratch is still live and
unclaimed, then binds `RoomActor::Scratch`. Claiming the workspace increments
the document epoch and closes its scratch sockets; the promoted browser
reconnects with a durable principal ticket.

### Pending device key

The browser generates an ECDSA P-256 key with Web Crypto in parallel with the
usable local editor:

- `extractable: false`;
- usages: `sign` for the private key and `verify` for the public key;
- SHA-256 for signatures;
- the private `CryptoKey` stored in IndexedDB;
- public key exported as the canonical 65-byte uncompressed SEC1 point;
- random `deviceId`, never derived from the key or scratch ID.

`PUT /v1/auth/scratch/{scratchId}/device` binds the pending device ID and public
key digest to the authenticated scratch record. Generating this key does not
make the scratch workspace durable and does not silently merge it with another
tab.

The key is a software origin credential. `extractable: false` prevents normal
export, but same-origin script can still ask it to sign. The browser security
boundary therefore includes a restrictive Content Security Policy, Trusted
Types, dependency pinning, no third-party script on authenticated pages, and
fast device/session revocation.

## 5. Phone-controller promotion

### Pairing creation and QR

`POST /v1/auth/pairings`, authenticated by the live scratch capability,
creates:

- a random `pairingId`;
- a new 256-bit `pairingSecret`;
- the exact scratch ID;
- the exact pending device ID and public-key digest;
- a two-minute expiry;
- an unconsumed state.

The QR payload is:

```text
https://<marks-origin>/link#v1.<pairingId>.<base64url-pairingSecret>
```

The secret is in the fragment so the initial navigation, reverse proxy,
referrer, and ordinary access log do not receive it. Link-page JavaScript reads
the fragment, immediately clears it with `history.replaceState`, and submits it
to Marks over HTTPS. “Copy secure link” carries the same high-entropy fragment
and is the only non-camera fallback in v1.

There is no PAKE in this flow. The 256-bit QR/link secret already has
sufficient entropy. Camera-less clients use a separate four-word
accessibility code minted with the pairing:

- four BIP39 English words, 44 bits of CSPRNG;
- stored only as `H("marks-pairing-words-v1", canonical words)`;
- the same two-minute pairing TTL;
- per-IP lookup rate limit;
- accepted on inspect, bootstrap, and approve in place of the fragment secret.

The words are not a password and do not survive the pairing window. Offline
guessing of a stolen hash is possible only while that pairing is live; that is
accepted because the pairing is already a short-lived capability. A guessed
phrase returns the same 401 as a guessed fragment. A later durable short-code
recovery path would still require a reviewed PAKE and a new protocol version.

The phone page shows the Marks origin, the pending device label, and whether it
is creating a new principal or linking to an existing one. Scanning or typing
the four words is the explicit promotion action; an existing controller should
still show a concise confirmation before granting a new device to reduce
QR-login phishing.

### First phone

If the phone has no controller, it generates a non-extractable P-256 controller
key and random controller/device IDs. It signs a
`marks-controller-bootstrap-v1` statement containing:

- protocol version;
- controller ID and controller-device ID;
- controller public-key digest;
- pairing ID and scratch ID;
- pending browser device ID and public-key digest;
- issue and expiry times.

The server validates the pairing secret, exact record bindings, time bounds,
public-key digest, P-256 key, and P1363 signature. It—not the client—then
generates the random `principalId`.

### Existing controller

An existing phone controller signs a `marks-device-grant-v1` statement
containing:

- protocol version;
- principal ID, controller ID, and controller key epoch;
- pairing ID and scratch ID;
- pending browser device ID and public-key digest;
- granted capability bits;
- issue and expiry times.

Only a live, non-revoked controller with `AUTHORIZE_DEVICES` may issue that
grant. Unknown capability bits fail decoding. The server verifies the signature
against the stored controller key and requires every signed field to match the
pending pairing exactly.

### Single-device bootstrap

A visitor whose only device holds the scratch workspace cannot scan its own
screen. The pending device key bound in §4 signs a
`marks-self-bootstrap-v1` statement containing:

- protocol version;
- a fresh random controller ID;
- the scratch ID;
- the pending device ID and public-key digest;
- issue and expiry times, at most two minutes apart (the window a QR pairing
  would have had).

The request is authenticated by the live scratch capability
(`POST /v1/auth/scratch/{scratchId}/bootstrap`). The server validates the
statement bindings against the stored pending-device row, the time bounds,
and the P1363 signature against the stored pending public key, then — inside
one serializable transaction — generates the random principal, promotes the
pending key as controller plus controller-capable device, moves the scratch
documents exactly as in the pairing transaction, sets `scratch.claimed_by`,
and issues that device's first rotating session directly. There is no pairing
row to consume and no finalize step; the `claimed_by IS NULL` scratch update
is the one-use anchor that serializes a race against a concurrent pairing
promotion or duplicate submission.

This rail grants no authority the pairing rail does not: a caller holding the
scratch capability and the pending private key could already mint a pairing
and consume it itself. It removes the second-device ceremony, not a check.
Two consequences are deliberate:

- The single key is the whole account. The UI must state plainly that losing
  the device and its origin storage before linking another device is
  unrecoverable, exactly like an unpromoted scratch tab.
- When a second device appears later, it links through the ordinary QR
  pairing: the second device mints the pairing from its own scratch, and this
  device — now a controller — signs the `marks-device-grant-v1` approval.

### Canonical signature encoding

Signed v1 messages use:

- the ASCII domain string terminated by `0x00`;
- one-byte version;
- unsigned integers in big-endian order;
- every text/byte field prefixed by an unsigned 32-bit big-endian byte length;
- P-256 ECDSA with SHA-256;
- a 64-byte IEEE P1363 `r || s` signature on the wire.

The Rust functions `ControllerBootstrap::signing_bytes`,
`SelfBootstrap::signing_bytes`, `DeviceGrant::signing_bytes`, and
`DeviceSessionProof::signing_bytes` are the authoritative encoders. Browser
golden fixtures must match them byte-for-byte.

### Atomic approval

First-phone approval runs one serializable transaction:

1. lock the pairing, scratch, and pending-device rows;
2. require pairing and scratch to be live and unconsumed/unclaimed;
3. repeat cryptographic validation inside the request handling path;
4. create a random principal;
5. promote the phone key as controller plus controller-capable device;
6. promote the pending browser key as an ordinary member device;
7. move all scratch documents to that principal and create owner ACL rows;
8. increment each moved document's authorization epoch and invalidate/close
   its scratch tickets and sockets;
9. set `scratch.claimed_by`, extend its finalize-only window by five minutes,
   and consume the pairing;
10. commit before returning or setting any session cookie.

Existing-controller approval uses the same transaction without creating a
principal or controller.

The desktop then calls `POST /v1/auth/pairings/{pairingId}/finalize` with its
original scratch capability. The server validates that the claimed scratch,
pairing, principal, and enrolled pending device still match, creates a rotating
session for that device, and sets the cookie. The original scratch capability
cannot claim another principal; after the finalize window it is deleted.

## 6. Email Verification Token promotion

EVT is an alternate promotion and recovery adapter, not the universal root.
The current Chrome work is an origin-trial feature and has changed during the
trial, so it remains behind `auth_evt_enabled`, an issuer allowlist, adapter
version allowlist, and server-side kill switch. Unsupported browsers simply see
the phone path. Marks does not send an email as a silent fallback.

The browser first calls `POST /v1/auth/evt/challenges` with scratch authority
and its pending device. The server creates a one-use challenge bound to:

- challenge ID;
- scratch ID;
- pending device ID and public-key digest;
- exact Marks HTTPS audience;
- a high-entropy nonce digest;
- a short expiry.

The feature-specific adapter must verify the issuer's DNS delegation and
metadata, SD-JWT signature and claims, key-bound presentation, exact audience,
fresh nonce, issuance time, and configured issuer policy. Only after those
checks may it construct `VerifiedEmailEvidence` for `marks-auth`.

The auth core derives:

```text
locator = HMAC-SHA-256(
  versioned_server_key,
  "marks-verified-email-locator-v1\0" ||
  len(https_issuer_origin) || https_issuer_origin ||
  len(issuer_canonical_email) || issuer_canonical_email
)
```

The locator key lives outside the database and is versioned for rotation. The
database stores only the locator, issuer policy/version, principal ID, and
timestamps. Raw email, token, presentation, and browser proof are excluded from
database rows, logs, tracing attributes, analytics, and crash reports.

This is data minimization, not anonymity from Marks: the server sees the email
while validating the evidence. Marks does not lowercase or otherwise invent
provider-specific email equivalence; the accepted issuer supplies the canonical
address. Issuer plus canonical address is the lookup key, so two issuers making
claims about the same spelling do not collide.

`POST /v1/auth/evt/redeem` consumes the challenge and nonce, resolves or creates
the principal, attaches the locator, promotes the exact pending device, claims
the scratch documents, inserts the first session, and commits in one
serializable transaction. A token replay, stale nonce, wrong origin, wrong
issuer, changed adapter version, or substituted device fails closed.

Current protocol context and deployment constraints are tracked by the
[Chrome origin-trial announcement](https://developer.chrome.com/blog/email-verification-protocol-origin-trial?hl=en),
[Chrome's August 2026 update](https://developer.chrome.com/blog/email-verification-august-2026),
and the [WICG explainer](https://github.com/WICG/email-verification). The adapter
must follow the exact enrolled Chrome/issuer version rather than treating this
document as a token-parser specification.

## 7. Sessions and silent device recovery

### Session cookie

The cookie wire form is:

```text
__Host-marks_session=<sessionId>.<base64url-256-bit-secret>
```

Attributes are `Secure; HttpOnly; SameSite=Lax; Path=/` with no `Domain`.
Production never accepts it over HTTP. The database stores the secret digest,
principal ID, device ID, creation/rotation/expiry times, and revocation time.

The server rotates the secret after login, privilege change, recovery, and a
bounded sliding interval. Rotation uses an overlap window only for in-flight
same-session requests and invalidates the old hash promptly. Logout revokes the
row. Disabling a principal or revoking a device revokes all descendant sessions
and closes their sockets.

State-changing cookie-authenticated HTTP requests require:

- an exact allowed `Origin` header;
- same-origin CORS policy;
- JSON content type;
- a session-bound `X-Marks-CSRF` value obtained from a readable same-origin
  session bootstrap response;
- normal authorization after CSRF validation.

### Silent recovery from an enrolled device

When the session cookie is absent but IndexedDB contains an enrolled key:

1. `POST /v1/auth/device/challenges` creates a random 256-bit challenge bound to
   device ID, exact Marks origin, key epoch, and a two-minute expiry.
2. The browser signs `marks-device-session-v1` canonical bytes containing the
   challenge ID, device ID, key epoch, origin, raw challenge, and issue/expiry
   times.
3. `POST /v1/auth/device/redeem` verifies the stored challenge digest, exact
   bindings, live device, P-256 signature, and time bounds.
4. One transaction consumes the challenge and inserts the rotating session.

No user gesture or WebAuthn API is involved. A challenge or signature replay
cannot mint a second session.

## 8. Authorization and document admission

### Role matrix

| Action | Owner | Editor | Commenter | Viewer |
| --- | ---: | ---: | ---: | ---: |
| Read document | yes | yes | yes | yes |
| Publish presence | yes | yes | yes | yes |
| Export | yes | yes | yes | yes |
| Submit ESBT text update | yes | yes | no | no |
| Create/reply/resolve comment | yes | yes | yes | no |
| Manage shares | yes | no | no | no |
| Delete/restore document | yes | no | no | no |

A `RoomActor::Scratch` may read, publish presence, export, edit, and delete only
documents whose current owner is that exact live scratch record. It may not
comment, share, or enter any principal ACL.

Unknown actions and roles fail closed. “Commenter” never means “let the client
send an opaque update and trust it not to change text.” Comment mutation is a
separate authenticated metadata endpoint/frame with its own schema.

### One-use document ticket

For a durable principal, the browser calls
`POST /v1/documents/{documentId}/session` with its normal session cookie and
current local `siteId`. The Rust server:

1. validates the session cookie and live device;
2. loads the non-deleted document and current ACL/link grant;
3. resolves one role;
4. creates a 256-bit one-use ticket with a 30-second expiry, bound to ticket ID,
   principal ID, session ID, device ID, document ID, site ID, and role;
5. returns the ticket ID/secret, role, and room URL.

The browser offers these WebSocket subprotocol values:

```text
marks.esbt.v1
marks.ticket.v1.<ticketId>.<base64url-ticketSecret>
```

The server selects and echoes only `marks.esbt.v1`; it never echoes the bearer
ticket. Ticket-bearing request headers are redacted in edge and application
logs. Version vectors may remain in the URL, but credentials may not.

During upgrade, the server validates the session cookie again, atomically
consumes the ticket, rechecks document existence and ACL/revocation state, and
constructs:

```text
Actor {
  principalId,
  sessionId,
  deviceId,
  documentId,
  siteId,
  role
}
```

For scratch documents,
`POST /v1/scratch/documents/{documentId}/session` performs the analogous check
with scratch capability authority and mints the scratch form of the ticket.
Both forms use the same redacted subprotocol transport.

The room stores `RoomActor::Principal(Actor)` or `RoomActor::Scratch` on the
socket. It never accepts actor fields from an ESBT frame. `MSG_UPDATE` dispatch
calls the Marks room policy before decoding or applying CRDT bytes. Rejected
writers cannot cause document creation, journal append, snapshot mutation,
broadcast, or a committed acknowledgement.

ACL revocation/downgrade increments the document authorization epoch and sends
an internal control event to its one live room owner. The room closes affected
sockets or replaces their actor role before processing another inbound frame.
Every durable mutation also checks the current epoch in its transaction so a
missed in-memory event cannot authorize a write.

## 9. Logical database schema

The production Rust server owns ordered migrations for these logical tables.
Exact SQL types follow the selected transactional database, but constraints and
uniqueness are protocol requirements.

```text
principals(
  id PK, created_at, disabled_at
)

scratch_workspaces(
  id PK, capability_hash BINARY(32), expires_at,
  claimed_by FK principals NULL, claimed_at NULL, finalize_expires_at NULL,
  revoked_at NULL
)

pending_devices(
  id PK, scratch_id FK UNIQUE, public_key_sec1, public_key_hash BINARY(32),
  created_at, expires_at
)

devices(
  id PK, principal_id FK, public_key_sec1, key_epoch,
  capability_bits, created_at, last_used_at, revoked_at,
  UNIQUE(principal_id, id)
)

controllers(
  id PK, principal_id FK, device_id FK,
  key_epoch, created_at, revoked_at,
  UNIQUE(principal_id, device_id)
)

sessions(
  id PK, principal_id FK, device_id FK, secret_hash BINARY(32),
  created_at, rotated_at, expires_at, revoked_at
)

pairings(
  id PK, scratch_id FK, pending_device_id FK,
  pending_device_public_key_hash BINARY(32), secret_hash BINARY(32),
  word_code_hash BINARY(32) NULL UNIQUE,
  expires_at, consumed_at, approved_principal_id FK NULL
)

auth_challenges(
  id PK, kind, device_id FK NULL, scratch_id FK NULL,
  nonce_hash BINARY(32), audience, bound_public_key_hash BINARY(32) NULL,
  adapter_version NULL, expires_at, consumed_at
)

verified_email_locators(
  locator_key_version, locator BINARY(32), principal_id FK,
  issuer_policy_version, created_at, revoked_at,
  PRIMARY KEY(locator_key_version, locator)
)

documents(
  id PK,
  scratch_id FK NULL,
  owner_principal_id FK NULL,
  auth_epoch,
  ...durable room metadata...,
  CHECK(exactly one of scratch_id and owner_principal_id is non-null)
)

document_acl(
  document_id FK, principal_id FK, role, granted_by FK,
  created_at, revoked_at,
  UNIQUE(document_id, principal_id)
)

document_tickets(
  id PK, secret_hash BINARY(32), authority_kind,
  scratch_id FK NULL,
  principal_id FK NULL, session_id FK NULL, device_id FK NULL,
  document_id FK, site_id, role NULL, auth_epoch,
  expires_at, consumed_at, revoked_at
  CHECK(exactly the fields for authority_kind are non-null)
)
```

Secrets, raw EVT evidence, raw emails, controller signatures, and full QR URLs
are not durable columns. Security event records may retain opaque IDs, outcome,
policy/adapter versions, coarse time, and rate-limit dimensions; they must not
reconstruct credentials.

## 10. HTTP surface

| Method and path | Authority | Purpose |
| --- | --- | --- |
| `POST /v1/auth/scratch` | none, rate limited | Create temporary workspace capability |
| `PUT /v1/auth/scratch/{id}/device` | scratch | Bind pending browser key |
| `POST /v1/auth/scratch/{id}/bootstrap` | scratch + pending-key self-proof | Promote the only device to first controller |
| `POST /v1/auth/pairings` | scratch | Create high-entropy QR pairing plus four-word code |
| `POST /v1/auth/pairings/lookup` | four-word code | Camera-less inspect of the live pairing |
| `POST /v1/auth/pairings/{id}/inspect` | pairing secret or words | Resolve safe phone confirmation details |
| `POST /v1/auth/pairings/{id}/bootstrap` | pairing secret + controller self-proof | Create first principal/controller |
| `POST /v1/auth/pairings/{id}/approve` | controller session + signed grant | Enroll into existing principal |
| `POST /v1/auth/pairings/{id}/finalize` | claimed scratch | Issue pending browser's first session |
| `POST /v1/auth/evt/challenges` | scratch | Bind EVT attempt to scratch/device/origin |
| `POST /v1/auth/evt/redeem` | fresh verified evidence + scratch | Promote or recover through locator |
| `POST /v1/auth/device/challenges` | device ID, rate limited | Create silent-login challenge |
| `POST /v1/auth/device/redeem` | signed device proof | Issue rotating session |
| `GET /v1/auth/session` | session | Return principal/device/recovery state and CSRF token |
| `DELETE /v1/auth/session` | session + CSRF | Revoke current session |
| `GET /v1/auth/devices` | session | List controllers/devices/sessions |
| `DELETE /v1/auth/devices/{id}` | controller + CSRF | Revoke device and descendant sessions |
| `POST /v1/scratch/documents/{id}/session` | scratch | Mint one-use scratch room ticket |
| `POST /v1/documents/{id}/session` | session + ACL | Mint one-use room ticket |

All endpoints have bounded JSON bodies, reject unknown security-relevant fields,
use uniform external auth failures, and apply per-IP plus per-capability/device
rate limits. Internal typed errors remain specific for tests and telemetry.

## 11. Threat model and non-claims

V1 defends against guessed document IDs, stolen database hashes, replayed
pairings/self-bootstrap statements/challenges/tickets, cross-document ticket
reuse, device substitution, forged or stale controller grants and
self-bootstrap signatures, viewer/commenter update injection, CSRF, accidental
credential logging, and revocation that only affects new sockets.

V1 does not claim to defeat:

- JavaScript compromise at the Marks origin;
- an unlocked, compromised controller phone;
- a malicious or compromised accepted EVT issuer;
- traffic correlation by Marks or its network providers;
- email-account reassignment by a provider;
- one person operating several controllers, emails, or provider accounts;
- a user intentionally sharing a QR/link secret while it is live.

Specifically, this protocol does **not** prove “one unique human.” Phone control
proves possession of a controller key. EVT proves a configured issuer made a
fresh email claim for this Marks audience. A future zkTLS or Privacy Pass rail
could grant abuse-resistance or qualification status, but it is not needed for
session continuity and is outside v1 authentication.

No v1 path uses passwords, passkeys, emailed magic links, OAuth access/refresh
tokens, durable recovery codes, or PAKE. The four-word pairing code is only a
live, hashed, rate-limited accessibility rail for the current pairing. Adding
a durable short-code path requires a new threat review and protocol version
rather than silently overloading these records.

## 12. Implementation mapping and gates

The implemented Rust crate is `crates/marks-auth`. It deliberately contains
pure, database-independent validators and typed authenticated results:

- bounded opaque IDs and known capability bits;
- scratch and claimed-scratch authority;
- first-controller bootstrap and existing-controller grants;
- single-device self-bootstrap by the scratch's own pending key;
- silent device-session challenges;
- session secret/device/principal validation;
- trusted EVT evidence binding and keyed locator derivation;
- one-use document ticket redemption into `Actor`;
- one-use scratch ticket redemption into a non-principal `ScratchActor`;
- the complete document role matrix.

The browser implementer contract — paths, JSON, cookies, and what the UI
still owes — is [`UI-SERVICE-CONTRACT.md`](UI-SERVICE-CONTRACT.md). The
implemented browser boundary is `client/src/auth`. It currently provides:

- non-extractable P-256 device keys and Rust-compatible canonical signatures;
- tab-scoped scratch capability storage and high-entropy pairing fragments;
- explicit session-versus-scratch authority on snapshot and room-admission
  requests;
- a fresh `POST .../session` ticket request before every initial WebSocket or
  reconnect;
- same-origin `ws`/`wss` room URL validation and 256-bit ticket validation;
- ticket transport only in `Sec-WebSocket-Protocol`, never in a URL; and
- no direct, unauthenticated WebSocket fallback.

The Rust server layer is `crates/marks-server`. It supplies randomness, HTTP
parsing, origin/CSRF checks, rate limiting, migrations, transactions, cookie
rotation, live-socket revocation, and durable document rooms without
duplicating or weakening the core validators. The Chrome EVT token parser
remains a narrow adapter seam behind its server flag; the server refuses
redemption when no trusted adapter is configured.

The identity gate is complete only when integration tests prove:

1. first paint and scratch edit require no form or browser auth prompt;
2. closing an unpromoted scratch tab is honestly presented as unrecoverable;
3. first-phone QR promotion preserves the scratch documents and creates one
   principal under duplicate/reordered requests;
4. a single-device self-bootstrap on the only device preserves the scratch
   documents, creates one principal, and the promoted key later approves a
   second device through an ordinary pairing;
5. a second device linked by the same phone opens the first device's files;
6. two unrelated scratch devices remain unrelated until explicit promotion;
7. copied pairing secrets, self-bootstrap statements, grants, challenges,
   signatures, EVT presentations, and room tickets fail after first use or
   expiry;
8. controller/device/session revocation prevents silent relogin and closes live
   sockets;
9. EVT absence or adapter failure falls back to phone without sending mail or
   creating a second principal;
10. raw email/token data is absent from database, logs, traces, and analytics;
11. viewer and commenter `MSG_UPDATE` attempts never reach ESBT decoding or the
    journal;
12. claiming scratch closes its scratch sockets and reconnects through the
    promoted principal without losing committed text;
13. role downgrade takes effect on an already-open socket;
14. ESBT snapshots and updates contain no Marks principal, session, email, role,
    controller, device, or ticket data.

Until those runtime gates pass against the Rust server and real browsers, the
crate and this document are an implemented protocol boundary—not an end-to-end
authentication claim.
