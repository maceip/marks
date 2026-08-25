# Ribbon practical: protected interface changes

The practical ribbon stream is stacked on `codex/ribbon-core`. Core deliberately
left the Rust server, SQLite schema, authentication protocol, collaboration
engine, ESBT artifacts, and deployment files unchanged. This document records
every exception introduced by practical capabilities and the reason it exists.

## Agent-chat activation contract

Agent chat is merged but off by default. It uses an independent build-time gate
that follows the ribbon-wild convention:

- Development: `VITE_MARKS_AGENT_CHAT=1 npm run dev`
- Production build: `VITE_MARKS_AGENT_CHAT=1 npm run build`
- Any missing value, including `0`, leaves agent chat disabled.
- The resolved state is inspectable as `data-marks-agent-chat="enabled|disabled"`
  on the document root.

In a disabled build, the product and design-system agent chat UIs do not render;
the local and hosted planners do not load; no hosted capability probe or run
recovery starts; agent tool projection is empty; and neither `window.marksRibbon`
nor the experimental WebMCP page tools are registered. The lazy `AgentPill`,
`AgentChatPill`, planner, gateway, run-store, and agent-style modules are omitted
from the built artifact rather than merely left as unreachable chunks. Human
ribbon, palette, shortcut, and KeyTip commands remain available.

Every Vite build checks the final Rolldown module graph: disabled features fail
the build if any gated source module is emitted, and enabled features fail if a
required lazy entry is missing. This assertion uses source module IDs rather
than hashed filenames, so chunk renaming or merging cannot bypass it.

This browser gate and the server provider policy are independent. Hosted planning
requires both `VITE_MARKS_AGENT_CHAT=1` in the client artifact and an explicitly
enabled `MARKS_AGENT_PROVIDER`; enabling either one alone cannot activate the
hosted path. The checked-in build and deployment configuration enables neither.

## In-page agent gateway

The agent pill needs a deployable hosted-planner option in addition to the
private, deterministic local planner. That capability cannot be implemented
safely by calling a model provider directly from the browser: doing so would
expose a credential, let browser input choose provider policy, and lose durable
run/tool receipts when a page reconnects. Practical therefore adds one bounded,
session-owned server interface:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/v1/agent/capabilities` | Report whether the deployment enabled a provider and publish bounded protocol limits. |
| `POST` | `/v1/agent/runs` | Start or idempotently recover a run for a document the current session may read. |
| `GET` | `/v1/agent/runs/{id}/events` | Replay the run's monotonic semantic event journal as SSE. |
| `POST` | `/v1/agent/runs/{id}/tool-results` | Record one idempotent guarded-command receipt and allow the provider turn to continue. |
| `DELETE` | `/v1/agent/runs/{id}` | Cancel a run owned by the current session. |

The mutation routes require the existing session cookie, exact-origin check,
and CSRF proof. Run lookup is scoped to the current session, and initial run
creation performs the existing indistinguishable document read-ACL check.
Logout and device revocation cancel associated live runs. No agent endpoint
widens document permissions or collaboration-frame semantics.

The browser request contains only the user's prompt, document identifier, and
the bounded schemas of commands already exposed by the local command registry.
It never includes Markdown source, selection text, provider/model/endpoint
choice, or a credential. A proposed tool must match the current local command
ID, generated name, risk class, and durability class before the existing
command runtime can stage it. That runtime still rechecks capabilities and
requires its normal confirmation for risky actions.

SQLite migration 10 adds `agent_runs`, `agent_events`,
`agent_tool_receipts`, and `agent_usage_daily`. These tables exist only to make
create/tool submission exactly idempotent, SSE replay ordered, interruption
terminal and inspectable, and admission/accounting enforceable. They do not
store document content or tool arguments. The browser's session-storage resume
record likewise omits the prompt and tool arguments; an interrupted local
mutation with no recorded receipt is reported as ambiguous and is not replayed.

## Provider adapter

`AgentProvider` is the narrow server-owned adapter seam. The first adapter uses
the OpenAI Responses API with strict function schemas, `store: false`, serial
tool calls, bounded streaming input, no redirects, no ambient proxy, normalized
error codes, and cancellation tied to the Marks run. The API key is read once
from a regular file that is not group/world accessible and is redacted from
debug output. The provider and model are deployment policy; they are never
browser parameters.

The server gateway is disabled by default. In an explicitly enabled agent-chat
build, disabling the hosted provider—or going offline—leaves the deterministic
local planner available. In the default agent-chat-off build there is no pill or
planner surface. The capabilities response sets `webMcp: false`: the in-page
command registry is the authoritative tool surface for this implementation, and
no external provider-supplied WebMCP authority is implied.

Cursor's public cloud-agent SDK/API is intentionally not wired as a drop-in
planner. Its present contract runs repository-editing agents in managed
environments, while this gateway needs a short-lived, schema-constrained,
in-page ribbon planner whose mutations are executed by the browser's guarded
command runtime. A future Cursor adapter must demonstrate that exact contract
without exporting document authority or source before it can implement
`AgentProvider`.

## Deployment configuration

The new variables are additive and all retain a safe disabled default:

| Variable | Default | Boundary |
| --- | --- | --- |
| `VITE_MARKS_AGENT_CHAT` | unset | Client build gate; only exact value `1` exposes agent chat and browser agent command entry points. |
| `MARKS_AGENT_PROVIDER` | `disabled` | `disabled` or `openai`; server-owned. |
| `MARKS_OPENAI_API_KEY_FILE` | unset | Required for OpenAI; regular file, at most 16 KiB, mode `0600` or stricter. |
| `MARKS_OPENAI_MODEL` | unset | Required for OpenAI; validated server-owned model identifier. |
| `MARKS_AGENT_MAX_CONCURRENT_RUNS` | `8` | Process-wide active-run admission. |
| `MARKS_AGENT_MAX_RUNS_PER_SESSION` | `2` | Per-session active-run admission. |
| `MARKS_AGENT_MAX_RUNS_PER_HOUR` | `30` | Per-principal start rate. |
| `MARKS_AGENT_MAX_RUNTIME_MS` | `600000` | Hard run lifetime. |
| `MARKS_AGENT_EVENT_RETENTION_MS` | `900000` | Terminal event/run retention before purge. |
| `MARKS_AGENT_TOOL_WAIT_MS` | `120000` | Maximum wait for a browser tool receipt. |
| `MARKS_AGENT_MAX_OUTPUT_TOKENS` | `4096` | Provider output-token ceiling. |

The checked-in systemd unit does not enable a paid provider. Operators opt in
with a service override after installing the key outside the repository, then
restart the service. This keeps deployment of unrelated ribbon features from
silently activating external transmission or spend.

## Interfaces not changed

This slice does not alter ESBT, CRDT operations or snapshots, WebSocket frames,
room tickets, document ACL roles, collaboration presence, asset storage,
backups, or static-artifact verification. Later practical features must append
their own rationale here before changing any of those protected surfaces.

## Document-intelligence lookup exceptions

Three practical inspectors need data that cannot be derived from the open
Markdown alone. They add the following document-authorized routes without
changing ESBT, collaboration frames, document roles, or stored Markdown:

| Method | Route | Capability and boundary |
| --- | --- | --- |
| `GET` | `/v1/documents/{id}/assets` | Asset Inspector lists bounded metadata for assets already attached to a readable live document. It returns no blob bytes or content hashes. |
| `POST` | `/v1/documents/{id}/link-checks` | Link Intelligence explicitly checks at most 32 user-selected HTTP(S) destinations. It never receives document source. |
| `POST` | `/v1/documents/{id}/citation-lookup` | Citation Ledger sends one syntactically validated DOI to the fixed Crossref API and returns bounded bibliographic fields. |

Both network lookups require existing document read authority. Principal
requests additionally require exact origin and the existing session CSRF
proof; scratch requests remain protected by their explicit authorization
header and CORS preflight. The shared lookup budget is 30 requests per minute
per principal or scratch workspace.

The link checker does not provide a general server fetch primitive. It accepts
only HTTP(S), rejects credentials, resolves every hop itself, pins the chosen
public address into a no-proxy/no-redirect client, rejects private, loopback,
link-local, carrier-grade NAT, benchmark, documentation, multicast, and
unspecified IPv4/IPv6 space, follows at most three revalidated redirects, and
never reads a response body. DOI lookup has a fixed host, no redirects or
ambient proxy, a 12-second deadline, and a 1 MiB streamed-response ceiling.

Cross-document blocks use the existing ACL-filtered document list and existing
authorized Markdown export route. The renderer shows one indistinguishable
unavailable state for missing and unreadable targets, withholds circular
self-references, and resolves readable blocks again during explicit publish
export. No dependency or document content is copied into server metadata.

## Complete practical capability map

The client implementation is deliberately one intelligence system rather than
eighteen unrelated dialogs. A lazy worker receives the current canonical
Markdown and a monotonically increasing content revision, analyzes at most 8
MiB, and returns UTF-16 source ranges that line up exactly with CodeMirror and
ESBT. The UI accepts a result only for the latest revision. Every automatic fix
also carries its expected source text and fails closed if that text has moved.

| Ribbon capability | Production behavior and durable representation |
| --- | --- |
| Document Health | Prioritizes concrete errors, warnings, and suggestions from the exact worker revision; source-backed findings reveal or apply guarded fixes. |
| Render/Compile Diagnostics | Detects unclosed fences/math and broken or duplicate reference definitions before compiled output silently drifts. |
| Accessibility | Audits heading order, image alternatives, generic link labels, and table headers with exact source navigation. |
| Front Matter/Document Schema | Parses YAML with duplicate-key and alias limits; known fields round-trip through the YAML document tree while comments and unknown keys survive. |
| Publish Profiles | Persists web, print, README, or slide intent in Markdown front matter and downloads a sanitized, self-contained artifact from the current revision. |
| Link Intelligence | Resolves anchors locally and runs bounded external checks only after an explicit click through the protected interface above. |
| Citation/Source Ledger | Reconciles footnotes, Pandoc keys, and local bibliography records; DOI lookup is explicit and inserts a Markdown-native anchored footnote. |
| Structural Refactoring | Renames, promotes, demotes, moves, or extracts a complete heading subtree; extraction first creates a named version when authority permits. |
| Collaboration Console | Presents the live role, peers, connection, pending operations, journal state, snapshot size, history floor, and network receipt from the existing session. |
| Durability/Recovery | Waits for the real durability receipt before a named checkpoint and always offers a local emergency Markdown download. |
| Version Branching/Comparison | Loads durable Markdown versions, performs a bounded line comparison, and branches into a new document without overwriting either input. |
| Asset Inspector | Reconciles source image references with authorized stored-asset metadata and identifies missing alternatives, external dependencies, and unreferenced blobs. |
| Reader Simulation | Computes reading/speaking pace and renders bounded article, phone, print, and heading-led slide simulations without changing source. |
| Privacy/Exposure | Locally identifies likely credentials, keys, email addresses, and IP addresses, supports stale-safe redaction, and explains each outbound boundary. |
| Task/Decision Ledger | Projects Markdown task items and explicit decisions into an actionable ledger; toggles and additions edit the canonical Markdown rather than a shadow database. |
| Paste Intent/Provenance | Reads the clipboard only after a click and inserts preserved, plain, quoted, or collision-safe fenced Markdown with an optional portable provenance comment. |
| Cross-document Blocks | Inserts `![[document-id#heading|label]]`, hydrates only through existing read authority, and visibly withholds missing, unreadable, or circular content. |
| Audience/Quality Contract | Persists audience, target grade, and sentence length in front matter, then compares current local readability metrics to that explicit contract. |

All eighteen capabilities are registry commands, so desktop, phone, unfolded
foldable, and palette use the same availability, authority, consequence,
visual-focus, and receipt path. When the independent agent-chat build gate is
enabled, local agent, hosted agent, and the in-page command bridge join that same
path. Clipboard access remains intentionally unavailable to remote agents.

## Verification boundaries

Unit coverage owns source ranges, stale fixes, YAML preservation, structural
operations, DOI normalization, cross-document parsing, and the complete action
map. Rust integration coverage owns real cookie/CSRF/ACL behavior, asset
metadata disclosure, input limits, and refusal of private or credentialed link
destinations. The browser gate owns responsive inspector placement and the
human command path and, in an enabled agent-chat build, the agent command path.
It must not characterize a successful build or a
mock provider as proof of an external OpenAI, Crossref, or arbitrary public-link
transaction; those are separate opt-in live checks.
