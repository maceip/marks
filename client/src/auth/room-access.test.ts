import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RoomAccessError,
  createMarksDocumentAccess,
  roomTicketProtocols,
} from './room-access.ts';
import { encodeBase64Url } from './protocol.ts';

const ticketSecret = encodeBase64Url(new Uint8Array(32).fill(9));
const displayIdentity = { participantId: 'principal_1234', displayName: 'Member 1234', avatar: null };

test('session admission mints a ticket and keeps it out of the room URL', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const access = createMarksDocumentAccess({
    authority: () => ({ kind: 'session' }),
    origin: 'https://marks.example',
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json({
        roomUrl: '/collab/esbt/document_1234',
        ticketId: 'ticket_123456',
        ticketSecret,
        role: 'editor',
        siteId: '2',
        displayIdentity,
      });
    },
  });

  const ticket = await access.admit('document_1234', '2', new AbortController().signal);
  assert.deepEqual(ticket, {
    roomUrl: 'wss://marks.example/collab/esbt/document_1234',
    ticketId: 'ticket_123456',
    ticketSecret,
    siteId: '2',
    role: 'editor',
    authority: 'session',
    displayIdentity,
  });
  assert.equal(calls[0].input, '/v1/documents/document_1234/session');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.credentials, 'same-origin');
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), null);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { siteId: '2' });
  assert.deepEqual(roomTicketProtocols(ticket), [
    'marks.esbt.v2',
    `marks.ticket.v1.ticket_123456.${ticketSecret}`,
  ]);
  assert.doesNotMatch(ticket.roomUrl, /ticket|secret/iu);
});

test('scratch authority is explicit on snapshot and admission requests', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const capability = encodeBase64Url(new Uint8Array(32).fill(7));
  const access = createMarksDocumentAccess({
    authority: () => ({
      kind: 'scratch',
      credential: {
        version: 1,
        scratchId: 'scratch_123456',
        capability,
        expiresAtMs: 50_000,
      },
    }),
    origin: 'http://localhost:5173',
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      if (String(input).includes('snapshot')) return new Response(null, { status: 204 });
      return Response.json({
        roomUrl: '/collab/esbt/document_1234',
        ticketId: 'ticket_123456',
        ticketSecret,
        role: null,
        siteId: '3',
        displayIdentity,
      });
    },
  });

  await access.fetchSnapshot('document_1234', new AbortController().signal);
  const ticket = await access.admit('document_1234', '3', new AbortController().signal);

  assert.equal(calls[0].input, '/v1/scratch/documents/document_1234/snapshot?shallow=1');
  assert.equal(calls[1].input, '/v1/scratch/documents/document_1234/session');
  for (const call of calls) {
    assert.equal(
      new Headers(call.init?.headers).get('Authorization'),
      `MarksScratch scratch_123456.${capability}`,
    );
  }
  assert.equal(ticket.roomUrl, 'ws://localhost:5173/collab/esbt/document_1234');
});

test('a scratch visitor accepts the public editor role without becoming an owner', async () => {
  const capability = encodeBase64Url(new Uint8Array(32).fill(7));
  const access = createMarksDocumentAccess({
    authority: () => ({
      kind: 'scratch',
      credential: {
        version: 1,
        scratchId: 'scratch_123456',
        capability,
        expiresAtMs: 50_000,
      },
    }),
    origin: 'https://marks.example',
    fetch: async () => Response.json({
      roomUrl: '/collab/esbt/document_1234',
      ticketId: 'ticket_public1234',
      ticketSecret,
      role: 'editor',
      siteId: '9',
      displayIdentity: { participantId: 'guest-public', displayName: 'Anonymous Otter' },
    }),
  });

  const ticket = await access.admit('document_1234', undefined, new AbortController().signal);
  assert.equal(ticket.authority, 'scratch');
  assert.equal(ticket.role, 'editor');
});

test('room admission rejects credential-bearing and cross-origin URLs', async () => {
  for (const roomUrl of [
    'wss://evil.example/collab/esbt/document_1234',
    '/collab/esbt/document_1234?ticket=leak',
    '/outside/document_1234',
  ]) {
    const access = createMarksDocumentAccess({
      authority: () => ({ kind: 'session' }),
      origin: 'https://marks.example',
      fetch: async () => Response.json({ roomUrl, ticketId: 'ticket_123456', ticketSecret, role: 'viewer', siteId: '2' }),
    });
    await assert.rejects(
      access.admit('document_1234', '2', new AbortController().signal),
      (error: unknown) => error instanceof RoomAccessError && error.retryable === false,
    );
  }
});

test('admission omits siteId when the replica has not been assigned one', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const access = createMarksDocumentAccess({
    authority: () => ({ kind: 'session' }),
    origin: 'https://marks.example',
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json({
        roomUrl: '/collab/esbt/document_1234',
        ticketId: 'ticket_123456',
        ticketSecret,
        role: 'owner',
        siteId: '4',
        displayIdentity,
      });
    },
  });
  const ticket = await access.admit('document_1234', undefined, new AbortController().signal);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {});
  assert.equal(ticket.siteId, '4');
});

test('admission rejects missing, unknown, or authority-incompatible roles', async () => {
  for (const [authority, role] of [
    [{ kind: 'session' } as const, null],
    [{ kind: 'session' } as const, 'admin'],
    [{
      kind: 'scratch' as const,
      credential: {
        version: 1 as const,
        scratchId: 'scratch_123456',
        capability: encodeBase64Url(new Uint8Array(32).fill(7)),
        expiresAtMs: 50_000,
      },
    }, 'viewer'],
  ] as const) {
    const access = createMarksDocumentAccess({
      authority: () => authority,
      origin: 'https://marks.example',
      fetch: async () => Response.json({
        roomUrl: '/collab/esbt/document_1234',
        ticketId: 'ticket_123456',
        ticketSecret,
        role,
        siteId: '2',
      }),
    });
    await assert.rejects(
      access.admit('document_1234', undefined, new AbortController().signal),
      (error: unknown) => error instanceof RoomAccessError && error.message === 'invalid room role',
    );
  }
});

test('only transient admission failures are retryable', async () => {
  const makeAccess = (status: number) =>
    createMarksDocumentAccess({
      authority: () => ({ kind: 'session' }),
      origin: 'https://marks.example',
      fetch: async () => new Response(null, { status }),
    });

  await assert.rejects(
    makeAccess(401).admit('document_1234', '2', new AbortController().signal),
    (error: unknown) => error instanceof RoomAccessError && error.retryable === false,
  );
  await assert.rejects(
    makeAccess(503).admit('document_1234', '2', new AbortController().signal),
    (error: unknown) => error instanceof RoomAccessError && error.retryable === true,
  );
});
