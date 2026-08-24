# Ribbon possibility layer: wild capabilities 1–5

This code adds five production capabilities as one browser-local possibility layer. When explicitly enabled, every ribbon surface can open them, the guarded command runtime feeds their receipts, and their durable local state is shared across tabs with IndexedDB and `BroadcastChannel`.

The layer adds no Rust route, database migration, collaboration message, ESBT artifact, deployment file, or provider gateway. The existing document repository, version repository, command center, and `CollabSession` interfaces are reused without widening any protected server or protocol boundary.

## Activation contract

The layer is merged but off by default while product and design review is pending.

- Development: `VITE_MARKS_RIBBON_WILD=1 npm run dev`
- Production build: `VITE_MARKS_RIBBON_WILD=1 npm run build`
- Any missing value, including `0`, leaves the layer disabled.
- The resolved build state is inspectable as `data-marks-ribbon-wild="enabled|disabled"` on the document root.

In a disabled build, wild commands are omitted from the active command registry and legacy palette, the agent keeps its stable suggestions, command execution does not capture source observations, telemetry does not scan or open IndexedDB, and the lazy Wild Studio/Telemetry assets are not requested. Enabling the flag restores the five commands and all responsive/agent integration described below. This activation gate is not a substitute for the planned visual and interaction review.

## Capability contracts

### 1. Intent Horizon

- Derives at most seven next-action candidates from the exact document-intelligence revision and recent in-memory command receipts.
- Exposes its evidence basis, confidence, urgency, and registered command IDs; it never silently executes an inference.
- Lets a person declare and pin an outcome, bind its first visible move to an available registered command, show that command in the responsive ribbon, run it through the guarded runtime, mark it done, or dismiss it.
- Persists only explicit horizon records. Inferred candidates remain derivable from source and are persisted only when pinned, done, or dismissed.

### 2. Causal Lightpath

- Instruments commands only after the command center admits them for execution.
- Captures an internal before/after observation with the real run ID, source (`human`, `keyboard`, `palette`, `agent`, or `bridge`), selection, mode, risk, and terminal result.
- Displays a transient live path across Markdown source, compiled rendering, collaboration, durability, and external boundaries.
- Persists SHA-256 source digests, character counts, a minimal range delta, predicted lanes, and the bounded reversal-patch ID. It does **not** persist full document source in the causal ledger.
- Observability is failure-isolated: a closed or full local possibility store cannot fail the admitted command.

### 3. Consequence Lanes

- Projects consequences from the same registered `CommandDefinition` used for ribbon visibility, agent tools, role checks, and execution.
- Separates five planes: canonical source, compiled rendering, collaborators, durability, and the outside boundary.
- Requires an explicit stage action before run. External and destructive commands require a separate boundary arm.
- Running always returns to the command runtime, which rechecks current hydration, role, capability, mode, context, selection, and parameter schema. The prediction is explanatory, not authorization.

### 4. Context Half-Life

- Scans at most 2 MiB and retains at most 200 discovered signals per pass.
- Recognizes relative-time language, freshness superlatives, `as of` dates, version claims, `due:YYYY-MM-DD` deadlines, and HTTP(S) dependencies while ignoring fenced code examples.
- Keeps exact UTF-16 ranges and source text, a first-seen time, last-seen time, review time, and explicit TTL. A person can change cadence, review, dismiss, or reveal the exact claim.
- Human-added signals require a non-empty source selection. Reveal reuses the exact range or a single unique source occurrence; ambiguity fails visibly.
- This feature does not make network freshness claims. Link reachability remains an explicit practical-layer action.

### 5. Persistent Counterfactual Shelf

- Stores one bounded source replacement per alternative: base digest, exact range, expected text, replacement, and 80-character prefix/suffix anchors.
- Automatically creates a reversal patch for a successful source-changing ribbon or agent command when the minimal changed span is at most 512 KiB.
- Lets a person preserve an alternative for the current source selection, preview a bounded line diff, export the patch, archive or restore it, explicitly remove its local copy with a two-step action, apply it, or branch it as a new document.
- Application requires edit **and** version-checkpoint authority. Marks creates the existing durable version checkpoint first, then applies source, waits for `CollabSession.whenDurable()`, and records application time.
- A branch uses the existing access-aware document repository and never overwrites the current document.
- Stale alternatives apply only at the exact range or one uniquely matching context. Missing or ambiguous anchors fail closed.

## Local persistence contract

Database: `marks-wild-studio`, version 1.

| Object store | Per-document bound | Stored content |
| --- | ---: | --- |
| `intentions` | 40 | Declared/pinned/done/dismissed intent metadata and command IDs |
| `causal` | 250 | Command metadata, hashes, minimal delta, lanes, and outcome; oldest receipts are trimmed |
| `context` | 500 | Exact aging claim, source range, cadence, and review state |
| `counterfactuals` | 80 and 8 MiB | Bounded expected/replacement text and stale-safe anchors |

Every object is keyed by an opaque ID and indexed by `documentId`. New writes and automatic context reconciliation enforce the bound transactionally. Local same-tab changes use `marks:wild-store-change`; other tabs use `marks:wild-store-change:v1`. The stores never synchronize through the collaboration protocol and are not included in a document share.

The command-observation backlog exists only before the telemetry listener mounts. It is bounded to 40 observations and 2 MiB of source characters; oversized observations are dropped rather than retained in memory.

## Responsive ribbon integration

- **Desktop:** all five commands live under Review in `Possibility` and `Time & alternatives` groups. The studio docks to the right and the agent pill contracts into a linked receipt dock instead of covering it.
- **Phone:** all five commands are in the Document intelligence sheet. The studio becomes a bottom sheet above the composer and safe area. The live causal path moves above the phone controls.
- **Unfolded book posture:** a 72px view rail switches Markdown / Split / Preview. All five possibility commands live in the full-width Review ribbon. The studio is constrained to the companion physical segment rather than crossing the hinge.
- **Unfolded laptop posture:** the same view rail and full-width ribbon. The studio occupies the lower segment beneath the horizontal hinge, leaving the upper reading/editing segment intact.

## Agent and WebMCP boundary

The five opener commands are ordinary registered tools, so the existing local planner, hosted OpenAI gateway, in-page `window.marksRibbon` bridge, and WebMCP registration discover the same schemas. The agent can open a capability, focus relevant controls, and receive a normal command receipt. It cannot bypass consequence staging, version authority, stale-patch checks, or the runtime’s external/destructive approval policy.

Document source still is not sent to the hosted planner by this layer. Agent-originated command effects are observed locally after execution and labeled `agent` in the causal receipt. Selecting another future provider does not require a second ribbon integration: it must propose registered command IDs through the same command-center boundary.

## Failure behavior

- IndexedDB failure leaves the document and command runtime operational; the capability reports or degrades to an empty local view.
- Counterfactual quota failure does not erase the causal command receipt.
- Context scanning is debounced after source changes and bounded before regex analysis.
- Full source is never included in causal persistence or a provider request.
- Version-checkpoint, branch creation, durability, and unique-anchor failures are surfaced without pretending the operation completed.
