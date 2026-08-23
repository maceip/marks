# Presence, selection, and preview-follow contract

**Status:** normative target contract; the delivery table below is authoritative

**Last updated:** 2026-08-23

Presence is disposable UI state. It may make collaboration easier to see, but
it must never participate in document convergence, authorization, or the
meaning of **Saved**. This document deliberately distinguishes what is shipped
from the rolling-upgrade protocol that is still planned.

## 1. Delivery truth

| Capability | Status | Behavior |
| --- | --- | --- |
| Room-scoped `0x02` relay, V1 JSON-value codec, remote source offsets, avatar/caret rendering, 15 s heartbeat, 30 s local expiry | **Delivered** | Works per ESBT site/connection; values are bounded and not persisted. |
| Missing/malformed/stale presence | **Delivered degraded path** | Editing and durable CRDT sync continue; the bad frame is ignored or the slow peer is evicted. |
| Authenticated identity aggregation, scratch labels, deterministic colors, activity/visibility state, connection-instance bootstrap/removal, V2 anchors, and preview-follow modes | **Planned** | This document fixes the contract and rollout; UI must not claim these semantics before implementation. |

“Degraded” always means a defined fallback of delivered or planned behavior,
not evidence that the planned feature has shipped.

## 2. State machine and exact timers

Each browser tab that has an admitted room socket is a **connection instance**.
It has an unpredictable 128-bit `connection_id`, regenerated for every socket
admission (including reconnect), and a sequence counter beginning at 1.

| State | Exact definition | Transition |
| --- | --- | --- |
| **connected** | The socket is admitted and its V2 bootstrap was accepted. This is transport state, orthogonal to activity. | Enter on accepted bootstrap; leave immediately when the socket closes or admission is revoked. |
| **active** | Connected and the tab received qualifying local input in the preceding **15,000 ms**. | Enter immediately on `pointerdown`, `keydown`, `beforeinput`, selection change, editor focus, or preview-follow interaction. |
| **idle** | Connected, visible, and no qualifying input for **15,000 ms**. | Enter exactly 15,000 ms after the last input; return to active on input. |
| **hidden** | Connected and `document.visibilityState === "hidden"`. | Enter immediately on `visibilitychange`; return immediately to active when visible (the visibility event counts as activity). Hidden supersedes active/idle. |
| **editing** | Active, editor focused, and the last local document change was at most **3,000 ms** ago. | Enter on a local edit; leave 3,000 ms after the last edit, on blur, hidden, or disconnect. |
| **selecting** | Active and the primary selection is non-empty, or a pointer/keyboard selection gesture is in progress. | Enter immediately; leave immediately when collapsed/gesture ends, or on hidden/disconnect. `editing` and `selecting` may both be true. |
| **disconnected** | The socket closed, admission was revoked, or the server removed the instance. | Remove carets/selections immediately. Keep its avatar as reconnecting for **30,000 ms**, then remove it unless another instance of the participant remains. A reconnect is a new instance. |

Clients publish immediately on every state/selection/mode change and send a
full-instance heartbeat every **10,000 ms**. The server expires an instance
after **30,000 ms** without an accepted frame and broadcasts removal. A client
also expires it locally after **35,000 ms** without an accepted frame, so a
lost removal cannot leave a permanent ghost. Timers use elapsed monotonic time;
wall-clock timestamps are display hints only. Background timer throttling does
not extend a lease: a hidden tab must publish on becoming visible and may have
to bootstrap a new connection.

## 3. People, guests, instances, colors, and avatars

The server derives participant identity from room admission; it never trusts a
name, role, principal, scratch ID, or site supplied in a presence frame.

* An **authenticated participant** is keyed by stable `principal_id`. The
  server supplies the current display name and avatar reference from account
  metadata. Session and device IDs are neither display names nor grouping keys.
* A **scratch guest** is keyed by the admitted `scratch_id`, scoped to this
  document and scratch lifetime, and displayed as `Guest <short label>`. The
  label is a server-provided, non-secret room alias; capability material and
  raw scratch IDs never enter frames or UI.
* A **connection instance** is one tab/socket and is bound server-side to its
  participant, ESBT site, role, and `connection_id`. Multiple cursors can
  therefore belong to one participant without pretending that sites are people.
* Multi-tab aggregation groups instances by participant. The aggregate is
  active if any instance is active, editing/selecting if any is, hidden only if
  all connected instances are hidden, and disconnected only when none remain.
  The most recently active instance supplies the avatar tooltip and follow
  target; all instance carets remain independently renderable.
* Color is `palette[HMAC-SHA-256(room_color_seed, participant_key) mod N]`.
  The server sends the palette index, never the seed. It is stable within a
  document, differs across documents, and is not chosen by a client. Carets of
  multiple instances use the same base color plus an instance dash/shape.

The avatar stack contains self first, then participants with at least one
connected instance, then reconnecting participants within the 30,000 ms grace
period. Each participant appears once. Order is: self; aggregate editing;
selecting; active; idle; hidden; reconnecting; then case-folded display name
and participant key as stable ties. Overflow is a `+N` item. It never contains
one avatar per tab, viewers who never bootstrapped presence, expired peers, or
raw principal/session/device/scratch/site IDs. Carets and selections disappear
on disconnect even while an avatar is in its grace period.

## 4. V2 binary payload and validation

The room frame remains `0x02 || payload`. V2 payloads are exact binary frames:

```text
magic "MKPR" (4) | version u8 (=2) | kind u8 | flags u16le
connection_id (16) | sequence u64le | body_length u32le | body
```

Kinds are `1 bootstrap`, `2 replace`, `3 heartbeat`, `4 remove`, and
server-only `5 bootstrap_boundary`.
Integers are unsigned; variable integers and lengths inside bodies use minimal
ULEB128. Strings are fatal UTF-8. Unknown flags, kinds, non-minimal integers,
invalid UTF-8, length mismatch, and trailing bytes reject the whole frame.

The body is a fixed-order, length-prefixed record (not an extensible JSON/TLV
map). Client `bootstrap` and `replace` bodies contain `activity:u8`,
`mode:u8`, `range_count:uleb128`, then each range as
`start_anchor:bytes, start_bias:i8, end_anchor:bytes, end_bias:i8`, followed by
`section_key:utf8`; an empty anchor/section denotes absence. Activity values
are `1 active`, `2 idle`, and `3 hidden`; flags bits 0 and 1 are `editing` and
`selecting`, with every other bit zero. Mode values are `1 source_exact`,
`2 preview_section`, `3 preview_exact`, and `4 off`. Client `heartbeat` and
`remove` bodies are empty. Server-fan-out bootstrap/replace prepends
`participant_kind:u8, participant_key:utf8, display_name:utf8,
avatar_ref:utf8, role:u8, site_id:u64le, color_index:u8`; scratch aliases, not
raw scratch IDs, occupy `display_name`, and `participant_key` is an opaque
room-local grouping token. Server `remove` and `bootstrap_boundary` bodies are
empty. Signed `i8` biases are exactly `-1`, `0`, or `1`.

Limits include the header: **16,384 bytes/frame**, **4,096 bytes for each
engine anchor**, **1,024 bytes for a preview section key**, **256 bytes for a
display name**, **2,048 bytes for an avatar reference**, at most **8 ranges**
per instance, and at most **64 live instances per room participant / 256 per
room**. A participant may publish at most **20 frames/s sustained and 40 burst**.
The room has bounded per-socket output queues; a slow reader is evicted rather
than accumulating presence. Document frame ceilings remain independent and
take priority.

`bootstrap` is a complete instance record and must be the first V2 frame for a
connection. `replace` is a complete replacement of that instance's ephemeral
state, not a patch; omission clears an optional field. `heartbeat` renews the
last complete state without changing it. `remove` deletes the instance and is
idempotent. On socket close the server synthesizes removal, so correctness
does not depend on a final client frame. On joining, the server sends a bounded
bootstrap for every current instance before live replacements, followed by an
empty bootstrap-boundary frame. No bootstrap means an empty avatar stack, not
guessed participants.

Sequence is strictly monotonic per `connection_id`: bootstrap is sequence 1;
an accepted frame must have a greater sequence than the last accepted one.
Duplicates and lower sequences are silently discarded; a gap is allowed
because replacements are complete. Wrap is forbidden and requires a new
connection. The server rewrites/attaches authoritative identity, role, site,
color, and receive-age metadata before fan-out. It validates admission binding,
kind/order/sequence, all byte/count/rate limits, enum values, anchor decodability,
range ordering, and preview mode before relay. It does **not** persist frames
or reject a document mutation because presence is invalid.

## 5. Selection and follow modes

Source positions are engine-owned relative-position anchors plus a UTF-16
association/bias; raw offsets are permitted only in the legacy V1 decoder.
Ranges are normalized after resolving against the receiver's current replica.
An unresolvable anchor suppresses that caret/range until a later complete
replacement; it never guesses a source offset.

| Mode | Meaning | Required fallback |
| --- | --- | --- |
| Source **`exact`** | Render the resolved source caret/ranges in the editor. | If either anchor cannot resolve, hide that range; retain avatar/activity. |
| Preview **`section`** | Follow a stable rendered block/heading section key and show a section highlight, not a character claim. | Fall back to the nearest surviving ancestor section, then document top. |
| Preview best-effort **`exact`** | Map source anchors through the receiver's current source-to-rendered-text map. | If exact mapping is unsafe, degrade to `section`; never synthesize a character range. |
| **`off`** | Publish activity/avatar state but no selection or follow target. | Always valid; used for privacy, unsupported views, and user opt-out. |

Markdown punctuation and constructs do not always correspond to rendered text.
YAML/front matter, link destinations and reference definitions, HTML tags,
footnote definitions, hidden comments, table delimiters, list markers, fence
markers/info strings, entity spelling, collapsed whitespace, generated heading
IDs, KaTeX/Mermaid output, and sanitizer-removed content cannot promise exact
rendered offsets. A range crossing block boundaries or any such unmappable
span degrades as a whole to `section`. It must not be snapped to nearby prose
while labelled exact. If the section key is also unavailable, use document top
without a highlight. Following never changes the follower's local selection.

## 6. Performance and privacy invariants

* Presence is memory-only: no database, IndexedDB, snapshot, journal, backup,
  replay, analytics, crash attachment, or audit event persistence.
* Logs and metrics contain no anchor bytes, selection ranges, section keys,
  display names, typed text, or serialized frame bodies. They may contain
  aggregate counts, byte sizes, reject reason codes, and coarse latency.
* Fan-out is bounded by admitted room instances, frame/rate ceilings, and
  bounded output queues. Presence never creates an unbounded task or queue.
* State is replaceable and coalescible: an unsent replace may be overwritten by
  a newer replace, redundant heartbeats may be dropped, and only the latest
  complete state matters. Bootstrap and removal preserve ordering.
* Durable CRDT mutation, commit acknowledgement, snapshot, and authorization
  traffic always has scheduling/buffer priority over presence. Under pressure,
  drop/coalesce presence first; presence loss must not change Saved or sync.

## 7. Interoperability and rollout

| Reader / writer | V1 offset writer | V2 anchor writer |
| --- | --- | --- |
| V1 reader | Full legacy behavior | Ignores unknown V2 payload; document sync continues |
| Dual V1+V2 reader | Legacy source exact only; preview exact degrades to section/off | Full V2 behavior |
| V2-only reader | Ignores V1 after the retirement gate | Full V2 behavior |

During the compatibility window, new writers send V2 and may additionally
send V1 only when server-negotiated room capabilities report a V1 reader.
Dual readers deduplicate by authoritative connection/site binding and prefer
V2. The server never translates raw offsets into anchors.

Roll out in this non-negotiable order:

1. Deploy protocol readers that accept V1 and V2 and safely ignore unknown
   versions.
2. Deploy server bootstrap/removal, authoritative enrichment, validation,
   capability negotiation, limits, and V2 fan-out.
3. Enable V2 writers, then the aggregation and preview-follow UI, with metrics
   based only on counts/reason codes.
4. Remove V1 **offset decoding last**, only after the maximum supported client
   lifetime plus 30 days shows no V1 readers/writers. Removal does not alter
   the outer `0x02` tag or durable document protocol.
