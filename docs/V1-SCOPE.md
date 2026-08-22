# Marks v1 release boundary

**Product:** a very fast, source-first collaborative Markdown editor for the
web.

**Scope rule:** a proposal is outside v1 unless it closes a demonstrated
correctness, data-loss, authorization, release, or user-visible product gap.

## Decisions that are no longer open

- Marks is not being restarted. Keep the React surface, CodeMirror integration,
  Markdown worker, incremental preview, local-first interaction model,
  presence UI, and browser/performance harness.
- The production backend is a new Rust implementation. The disposable Node
  backend is not a compatibility target and has been removed.
- The Rust ESBT implementation is the collaboration authority in both native
  server code and browser Wasm. The TypeScript engine is temporary; it does not
  become a second production CRDT.
- Marks owns authentication, authorization, identity, provider adapters,
  enrollment, and recovery in Rust. Room code consumes those internals through
  a narrow typed seam. The ESBT sequence algorithm remains identity-blind, and
  its correctness cannot depend on provider, enrollment, or recovery details.
- There are no released clients, users, or valuable persisted documents.
  Therefore there is no v1/v2 compatibility layer, document migration, dual
  running, legacy-client support, shadow traffic, staged cutover, or reason to
  keep Node operationally alive.
- Comments stay deleted until authenticated author identity and independent
  comment authorization exist. They never travel as opaque text updates.
- V1 runs as one Rust process, one transactional database, one live in-memory
  room per open document, and one bounded asset store selected for the actual
  deployment. Multi-node room ownership and dual storage backends are deferred.

## Product promise

> Typing is immediate and local. Collaborators converge. “Saved” means the
> server durably committed the edit. Access is enforced. The Markdown and its
> assets remain portable.

Marks is source-first. A WYSIWYG editor is not part of v1.

## What a document means

There are no current production documents to convert. “Document migration” is
not work we need.

For documents created after the Rust server exists, the durable record is:

- ordinary metadata: document ID, owner, title, filename, ACL, timestamps, and
  optional deletion time;
- an append-only sequence of committed ESBT update envelopes;
- a versioned, checksummed ESBT snapshot used only as compaction;
- a checksummed plain-Markdown checkpoint materialized at compaction time; and
- asset records/files when the Markdown references uploaded assets.

The Markdown checkpoint does not replace or transform an existing document.
It is the recovery/export representation of a future document: if an engine
binary is broken or retired, the user’s actual Markdown is still readable.
Comments and ACLs are separate records, never recoverable only from a CRDT
blob.

## V1 must ship

### 1. Rust ESBT browser/server contract

- One Rust core produces native server code and the browser Wasm artifact.
- Indices are UTF-16 code units so they exactly match JavaScript and CodeMirror,
  including non-BMP emoji.
- Same-site operations converge under permutation, duplication, gaps, delayed
  deletes, reconnect, and snapshot restore.
- Concurrent words typed at one cursor remain contiguous; convergence alone is
  insufficient.
- Every allocated weight is strictly between its requested neighbors.
- Version state is a contiguous prefix plus explicit sparse receipts; a maximum
  sequence never hides a gap.
- Compact snapshots merge with retained unsynced local operations, and fail
  explicitly when the required journal is unavailable.
- Decoders are versioned, bounded, exact, non-panicking, and reject malformed,
  noncanonical, and trailing bytes.
- Native and Wasm builds share golden update, version, and snapshot fixtures.
- The production browser binding supplies per-replica undo, transaction
  batching, local update journaling, and one document handle without copying
  the full Markdown string on each edit.
- Site IDs are assigned by the room, unique within a document, and never used
  as principal/session/presence identifiers.

### 2. One durable Rust room path

- Authenticated HTTP explicitly creates a document. Opening an unknown socket
  URL never creates one.
- A room verifies a short-lived admission assertion and binds one immutable
  actor: principal, session, document, site, and current role.
- A client update has a retry-safe message ID and bounded, versioned envelope.
- Before mutation, the room validates message kind, actor/site binding, role,
  engine version, payload length, operation count, sequence range, identifier
  depth, document limit, and pending-operation budget.
- The room first applies a valid update to staged room state. It then uses one
  database transaction to deduplicate the retry-safe message ID, assign the
  next document revision, and append the exact envelope. After the transaction
  commits, publishing the already-staged state cannot fail; only then does the
  room broadcast and return one `committed` acknowledgement.
- A retry of the same message ID and identical envelope returns the original
  committed revision. Reusing that ID for different bytes is rejected. If the
  process dies after database commit but before acknowledgement, journal replay
  restores the edit and the retry receives the original revision.
- V1 has no separate accepted/durable acknowledgement. Local editing already
  supplies latency; one server acknowledgement has one truthful meaning.
- Snapshotting is asynchronous compaction. It never defines whether an edit is
  saved and never overwrites a newer revision.
- A persistence failure stops new writes for that room, retries safely, raises
  an operational signal, and produces a visible client error. It never emits
  `committed` or “Saved.”
- Restart, abrupt kill, duplicate retry, disk-full simulation, corrupt
  snapshot, slow reader, and stale reconnect are integration tests.

### 3. Marks identity and authorization

The room needs only these validated results from the internal Marks auth
boundary:

- stable principal ID;
- revocable rotating session ID;
- document role: owner, editor, commenter, or viewer;
- short-lived one-use room admission bound to document/session/site; and
- a live revocation or role-change signal for already-open sockets.

Documents are private by default. Owner/editor may submit Markdown operations;
commenter/viewer may not. A share capability is distinct from the document ID,
can expire, and can be revoked. Unknown, deleted, or unauthorized document IDs
fail closed.

Phone-controller enrollment, silent device recovery, and the feature-flagged
verified-email rail are Marks components specified by
`AUTHN-AUTHZ-PROTOCOL.md`. They stay outside room logic and ESBT and may proceed
in parallel with engine and durability work. Authorized release still needs
the five boundary properties above proven end to end.

### 4. Basic document product

- Create, list, open, rename, move to trash, restore, and permanently delete
  after a documented retention period.
- Stable title and filename metadata; neither is inferred from the first
  heading.
- Import `.md`.
- Export the current local replica while offline.
- Paste/drop a bounded image, store it under document authorization, insert a
  normal Markdown link, and export Markdown plus assets as a portable bundle.
- Recovery-oriented bounded history with author/time and forward-edit restore.
- Minimal authenticated comment threads after the identity/ACL gate: anchored
  thread, reply, resolve/reopen, edit/delete own message. No mentions,
  reactions, notifications, or suggestion mode.
- Presence is best-effort and ephemeral. Multiple tabs may have separate
  cursors while the UI groups them under one principal.

### 5. Browser and operational floor

- The existing CodeMirror hot path stays outside React state; preview parsing
  remains in its worker with keyed dirty-block reconciliation.
- Performance claims are tied to checked-in fixtures and CI budgets, not “any
  document size.”
- Chromium, Firefox, and WebKit cover create/open/edit/reconnect/import/export.
- Focused cases cover IME composition, UTF-16/emoji, bidirectional text,
  keyboard-only use, screen-reader labels, reduced motion, zoom, and mobile
  viewport/virtual-keyboard behavior.
- The real service worker proves online first visit then offline reload, offline
  edit then close/reopen, reconnect, and quota failure. “Saved on this device”
  appears only after the local journal commit succeeds.
- Production ingress enforces origin checks, authentication, request/frame
  limits, rate limits, peer/document quotas, ping/pong, buffered-amount limits,
  slow-client eviction, CSP, MIME hardening, and no third-party script on
  authenticated pages.
- The exact release artifact boots in CI and proves create, two-peer edit,
  committed acknowledgement, process kill, restart, reopen, and export.
- Backups are automated and a restore test proves them. Health checks include
  database writeability, not merely a responding process.

## Explicitly deferred

- Multiple server processes, room leases, fencing, Redis/pub-sub, queues,
  regional routing, Kubernetes decomposition, and a second database.
- Object storage as part of live document correctness, and supporting multiple
  interchangeable asset backends. Choose one asset/backup store for the actual
  deployment without changing room semantics.
- Folders/workspaces, full-text search, organization administration, access
  requests, email invitations, and notification delivery.
- Suggestions/track changes, follow-a-collaborator, named versions,
  character-level blame, reactions, and a general audit UI.
- WYSIWYG editing, Git/PR workflows, plugins, public API, and native apps.
- Comparative CRDT marketing work beyond the correctness, size, and latency
  gates for the engine Marks actually ships.

## Physical v1 architecture

```text
Browser
  CodeMirror + Markdown preview worker
  Rust/Wasm ESBT replica
  IndexedDB update journal + compact snapshot
  authenticated HTTP/WebSocket
              |
              v
One Rust marks-server
  Marks identity + sessions/ACL admission
  document HTTP API
  one native ESBT room per live document
  committed update journal + snapshot compactor
  best-effort presence relay
              |
              v
One transactional database + one bounded asset/backup store
```

These are module boundaries, not services. Do not add a cache, broker,
backplane, object-document store, or extra database until a measured need
exists.

## Release gates, in order

1. **Engine:** native/Wasm parity, UTF-16, gap/order/reuse correctness,
   intention tests, snapshot merge, undo, and local journal.
2. **Durability:** create → edit → committed → kill → restart → reopen, with no
   lost committed edit.
3. **Access:** authenticated create/open, private default, role matrix, live
   revocation, and unguessable/revocable sharing.
4. **Product:** import/export, trash/restore, images/assets, recovery history,
   and identity-backed comments.
5. **Release:** browser/offline/accessibility checks, production artifact boot,
   backup/restore proof, and truthful UI states.

Identity work may proceed in parallel, but later product work cannot weaken or
delay the earlier engine and durability gates.

## Complexity stop test

A new component enters v1 only if it:

- closes a demonstrated correctness, data-loss, authorization, or release
  failure;
- implements a user-visible requirement above;
- removes a measured editor/room bottleneck; or
- replaces more code or operational surface than it introduces.

“We may need it for multiple regions, enterprise tenants, or a future plugin
ecosystem” is not a v1 reason.
