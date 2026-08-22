import type { DocumentAccessProvider, RoomTicket } from '../collab/types';
import { decodeBase64Url, OPAQUE_ID_PATTERN } from './protocol.ts';
import type { ScratchCredential } from './scratch.ts';

const ROOM_PATH_PREFIX = '/collab/';

export type RoomAuthority =
  | { kind: 'session' }
  | { kind: 'scratch'; credential: ScratchCredential };

export interface MarksDocumentAccessOptions {
  authority: () => RoomAuthority;
  origin?: string;
  fetch?: typeof globalThis.fetch;
}

interface TicketResponse {
  roomUrl: string;
  ticketId: string;
  ticketSecret: string;
}

export class RoomAccessError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'RoomAccessError';
    this.retryable = retryable;
  }
}

export function createMarksDocumentAccess(
  options: MarksDocumentAccessOptions,
): DocumentAccessProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const origin = options.origin ?? globalThis.location?.origin;
  if (!fetchImpl) throw new TypeError('fetch is unavailable');
  if (!origin) throw new TypeError('Marks origin is unavailable');

  return {
    fetchSnapshot(documentId, signal) {
      const authority = options.authority();
      return fetchImpl(
        `${documentPrefix(authority)}/${encodeURIComponent(documentId)}/snapshot?shallow=1`,
        {
          credentials: 'same-origin',
          headers: {
            Accept: 'application/octet-stream',
            ...authorityHeaders(authority),
          },
          signal,
        },
      );
    },

    async admit(documentId, siteId, signal) {
      const authority = options.authority();
      const prefix = documentPrefix(authority);
      let response: Response;
      try {
        response = await fetchImpl(`${prefix}/${encodeURIComponent(documentId)}/session`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...authorityHeaders(authority),
          },
          body: JSON.stringify({ siteId }),
          signal,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new RoomAccessError('room admission request failed', true);
      }

      if (!response.ok) {
        throw new RoomAccessError(
          `room admission was denied (${response.status})`,
          response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new RoomAccessError('room admission response was not JSON', false);
      }

      return validateTicketResponse(body, origin);
    },
  };
}

function documentPrefix(authority: RoomAuthority): string {
  return authority.kind === 'scratch' ? '/v1/scratch/documents' : '/v1/documents';
}

export function roomTicketProtocols(ticket: RoomTicket): [string, string] {
  if (!OPAQUE_ID_PATTERN.test(ticket.ticketId)) throw new RoomAccessError('invalid room ticket ID', false);
  assertTicketSecret(ticket.ticketSecret);
  return ['marks.esbt.v1', `marks.ticket.v1.${ticket.ticketId}.${ticket.ticketSecret}`];
}

function authorityHeaders(authority: RoomAuthority): Record<string, string> {
  if (authority.kind === 'session') return {};
  return {
    Authorization: `MarksScratch ${authority.credential.scratchId}.${authority.credential.capability}`,
  };
}

function validateTicketResponse(value: unknown, origin: string): RoomTicket {
  if (!isRecord(value)) throw new RoomAccessError('invalid room admission response', false);

  const { roomUrl, ticketId, ticketSecret } = value as Partial<TicketResponse>;
  if (typeof roomUrl !== 'string' || typeof ticketId !== 'string' || typeof ticketSecret !== 'string') {
    throw new RoomAccessError('invalid room admission response', false);
  }
  if (!OPAQUE_ID_PATTERN.test(ticketId)) throw new RoomAccessError('invalid room ticket ID', false);
  assertTicketSecret(ticketSecret);

  let expected: URL;
  let resolved: URL;
  try {
    expected = new URL(origin);
    resolved = new URL(roomUrl, expected);
  } catch {
    throw new RoomAccessError('invalid room URL', false);
  }

  if (resolved.protocol === 'http:') resolved.protocol = 'ws:';
  if (resolved.protocol === 'https:') resolved.protocol = 'wss:';
  const requiredProtocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
  if (
    resolved.protocol !== requiredProtocol ||
    resolved.host !== expected.host ||
    resolved.username !== '' ||
    resolved.password !== '' ||
    resolved.hash !== '' ||
    resolved.search !== '' ||
    !resolved.pathname.startsWith(ROOM_PATH_PREFIX)
  ) {
    throw new RoomAccessError('room URL is outside the Marks transport boundary', false);
  }

  return { roomUrl: resolved.href, ticketId, ticketSecret };
}

function assertTicketSecret(value: string): void {
  try {
    if (decodeBase64Url(value).byteLength !== 32) throw new Error('wrong length');
  } catch {
    throw new RoomAccessError('invalid room ticket secret', false);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
