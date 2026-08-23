# Marks + ESBT completion plan

**Status:** implementation backlog; [`V1-SCOPE.md`](V1-SCOPE.md) owns v1 release commitments
**Last updated:** 2026-08-22
**Scope:** finish the ESBT integration without treating product metadata,
identity, or authorization as CRDT concerns.

This file preserves the detailed work split and sequencing. Items beyond the
boundary in `V1-SCOPE.md` are later backlog, not v1 commitments. There are no
released clients or production documents to migrate; v1 has one Rust core,
one durable `committed` acknowledgement, one process, and the Marks-owned
identity seam defined in `AUTHN-AUTHZ-PROTOCOL.md`.

The backlog was written around two repositories. The current ownership boundary
is narrower:

1. **Marks owns the product and identity internals:** durable documents,
   principals, controllers, devices, sessions, ACL enforcement, sharing,
   comments, history, storage, rooms, provider adapters, recovery, and
   user-facing proof.
2. **ESBT-web owns only the replication engine:** operation identity,
   allocation, convergence, import/export, version summaries, anchors, package
   releases, interoperability fixtures, and algorithm benchmarks.

Marks must not compensate for an engine correctness defect in its WebSocket
adapter. ESBT-web must not absorb accounts, roles, comments, or deployment
policy into weights or snapshots.

## Decisions already made

- The current comment feature is removed. It encoded comments as ordinary ESBT
  map operations, which made a commenter indistinguishable from an editor at
  the server's opaque `MSG_UPDATE` boundary.
- Existing snapshots may contain the old keyed-map payload. The decoder remains
  temporarily for compatibility, but Marks does not render or generate those
  records. They are inert legacy data until a migration can export or archive
  them safely.
- Comments return only after identity and ACL enforcement exist. They will live
  in the metadata plane and use a separate authorized API/message type.
- The first production topology remains one live room owner per document. We
  harden the single-node implementation before adding movable room ownership.
- The retired Node server has been deleted. The production backend is one Rust
  Marks process; no Node protocol or storage behavior is a compatibility
  target.
- The target scaling shape is a sticky/session room owner with object storage,
  not multiple unsynchronized processes sharing one local database.
- A new tab starts as a temporary scratch capability, not an account. Phone QR
  promotion creates or uses a phone controller and enrolls one silent Web
  Crypto key per browser device. A Chrome EVT adapter is an alternate
  feature-flagged promotion/recovery rail.
- Normal return visits use a rotating server session and, when needed, a silent
  enrolled-device challenge. WebAuthn/passkeys, short codes, PAKE, OAuth
  tokens, zkTLS, and Privacy Pass are not v1 login dependencies.

## Release gates

No milestone is complete because its code compiles. Each gate requires its
listed runtime evidence.

| Gate | Required evidence |
| --- | --- |
| Engine-safe | All replicas given the same operation set converge under per-operation reordering, duplication, delayed deletes, snapshots, and reconnects. |
| Durable single node | Delete, create, edit, restart, crash, reconnect, and cold-open tests pass against a real temporary database. A deleted document cannot be resurrected. |
| Authorized | Every REST and WebSocket mutation is bound to a principal and role. A viewer cannot edit; a commenter cannot submit document updates; revocation affects live sockets. |
| Metadata-safe | Comments and history survive restart without entering ESBT snapshots. Historical restore creates forward CRDT operations rather than importing old state. |
| Movable room | A room can flush, lose ownership, rehydrate elsewhere, and accept an offline client delta without forks or lost acknowledged edits. |
| Claim-safe | Product performance budgets and the paper-comparison benchmark are separate, reproducible, and publish their raw fixtures/results. |

# 1. What Marks needs to do

## M0 — Remove the premature comment integration

**Status:** completed in the working tree on 2026-08-22.

**Deliverables**

- Remove the comments drawer, toolbar/top-bar actions, keyboard shortcut,
  context-menu action, range decorations, browser helpers, session methods,
  styles, and smoke expectations.
- Stop reading, writing, or notifying on the legacy ESBT comments map.
- Keep old map payloads importable so removing the UI does not make existing
  documents unreadable.
- Mark comments as absent in README, browser-surface documentation, test
  documentation, and the integration contract.

**Exit gate**

- No product `Comment` surface remains in `client/src` or the browser smoke
  suites.
- Existing snapshots containing map data still import and their markdown text
  remains intact.
- Typecheck, unit suites, production build, and portable surface smoke pass.

## M1 — Consume one canonical ESBT package

Marks currently carries a source copy of the TypeScript engine. That makes a
correctness fix easy to land in one repository and forget in the other.

**Deliverables**

- Publish `ESBT-web/ts` as the sole versioned package source.
- Pin Marks to an immutable package version and lockfile integrity hash.
- Keep only Marks-specific adapters in `client/src/collab` and
  the future Rust room module.
- Add an upgrade test that imports a fixture written by the previous package
  version and re-exports it with the new version.
- Add a release note for every binary-format or behavior change.

**Exit gate**

- There is no hand-edited ESBT algorithm source in Marks.
- CI fails if Marks' contract tests do not pass against the pinned package.
- A clean container build installs the same engine artifact used by CI.

## M2 — Make the single-node server durable

The retired Node prototype's five-minute RAM tombstone and “unknown WebSocket
URL creates a document” behavior must not be reproduced in the Rust server.
There is currently no backend fallback: this milestone begins with the new
Rust process and durable schema.

**Schema**

```sql
schema_migrations (version, applied_at)
documents (
  id, owner_id, title, engine, snapshot_ref, snapshot_etag, chars,
  created_at, updated_at, deleted_at
)
document_updates (
  doc_id, site, seq, payload, received_at,
  PRIMARY KEY (doc_id, site, seq)
)
```

**Deliverables**

- Introduce ordered, transactional schema migrations.
- Change delete from physical row removal to a durable `deleted_at` tombstone.
- Reject unknown or deleted document IDs during WebSocket upgrade. Opening a
  socket never creates a document.
- Make document creation an authenticated, idempotent HTTP operation with an
  idempotency/create token.
- Journal accepted update frames before acknowledging them. Compact the journal
  into a full snapshot asynchronously.
- Distinguish `received by room` from `durably saved` in protocol/UI status.
- Flush on graceful shutdown and eviction, but do not depend on graceful
  shutdown for correctness.
- Fix the cold `?shallow=1` path so the response is actually shallow or is
  labeled as a full snapshot.

**Exit gate**

- Delete → kill server → restart → reconnect an old client never recreates the
  document.
- Edit → kill before snapshot debounce → restart recovers from the update
  journal or from a reconnecting full peer without losing an acknowledged edit.
- Two concurrent create requests with one idempotency token produce one row.
- A cold and a resident room return equivalent text for full and shallow open.

## M3 — Ship scratch-to-phone identity and silent sessions

The normative state machine, canonical signature bytes, endpoint contract,
transaction boundaries, and schema are in
[AUTHN-AUTHZ-PROTOCOL.md](AUTHN-AUTHZ-PROTOCOL.md). The Rust validators live in
`crates/marks-auth`; the production HTTP/database adapter belongs in the new
Rust Marks server.

Keep these identifiers distinct:

| Identifier | Meaning | Lifetime |
| --- | --- | --- |
| `scratchId` | Temporary capability-scoped workspace, not a person | Tab/recovery window |
| `principalId` | Durable random Marks account | Account lifetime |
| `controllerId` | Phone credential allowed to enroll/revoke devices | Until revoked |
| `deviceId` | One enrolled origin-scoped P-256 key | Until revoked |
| `sessionId` | One rotating cookie session | Session lifetime |
| `siteId` | One ESBT replica | Replica lifetime |
| `presenceKey` | One live cursor/selection publisher | Presence TTL |

Never derive `siteId` from any identity identifier. Two devices owned by one
person are one principal, two device credentials, and two ESBT sites.

**Deliverables**

- Paint a usable scratch editor without creating a principal, showing an
  explicit “temporary; scan phone to keep it” affordance.
- Keep the 256-bit scratch capability in `sessionStorage`; store only its digest
  server-side. Scratch work may be private and exportable but cannot be shared,
  commented on, or presented as durable.
- Admit scratch-owned rooms only through a one-use ticket bound to scratch,
  document, site, and authorization epoch. Bind `ScratchActor`, never a fake
  principal, and close those sockets when promotion claims the workspace.
- Generate a non-extractable P-256 pending-device key in IndexedDB without
  blocking first paint.
- Create a two-minute pairing whose 256-bit secret appears only in the QR/link
  fragment. Camera-less clients type the four-word accessibility code minted
  with that pairing. The words are hashed, rate-limited, and die with the
  pairing. They are not a password and not PAKE.
- Support first-phone controller bootstrap and existing-controller device
  grants. Bind signatures to pairing, scratch, pending device/key digest,
  controller epoch, capabilities, and expiry using the Rust canonical encoder.
- Atomically create/select the principal, enroll devices, consume the pairing,
  claim every scratch document, and install owner ACL rows. Duplicate requests
  must produce one result.
- Finalize the desktop session only for the tab still holding the claimed
  scratch capability.
- Store rotating session secrets in `Secure`, `HttpOnly`, `SameSite=Lax`,
  `__Host-` cookies and only hashes in the database.
- When the cookie is absent but an enrolled key survives, silently sign a
  one-use, origin-bound Marks device challenge. Captured challenges and
  signatures must not replay.
- Let a controller enumerate and revoke controllers, devices, and sessions.
  Revocation closes active sockets and prevents silent session recovery.
- Do not add WebAuthn/passkeys, passwords, magic links, OAuth tokens, recovery
  phrases, short codes, or a username step to this path.

**Latency budget**

- Scratch first paint is the existing local-editor path; no network identity
  request may gate typing.
- Starting a pairing is one server round trip after the pending key exists.
- After phone approval, desktop finalization is one round trip with a target
  below 500 ms p95 on a region-local connection.
- Measure QR scan/confirmation time separately from Marks-controlled latency.

**Exit gate**

- Two unrelated new devices create unrelated scratch workspaces, not two
  misleading “nursery identities.”
- Scanning both devices with one existing phone controller exposes the same
  durable file list while retaining separate device/session/site IDs.
- First-phone bootstrap preserves scratch work and creates exactly one
  principal under concurrent approval/finalize retries.
- Scratch room updates remain intact across claim; stale scratch tickets and
  already-open scratch sockets cannot write after the ownership epoch changes.
- Closing an unpromoted scratch tab has the loss behavior the UI advertised.
- Reload/browser restart resumes through the cookie; deleting only that cookie
  recovers silently through the enrolled device key.
- Losing all Marks origin storage is recoverable only from another controller
  or an attached repeatable credential. The UI states this before irreplaceable
  work accumulates.
- Pairing secret, grant, challenge, signature, and claimed-scratch finalize
  replays all fail.
- Revoking a session closes its sockets; revoking a device prevents it from
  minting a new session.

## M4 — Add the Chrome EVT promotion adapter

Email Verification Tokens are the only v1 alternate to phone promotion. They
are not an OAuth token, provider session, proof of one human, or anonymity from
Marks. The server sees a verified email while redeeming the presentation and
then retains only a versioned HMAC locator over issuer plus issuer-canonical
email.

Chrome's protocol is still an origin-trial surface with version and platform
constraints. Keep the adapter behind `auth_evt_enabled`, issuer and adapter
version allowlists, rollout limits, and a kill switch. There is no generic
browser fallback and Marks never silently sends an email.

**Deliverables**

- Create a one-use EVT challenge bound to scratch ID, pending device ID/key
  digest, exact HTTPS Marks audience, nonce, adapter version, and expiry.
- Keep Chrome/issuer-specific DNS delegation, metadata, SD-JWT, signature,
  key-binding, and presentation parsing in a narrow adapter. It may construct
  `VerifiedEmailEvidence` only after every feature-specific check succeeds.
- Pass trusted evidence through the Rust `marks-auth` validator, which rechecks
  challenge identity, audience, nonce digest, freshness, issuer origin, and
  locator-key strength.
- Store only `(locator_key_version, locator, principal_id, policy_version)`.
  Exclude raw email, token, presentation, and key-bound proof from database,
  logs, traces, analytics, and crash reports.
- If the locator already exists, select that principal. Otherwise create one.
  In the same serializable transaction, consume the challenge, attach the
  locator, claim scratch documents, promote the exact pending device, and issue
  the rotating session.
- Never merge two existing principals because they later present colliding
  recovery evidence. That requires an explicit account-merge protocol.
- Fall back to the phone presentation when EVT is absent, errors, exceeds its
  latency budget, or is disabled.

**Exit gate**

- A supported fresh presentation promotes scratch work in one redemption
  request without an identity form, passkey, OAuth grant, or retained provider
  token.
- Token, challenge, and nonce replays; wrong audience/issuer; stale evidence;
  adapter-version mismatch; and substituted device keys fail.
- The same issuer-canonical claim resolves the same locator; different issuers
  do not collide; Marks performs no ad hoc email case folding.
- A storage/log/trace audit finds no raw email or presentation.
- Phone promotion, existing sessions, and enrolled-device recovery continue to
  work when Chrome or the email issuer is unavailable.
- UI and product language say “verified email” rather than “anonymous,”
  “unique person,” or “proof of humanity.”

## M5 — Enforce ACLs and real share links

**Browser status:** the working tree now routes authenticated snapshots through
one access provider and requires a fresh one-use room ticket for the initial
WebSocket and every reconnect. It validates a same-origin `ws`/`wss` room URL,
keeps the ticket in `Sec-WebSocket-Protocol`, and provides no unauthenticated
fallback. The Rust ticket-minting, upgrade-consumption, ACL, and revocation
work below remains open.

**Schema**

```sql
shares (doc_id, principal_id, role, granted_by, created_at, revoked_at)
link_grants (doc_id, token_hash, role, created_at, expires_at, revoked_at)
document_tickets (
  id, secret_hash, principal_id, session_id, device_id, doc_id, site_id,
  role, auth_epoch, expires_at, consumed_at, revoked_at
)
```

Roles are `owner`, `editor`, `commenter`, and `viewer`. The default policy is
restricted. A share capability is independent from the document ID and is
rotatable.

**Deliverables**

- Add `POST /v1/documents/:id/session`. It validates the rotating session and
  live device, resolves the ACL, then mints a 30-second, one-use document ticket
  bound to `docId`, `principalId`, `sessionId`, `deviceId`, `siteId`, role,
  authorization epoch, expiry, and ticket ID.
- Require and atomically consume the ticket during WebSocket upgrade. Carry it
  in a redacted `Sec-WebSocket-Protocol` offer, select only `marks.esbt.v1`, and
  never put a long-lived credential in the URL.
- Bind an `Actor` to each socket.
- Accept `MSG_UPDATE` only from owner/editor sockets.
- Allow presence from all admitted roles, with role-appropriate identity
  disclosure.
- Close or demote live sockets immediately when a grant is revoked or
  downgraded.
- Add payload, operation-rate, and connection limits per actor/document.
- Replace “copy current URL” with a share dialog that creates, rotates, and
  revokes link grants.

**Exit gate**

- A viewer's forged `MSG_UPDATE` is rejected and never reaches another peer or
  persistence.
- A commenter cannot mutate markdown through any REST, WebSocket, preview, or
  cached-client path.
- Link rotation invalidates the old capability and closes affected sockets.
- A guessed document ID without an authorized session returns no metadata.

## M6 — Reintroduce comments in the metadata plane

Comments return only after M3 and M5. They do not use `MSG_UPDATE` or an ESBT
map.

**Schema**

```sql
comments (
  id, doc_id, author_id, start_anchor, end_anchor, quote, body,
  created_at, updated_at, resolved_at, deleted_at
)
```

**Deliverables**

- Load comment metadata through an authorized HTTP endpoint.
- Add a typed `MSG_COMMENT_EVENT` broadcast or a dedicated metadata stream.
- Owner/editor/commenter may create and resolve according to explicit policy;
  viewer is read-only.
- Use ESBT `indexToAnchor`/`anchorToIndex` for durable ranges, with quote/offset
  fallback when the anchored item was deleted.
- Validate document membership, anchor encoding, body size, and role on the
  server. Never trust author fields sent by the client.
- Provide a one-time migration/export path for legacy inert map records. Do not
  silently assign their old display-name string to a new principal.

**Exit gate**

- Commenter creates a comment while a simultaneous text update is rejected.
- Comments survive restart, snapshot compaction, object-store migration, and
  text edits above their anchor.
- Comments never appear in a full or shallow ESBT snapshot.
- Deleting/exporting a document applies the documented metadata retention rule.

## M7 — Add authorship and version history

**Schema**

```sql
op_authors (doc_id, site, seq, principal_id, session_id, received_at)
document_versions (
  id, doc_id, snapshot_ref, text_ref, created_by, created_at, name, reason
)
```

**Deliverables**

- Record actor identity for every newly accepted operation reference. Replayed
  or relayed operations never overwrite existing authorship.
- Require ESBT import/update inspection to return the applied `(site, seq)`
  references; do not parse private engine bytes in ad hoc Marks code.
- Create time-grouped and named historical checkpoints.
- Restore by computing a text diff from current text to historical text and
  generating new ESBT operations as the restoring actor. Never import an old
  snapshot as a rewind.
- If character-level blame is required, ask ESBT-web for a stable creator-op
  reference per live item; weight site plus insertion counter is not necessarily
  the transport operation sequence.

**Exit gate**

- History names the authenticated actor across reloads and devices.
- Restoring while another editor is connected converges forward on all peers.
- A client cannot attribute its operation to another principal.

## M8 — Move document bytes to object storage

Introduce an asynchronous storage boundary before adding another process:

```ts
interface DocumentStore {
  load(docId: string): Promise<LoadedDocument>;
  append(update: DurableUpdate): Promise<void>;
  saveSnapshot(snapshot: SnapshotWrite): Promise<SnapshotRef>;
  tombstone(docId: string): Promise<void>;
}
```

**Deliverables**

- Keep metadata, ACLs, tombstones, and current snapshot pointers in the
  relational database.
- Store immutable full snapshots and update segments under generation-scoped
  object keys. Update the current pointer transactionally after object upload.
- Supply a filesystem/test backend and an S3-compatible production backend.
- Verify checksum, format version, document ID, and generation on every load.
- Dual-write during migration, compare decoded text and operation frontier, then
  switch reads by feature flag. Retain rollback pointers until the migration is
  accepted.
- Generate true shallow payloads from a loaded full replica or store a separate
  validated shallow object.

**Exit gate**

- A fresh process with only metadata DB access and object-store credentials can
  open every migrated document.
- Interrupted upload or stale pointer cannot replace a newer generation.
- Object-store outage does not report an unsaved edit as durable.

## M9 — Add sticky, movable room ownership

Implement the integration document's target B: one live owner per document,
scheduled onto a worker.

**Deliverables**

- Add a room lease with owner worker ID, fencing token, expiry, and snapshot
  generation.
- Route a short-lived document token to the current worker.
- Fence every durable write so an expired owner cannot overwrite its successor.
- Move a room by stopping admission, flushing journal/snapshot, releasing the
  lease, rehydrating on the new worker, and reconnecting clients.
- Keep presence ephemeral; a moved room starts empty and clients republish it.
- Do not run two active owners unless a tested pub/sub merge path is added.

**Exit gate**

- Forced owner death and lease expiry yield one successor and no split brain.
- An offline client reconnects to the successor and uploads its missing delta.
- Stale-owner writes fail by fencing token.
- Load tests isolate a hot room from unrelated documents.

# 2. What ESBT-web needs to do

## E0 — Fix arbitrary same-origin delivery

The current TypeScript receiver treats the maximum seen sequence as a
contiguous prefix. Receiving sequence 2 before sequence 1 permanently drops
sequence 1.

**Deliverables**

- Deduplicate by exact operation identity `(site, seq)`.
- Maintain a per-site contiguous applied prefix plus a bounded reorder buffer.
- Accept and store an operation above a gap, but do not advance the contiguous
  frontier until all prior operations have arrived. Drain in origin sequence;
  retain the paper's insert/delete dependency handling inside that drain.
- Define gap limits and a resync/snapshot request rather than allowing an
  unbounded hostile buffer.
- Version the snapshot/update encoding if pending operations or sparse receipt
  state must survive export/import.
- Make `VersionVector` mean a contiguous exportable prefix everywhere. Do not
  overload it as “largest number observed.”

**Required tests**

- Sequence 2 then 1 yields the same state as 1 then 2.
- Every permutation and duplication of three operations from one site.
- Delete-before-insert, insert gaps, reconnect deltas, full snapshot with a
  pending gap, and shallow snapshot from a replica that has seen a gap.
- Multi-site randomized operation-level shuffle—not only shuffled sender
  blocks—with stable seeds and minimized failure output.

## E1 — Make allocation failure impossible to ignore

**Deliverables**

- Port the TypeScript strict-between candidate validation to Rust.
- Route equal-fraction neighbors and concurrent twins to `sn/sc` refinement;
  widen a twin pinch deterministically when necessary.
- Make tree insertion failure explicit. A local insert must either change the
  live tree exactly once or return an error before logging/broadcasting an op.
- Share adversarial allocation fixtures between Rust and TypeScript.

**Required tests**

- Merge concurrent `A` and `B`, insert `X` between them, and observe `AXB` (or
  the deterministic equivalent) on every replica.
- Repeated middle insertion, repeated deletion/reuse, equal-fraction ladders,
  depth exhaustion, and same-gap concurrency never lose a character.

## E2 — Use real replica and message identities in the browser demo

**Deliverables**

- Replace the room-wide 62-value `localStorage` site ID. Each live replica gets
  at least 128 bits of cryptographic entropy; sibling tabs are different sites.
- Expand the Rust/Wasm `SiteId` representation and binary encoding accordingly,
  with an explicit format version/migration story.
- Replace 32-bit FNV-only gossip deduplication with exact `(origin, seq)` IDs for
  operations and a collision-resistant ID for snapshots/batches.
- Define replay-window retention and anti-entropy after dedup eviction.
- Make the demo report transport status honestly when no signaling service is
  present.

**Required tests**

- Two same-origin tabs have distinct site IDs and converge after simultaneous
  edits.
- Forced hash collisions do not drop distinct messages.
- Reload, reconnect, duplicate gossip, stale replay, and a late join converge.

## E3 — Publish one stable package and compatibility policy

**Deliverables**

- Make `ESBT-web/ts` the only editable TypeScript source.
- Publish immutable versions with generated declarations and integrity hashes.
- State compatibility for operation, full snapshot, shallow snapshot, version
  summary, anchor, and generic map payloads.
- Maintain golden binary fixtures for every supported format version.
- Add Rust ↔ TypeScript interoperability tests where both implementations claim
  the same wire format.
- Deprecate the generic map as a Marks comment carrier. Preserve legacy decode
  until a documented sunset; do not add account/ACL/comment semantics to the
  engine.

**Exit gate**

- Marks consumes the published artifact without a copied source tree.
- Current code imports every supported historical fixture.
- Incompatible format changes fail CI unless they introduce a new envelope
  version and migration note.

## E4 — Expose product-safe inspection hooks

Marks needs identifiers, not access to engine internals.

**Deliverables**

- `import(update)` returns or emits the exact newly applied operation references
  `(site, seq)` so the authenticated room can record authorship.
- A local-update event exposes its operation references without requiring Marks
  to decode a private payload.
- Preserve stable, injectable `siteId`, `indexToAnchor`, and `anchorToIndex`.
- If blame is required, expose a live item's creator operation reference.
- Keep display identity, roles, tokens, timestamps, comments, and presence out
  of weights and persisted document snapshots.

**Exit gate**

- Marks records authorship using only public API types.
- The same update imported twice reports no second application.
- Anchor fixtures resolve consistently before and after snapshot rehydrate.

## E5 — Separate algorithm evidence from product performance

**Deliverables**

- Reproduce the paper's declared workload matrix: 50 replicas, 10,000–100,000
  operations, pure-insert and mixed workloads, beginning/end/middle/random
  positions, and equivalent Logoot/LSEQ baselines.
- Publish raw parameters, seeds, implementation revisions, warmup policy,
  runtime, machine profile, identifier bytes, and results.
- Add a separate browser benchmark for the real exposed path, including cached
  string updates, serialization, editor reconciliation, and rendering.
- Track worst-case sequence-path depth and actual encoded bytes. Do not describe
  the whole identifier as constant-size when `sc` grows.
- Treat a regression threshold as CI evidence, not as proof of the paper's
  percentages on every machine.

**Exit gate**

- A clean checkout can reproduce the result tables from one command.
- Comparative claims cite the exact fixture and commit; product UI reports only
  measurements it actually ran.

# Cross-repository critical path

| Order | Marks | ESBT-web | Gate |
| ---: | --- | --- | --- |
| 0 | Remove comments | — | Product no longer exposes an unauthorized metadata path |
| 1 | Freeze engine upgrades | E0 + E1 | Convergence/allocator counterexamples become passing tests |
| 2 | M1 consume released package | E2 + E3 | One source, unique sites, compatible wire formats |
| 3 | M2 durable single node | E4 API design can proceed | Restart/delete/crash evidence |
| 4 | M3 scratch/phone identity + M4 EVT adapter | — | One durable principal across explicitly linked devices |
| 5 | M5 ACL/share enforcement | E4 operation references | Every mutation attributable and authorized |
| 6 | M6 comments + M7 history | E4 anchors/blame hooks | Metadata is durable and outside ESBT state |
| 7 | M8 object storage | — | Documents move between processes without SQLite blobs |
| 8 | M9 sticky room ownership | — | Fenced failover without split brain |
| 9 | Product budgets | E5 comparative benchmark | Claims backed by reproducible evidence |

## CI matrix required at completion

### Engine CI

- TypeScript and Rust unit tests.
- Deterministic operation-level permutation/property tests.
- Cross-language golden fixtures.
- Wasm two-tab browser test.
- Snapshot upgrade/downgrade policy tests.
- 100,000-operation stress and identifier-depth report.

### Marks CI

- Schema migration from every released database version.
- REST and WebSocket role matrix.
- Delete/restart and crash-before-compaction tests.
- Two-tab, two-browser, offline/reconnect, and stale-client tests.
- Scratch first-paint timing, QR bootstrap/linking, rotating-cookie, silent
  device challenge, replay, storage-loss, and revocation tests in real browsers.
- EVT adapter fixtures for valid, stale, replayed, wrong-issuer/audience,
  device-substituted, and adapter-version-changed presentations; production
  origin-trial runs remain a separate canary.
- Comment authorization/anchor/restart tests after comments return.
- Object-store fault injection and room lease/fencing tests.
- Production container build and cold boot.
- Portable surface smoke on macOS modifier semantics and the existing Linux
  browser runners.

## Definition of complete

The integration is complete only when all of the following are true:

1. The audited convergence counterexamples pass in the released ESBT package.
2. Marks consumes that package without a source fork.
3. Unknown sockets cannot create documents and deleted documents stay deleted
   across restart.
4. Every document mutation is authorized and attributable to a Marks principal.
5. Phone controllers and enrolled devices work without EVT; an EVT outage or
   unsupported browser cannot strand an existing principal.
6. Share links are rotatable capabilities distinct from document IDs.
7. Comments and history live in the authenticated metadata plane, not ESBT
   snapshots.
8. A room can move to another owner using durable object state and fencing.
9. Product performance and paper-comparison claims have separate reproducible
   evidence.
