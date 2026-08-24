import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { resetServiceCallerForTests, setActiveCaller } from '../auth/caller.ts';
import { cacheSession } from '../auth/session-cache.ts';
import {
  AgentGatewayError,
  createHostedAgentRun,
  parseEventStream,
  streamHostedAgentRun,
} from './gateway.ts';

const originalLocation = globalThis.location;

beforeEach(() => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL('https://marks.test/d/doc_1'),
  });
  setActiveCaller({ kind: 'session' });
  cacheSession({ principalId: 'p_1', deviceId: 'd_1', sessionId: 's_1', csrf: 'csrf-value' }, null);
});

afterEach(() => {
  resetServiceCallerForTests();
  Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation });
});

function stream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

test('SSE parser handles split frames, comments, and multiline JSON', async () => {
  const body = stream([
    ': heartbeat\r\nid: 1\r\nevent: run.started\r\ndata: {"runId":"run_1",\r\n',
    'data: "documentId":"doc_1","status":"running","createdAtMs":1}\r\n\r\n',
    'id: 2\nevent: run.completed\ndata: {"status":"completed","outputText":"Done","usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}\n\n',
  ]);
  const events = [];
  for await (const event of parseEventStream(body)) events.push(event);
  assert.deepEqual(events.map((event) => [event.id, event.event.type]), [
    ['1', 'run.started'],
    ['2', 'run.completed'],
  ]);
});

test('hosted run creation sends session CSRF and rejects off-origin event URLs', async () => {
  let captured: RequestInit | undefined;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    captured = init;
    return new Response(JSON.stringify({
      runId: 'run_1',
      status: 'queued',
      eventsUrl: 'https://evil.test/v1/agent/runs/run_1/events',
      createdAtMs: 1,
      expiresAtMs: 2,
      replayed: false,
    }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  await assert.rejects(
    createHostedAgentRun({
      requestId: 'request_1',
      documentId: 'doc_1',
      prompt: 'Show preview',
      tools: [],
    }, fetchImpl),
    (error: unknown) => error instanceof AgentGatewayError && error.code === 'invalid_response',
  );
  const headers = new Headers(captured?.headers);
  assert.equal(headers.get('X-Marks-CSRF'), 'csrf-value');
  assert.equal(captured?.credentials, 'same-origin');
});

test('stream resumes after a known event ID and never replays a browser tool call', async () => {
  const response = new Response(stream([
    'id: 7\nevent: tool.call\ndata: {"callId":"call_1","commandId":"format.bold","name":"marks_format_bold","arguments":{},"effect":"write","durability":"document"}\n\n',
    'id: 8\nevent: run.completed\ndata: {"status":"completed","outputText":"Done","usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}\n\n',
  ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  let requested = '';
  const fetchImpl = (async (input: string | URL | Request) => {
    requested = String(input);
    return response;
  }) as typeof fetch;
  const seen: string[] = [];
  await streamHostedAgentRun('/v1/agent/runs/run_1/events', {
    signal: new AbortController().signal,
    after: '7',
    fetch: fetchImpl,
    onEvent: async ({ id }) => {
      seen.push(id);
      await Promise.resolve();
    },
  });
  assert.match(requested, /after=7/u);
  assert.deepEqual(seen, ['8']);
});

test('SSE parser fails closed on unknown events and nonnumeric IDs', async () => {
  const unknown = stream(['id: 1\nevent: provider.secret\ndata: {}\n\n']);
  await assert.rejects(async () => {
    for await (const _event of parseEventStream(unknown)) { /* consume */ }
  }, AgentGatewayError);
  const badId = stream(['id: ../1\nevent: run.cancelled\ndata: {"status":"cancelled"}\n\n']);
  await assert.rejects(async () => {
    for await (const _event of parseEventStream(badId)) { /* consume */ }
  }, AgentGatewayError);
});

