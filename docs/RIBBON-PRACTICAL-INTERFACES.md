# Ribbon practical: protected interface changes

The practical ribbon stream is stacked on `codex/ribbon-core`. Core deliberately
left the Rust server, SQLite schema, authentication protocol, collaboration
engine, ESBT artifacts, and deployment files unchanged. This document records
every exception introduced by practical capabilities and the reason it exists.

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

The gateway is disabled by default. When disabled—or while offline—the local
planner remains the pill's available provider. The capabilities response sets
`webMcp: false`: the in-page command registry is the authoritative tool surface
for this implementation, and no external WebMCP authority is implied.

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
