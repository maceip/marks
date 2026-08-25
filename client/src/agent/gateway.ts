import { ensureServiceCaller } from '../auth/caller.ts';
import { getCachedSession } from '../auth/session-cache.ts';
import {
  fetchWithTimeout,
  runWithTimeout,
  SERVICE_REQUEST_TIMEOUT_MS,
} from '../browser/network.ts';
import type {
  CreateHostedAgentRun,
  HostedAgentCancelResult,
  HostedAgentCapabilities,
  HostedAgentEventEnvelope,
  HostedAgentRunAccepted,
  HostedAgentRunEvent,
  HostedAgentToolResult,
  HostedAgentToolResultAccepted,
} from './types.ts';

const MAX_EVENT_BYTES = 128 * 1024;
const MAX_RECONNECT_DELAY_MS = 5_000;
export const AGENT_EVENT_INACTIVITY_TIMEOUT_MS = 35_000;
const TERMINAL_EVENTS = new Set<HostedAgentRunEvent['type']>([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export class AgentGatewayError extends Error {
  readonly status: number;
  readonly code:
    | 'unavailable'
    | 'unauthenticated'
    | 'forbidden'
    | 'conflict'
    | 'rate_limited'
    | 'invalid_response'
    | 'network';

  constructor(
    status: number,
    code:
      | 'unavailable'
      | 'unauthenticated'
      | 'forbidden'
      | 'conflict'
      | 'rate_limited'
      | 'invalid_response'
      | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'AgentGatewayError';
    this.status = status;
    this.code = code;
  }
}

export interface AgentGatewayRequestOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal | null;
  timeoutMs?: number;
}

class EventConsumerError {
  readonly cause: unknown;

  constructor(cause: unknown) {
    this.cause = cause;
  }
}

export async function getHostedAgentCapabilities(
  input: typeof fetch | AgentGatewayRequestOptions = {},
): Promise<HostedAgentCapabilities> {
  const options = requestOptions(input);
  const response = await sessionRequest(
    '/v1/agent/capabilities',
    { method: 'GET', signal: options.signal },
    { ...options, csrf: false },
  );
  return parseCapabilities(await response.json().catch(() => null));
}

export async function createHostedAgentRun(
  request: CreateHostedAgentRun,
  input: typeof fetch | AgentGatewayRequestOptions = {},
): Promise<HostedAgentRunAccepted> {
  const options = requestOptions(input);
  const response = await sessionRequest(
    '/v1/agent/runs',
    { method: 'POST', body: JSON.stringify(request), signal: options.signal },
    { ...options, csrf: true },
  );
  return parseAccepted(await response.json().catch(() => null));
}

export async function submitHostedAgentToolResult(
  runId: string,
  result: HostedAgentToolResult,
  input: typeof fetch | AgentGatewayRequestOptions = {},
): Promise<HostedAgentToolResultAccepted> {
  const options = requestOptions(input);
  const response = await sessionRequest(
    `/v1/agent/runs/${encodeURIComponent(runId)}/tool-results`,
    { method: 'POST', body: JSON.stringify(result), signal: options.signal },
    { ...options, csrf: true },
  );
  const body = await response.json().catch(() => null);
  if (
    !isRecord(body) ||
    typeof body.runId !== 'string' ||
    typeof body.callId !== 'string' ||
    body.accepted !== true ||
    typeof body.replayed !== 'boolean'
  ) throw invalidResponse();
  return {
    runId: body.runId,
    callId: body.callId,
    accepted: true,
    replayed: body.replayed,
  };
}

export async function cancelHostedAgentRun(
  runId: string,
  input: typeof fetch | AgentGatewayRequestOptions = {},
): Promise<HostedAgentCancelResult> {
  const options = requestOptions(input);
  const response = await sessionRequest(
    `/v1/agent/runs/${encodeURIComponent(runId)}`,
    { method: 'DELETE', signal: options.signal },
    { ...options, csrf: true },
  );
  const body = await response.json().catch(() => null);
  if (
    !isRecord(body) ||
    typeof body.runId !== 'string' ||
    body.status !== 'cancelled' ||
    typeof body.replayed !== 'boolean'
  ) throw invalidResponse();
  return { runId: body.runId, status: 'cancelled', replayed: body.replayed };
}

/**
 * Consume the normalized Marks SSE stream. Reconnect starts strictly after
 * the latest accepted event ID, so a broken connection cannot duplicate a
 * browser command. The callback is awaited to serialize browser tool work.
 */
export async function streamHostedAgentRun(
  eventsUrl: string,
  options: {
    signal: AbortSignal;
    onEvent: (event: HostedAgentEventEnvelope) => void | Promise<void>;
    fetch?: typeof fetch;
    after?: string;
    requestTimeoutMs?: number;
    inactivityTimeoutMs?: number;
  },
): Promise<void> {
  assertSameOriginAgentUrl(eventsUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let after = options.after ?? '';
  let reconnectDelay = 400;

  while (!options.signal.aborted) {
    const url = new URL(eventsUrl, location.origin);
    if (after) url.searchParams.set('after', after);
    let response: Response;
    try {
      response = await sessionRequest(
        url.pathname + url.search,
        {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            ...(after ? { 'Last-Event-ID': after } : {}),
          },
          signal: options.signal,
        },
        {
          fetch: fetchImpl,
          signal: options.signal,
          timeoutMs: options.requestTimeoutMs,
          csrf: false,
          stream: true,
        },
      );
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof AgentGatewayError && error.status > 0 && error.status < 500) throw error;
      await abortableDelay(reconnectDelay, options.signal);
      reconnectDelay = Math.min(MAX_RECONNECT_DELAY_MS, reconnectDelay * 2);
      continue;
    }

    if (!response.body || !response.headers.get('Content-Type')?.toLowerCase().startsWith('text/event-stream')) {
      throw invalidResponse();
    }
    let terminal = false;
    try {
      for await (const envelope of parseEventStream(
        response.body,
        options.signal,
        options.inactivityTimeoutMs,
      )) {
        if (after && compareEventIds(envelope.id, after) <= 0) continue;
        after = envelope.id;
        try {
          await options.onEvent(envelope);
        } catch (error) {
          throw new EventConsumerError(error);
        }
        if (TERMINAL_EVENTS.has(envelope.event.type)) {
          terminal = true;
          break;
        }
      }
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof EventConsumerError) throw error.cause;
      if (error instanceof AgentGatewayError && error.code === 'invalid_response') throw error;
      // A truncated response is reconnectable because `after` is advanced
      // only for completely parsed, successfully handled semantic events.
    }
    if (terminal || options.signal.aborted) return;
    await abortableDelay(reconnectDelay, options.signal);
    reconnectDelay = Math.min(MAX_RECONNECT_DELAY_MS, reconnectDelay * 2);
  }
}

export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  inactivityTimeoutMs = AGENT_EVENT_INACTIVITY_TIMEOUT_MS,
): AsyncGenerator<HostedAgentEventEnvelope> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  try {
    while (!signal?.aborted) {
      const { value, done } = await runWithTimeout(
        async (readSignal) => {
          const cancel = () => { void reader.cancel(readSignal.reason).catch(() => undefined); };
          readSignal.addEventListener('abort', cancel, { once: true });
          try {
            return await reader.read();
          } finally {
            readSignal.removeEventListener('abort', cancel);
          }
        },
        inactivityTimeoutMs,
        signal,
        new DOMException('The agent event stream stopped responding.', 'TimeoutError'),
      );
      buffer += decoder.decode(value, { stream: !done });
      if (encoder.encode(buffer).byteLength > MAX_EVENT_BYTES && !eventBoundary(buffer)) {
        throw invalidResponse('Agent event exceeded its size limit.');
      }
      let boundary = eventBoundary(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
        boundary = eventBoundary(buffer);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const parsed = parseFrame(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function sessionRequest(
  path: string,
  init: RequestInit,
  options: AgentGatewayRequestOptions & { csrf: boolean; stream?: boolean },
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? SERVICE_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeout = new DOMException('The agent service request timed out.', 'TimeoutError');
  try {
    return await runWithTimeout(
      async (signal) => {
        const deadline = Date.now() + timeoutMs;
        let refreshed = false;
        for (;;) {
          const caller = await ensureServiceCaller({ fetch: fetchImpl, forceProbe: refreshed });
          if (signal.aborted) throw signal.reason;
          if (caller.kind !== 'session') {
            throw new AgentGatewayError(
              401,
              'unauthenticated',
              'Hosted agents require a logged-in workspace.',
            );
          }
          let session = getCachedSession();
          if (!session) {
            await ensureServiceCaller({ fetch: fetchImpl, forceProbe: true });
            if (signal.aborted) throw signal.reason;
            session = getCachedSession();
          }
          if (options.csrf && !session) {
            throw new AgentGatewayError(401, 'unauthenticated', 'The current session could not be verified.');
          }
          const headers = new Headers(init.headers);
          if (!headers.has('Accept')) headers.set('Accept', 'application/json');
          if (init.body) headers.set('Content-Type', 'application/json');
          if (options.csrf && session) headers.set('X-Marks-CSRF', session.csrf);
          let response: Response;
          try {
            const request = { ...init, signal, headers, credentials: 'same-origin' } satisfies RequestInit;
            response = options.stream
              ? await runWithTimeout(
                  (requestSignal) => fetchImpl(path, { ...request, signal: requestSignal }),
                  Math.max(1, deadline - Date.now()),
                  signal,
                  timeout,
                )
              : await fetchWithTimeout(
                  path,
                  request,
                  Math.max(1, deadline - Date.now()),
                  fetchImpl,
                );
          } catch (error) {
            if (signal.aborted) throw error;
            throw new AgentGatewayError(0, 'network', 'The agent service could not be reached.');
          }
          if (
            (response.status === 401 || (options.csrf && response.status === 403)) &&
            !refreshed
          ) {
            refreshed = true;
            continue;
          }
          if (!response.ok) throw gatewayHttpError(response.status);
          return response;
        }
      },
      timeoutMs,
      options.signal ?? init.signal,
      timeout,
    );
  } catch (error) {
    if (options.signal?.aborted || init.signal?.aborted) throw error;
    if (error === timeout || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new AgentGatewayError(0, 'network', 'The agent service took too long to respond.');
    }
    throw error;
  }
}

function requestOptions(
  input: typeof fetch | AgentGatewayRequestOptions,
): AgentGatewayRequestOptions {
  return typeof input === 'function' ? { fetch: input } : input;
}

function parseFrame(frame: string): HostedAgentEventEnvelope | null {
  let id = '';
  let eventName = '';
  const data: string[] = [];
  for (const rawLine of frame.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') eventName = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  if (!/^\d+$/u.test(id)) throw invalidResponse('Agent events require monotonic numeric IDs.');
  if (!eventName) throw invalidResponse('Agent events require an explicit event type.');
  const serialized = data.join('\n');
  if (new TextEncoder().encode(serialized).byteLength > MAX_EVENT_BYTES) {
    throw invalidResponse('Agent event exceeded its size limit.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw invalidResponse();
  }
  return { id, event: parseRunEvent(eventName, decoded) };
}

function parseRunEvent(eventName: string, value: unknown): HostedAgentRunEvent {
  if (!isRecord(value) || 'type' in value) throw invalidResponse();
  switch (eventName) {
    case 'run.started':
      if (
        typeof value.runId !== 'string' ||
        typeof value.documentId !== 'string' ||
        value.status !== 'running' ||
        !isNonNegativeInteger(value.createdAtMs)
      ) throw invalidResponse();
      return {
        type: eventName,
        runId: value.runId,
        documentId: value.documentId,
        status: 'running',
        createdAtMs: value.createdAtMs as number,
      };
    case 'assistant.delta':
      if (typeof value.text !== 'string') throw invalidResponse();
      return { type: eventName, text: value.text };
    case 'tool.call':
      if (
        typeof value.callId !== 'string' ||
        typeof value.commandId !== 'string' ||
        typeof value.name !== 'string' ||
        !isRecord(value.arguments) ||
        !isOneOf(value.effect, ['read', 'write', 'destructive']) ||
        !isOneOf(value.durability, ['ephemeral', 'document', 'external'])
      ) throw invalidResponse();
      return {
        type: eventName,
        callId: value.callId,
        commandId: value.commandId,
        name: value.name,
        arguments: value.arguments,
        effect: value.effect,
        durability: value.durability,
      };
    case 'tool.result.accepted':
      if (
        typeof value.callId !== 'string' ||
        !isOneOf(value.status, ['succeeded', 'failed', 'cancelled'])
      ) throw invalidResponse();
      return { type: eventName, callId: value.callId, status: value.status };
    case 'run.completed':
      if (
        value.status !== 'completed' ||
        typeof value.outputText !== 'string' ||
        !isRecord(value.usage) ||
        ![
          value.usage.inputTokens,
          value.usage.outputTokens,
          value.usage.totalTokens,
        ].every(isNonNegativeInteger)
      ) throw invalidResponse();
      return {
        type: eventName,
        status: 'completed',
        outputText: value.outputText,
        usage: {
          inputTokens: value.usage.inputTokens as number,
          outputTokens: value.usage.outputTokens as number,
          totalTokens: value.usage.totalTokens as number,
        },
      };
    case 'run.failed':
      if (value.status !== 'failed' || typeof value.code !== 'string') throw invalidResponse();
      return { type: eventName, status: 'failed', code: value.code };
    case 'run.cancelled':
      if (value.status !== 'cancelled') throw invalidResponse();
      return { type: eventName, status: 'cancelled' };
    default:
      throw invalidResponse();
  }
}

function parseCapabilities(value: unknown): HostedAgentCapabilities {
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    value.protocolVersion !== 1 ||
    !(value.provider === 'openai' || value.provider === null) ||
    !isRecord(value.limits) ||
    !isRecord(value.features)
  ) throw invalidResponse();
  if ((value.enabled && value.provider !== 'openai') || (!value.enabled && value.provider !== null)) {
    throw invalidResponse();
  }
  const limits = value.limits;
  if (![
    limits.maxPromptBytes,
    limits.maxTools,
    limits.maxSchemaBytes,
    limits.maxToolResultBytes,
    limits.maxOutputTokens,
    limits.maxRunMs,
    limits.maxConcurrentRunsPerSession,
  ].every(isPositiveInteger)) throw invalidResponse();
  const features = value.features;
  if (![
    features.sseReplay,
    features.toolResults,
    features.cancellation,
    features.webMcp,
  ].every((feature) => typeof feature === 'boolean')) throw invalidResponse();
  return {
    enabled: value.enabled,
    protocolVersion: 1,
    provider: value.provider,
    limits: {
      maxPromptBytes: limits.maxPromptBytes as number,
      maxTools: limits.maxTools as number,
      maxSchemaBytes: limits.maxSchemaBytes as number,
      maxToolResultBytes: limits.maxToolResultBytes as number,
      maxOutputTokens: limits.maxOutputTokens as number,
      maxRunMs: limits.maxRunMs as number,
      maxConcurrentRunsPerSession: limits.maxConcurrentRunsPerSession as number,
    },
    features: {
      sseReplay: features.sseReplay as boolean,
      toolResults: features.toolResults as boolean,
      cancellation: features.cancellation as boolean,
      webMcp: features.webMcp as boolean,
    },
  };
}

function parseAccepted(value: unknown): HostedAgentRunAccepted {
  if (
    !isRecord(value) ||
    typeof value.runId !== 'string' ||
    !isOneOf(value.status, ['queued', 'running', 'waitingForTool', 'completed', 'failed', 'cancelled']) ||
    typeof value.eventsUrl !== 'string' ||
    !isNonNegativeInteger(value.createdAtMs) ||
    !isNonNegativeInteger(value.expiresAtMs) ||
    typeof value.replayed !== 'boolean'
  ) throw invalidResponse();
  assertSameOriginAgentUrl(value.eventsUrl);
  return {
    runId: value.runId,
    status: value.status,
    eventsUrl: value.eventsUrl,
    createdAtMs: value.createdAtMs as number,
    expiresAtMs: value.expiresAtMs as number,
    replayed: value.replayed,
  };
}

function assertSameOriginAgentUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value, location.origin);
  } catch {
    throw invalidResponse();
  }
  if (
    url.origin !== location.origin ||
    !/^\/v1\/agent\/runs\/[A-Za-z0-9_-]+\/events$/u.test(url.pathname)
  ) throw invalidResponse('The agent service returned an unsafe event URL.');
}

function eventBoundary(value: string): { index: number; length: number } | null {
  const lf = value.indexOf('\n\n');
  const crlf = value.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function compareEventIds(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function gatewayHttpError(status: number): AgentGatewayError {
  if (status === 401) {
    return new AgentGatewayError(status, 'unauthenticated', 'Hosted agents require a current signed-in session.');
  }
  if (status === 403 || status === 404) {
    return new AgentGatewayError(status, 'forbidden', 'This agent run is not available to the current session.');
  }
  if (status === 409) {
    return new AgentGatewayError(status, 'conflict', 'The agent request conflicted with an existing receipt.');
  }
  if (status === 429) {
    return new AgentGatewayError(status, 'rate_limited', 'The hosted agent limit has been reached.');
  }
  if (status === 503) {
    return new AgentGatewayError(status, 'unavailable', 'No hosted agent provider is currently available.');
  }
  return new AgentGatewayError(status, 'unavailable', 'The hosted agent service could not complete this request.');
}

function invalidResponse(message = 'The agent service returned an invalid response.'): AgentGatewayError {
  return new AgentGatewayError(502, 'invalid_response', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(finish, ms);
    function finish() {
      signal.removeEventListener('abort', finish);
      globalThis.clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}
