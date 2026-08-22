import type { RoomAuthority } from './room-access.ts';
import {
  clearScratchCredential,
  loadScratchCredential,
  saveScratchCredential,
  type ScratchCredential,
} from './scratch.ts';

export type ServiceCaller = RoomAuthority;

let cached: ServiceCaller | null = null;
let inflight: Promise<ServiceCaller> | null = null;

export interface ResolveCallerInput {
  sessionLive: boolean;
  scratch?: ScratchCredential;
}

/**
 * Live rotating session wins. Leftover tab-scoped scratch is never a person
 * and must not hide a durable principal cookie.
 */
export function resolveServiceCaller(input: ResolveCallerInput): ServiceCaller | { kind: 'none' } {
  if (input.sessionLive) return { kind: 'session' };
  if (input.scratch) return { kind: 'scratch', credential: input.scratch };
  return { kind: 'none' };
}

/** Session authority is the HTTP-only cookie. Scratch is an explicit header. */
export function applyServiceCallerHeaders(headers: Headers, caller: ServiceCaller): void {
  headers.delete('Authorization');
  if (caller.kind === 'scratch') {
    headers.set(
      'Authorization',
      `MarksScratch ${caller.credential.scratchId}.${caller.credential.capability}`,
    );
  }
}

export function getActiveCaller(): ServiceCaller | null {
  return cached;
}

export function resetServiceCallerForTests(): void {
  cached = null;
  inflight = null;
}

export interface EnsureServiceCallerOptions {
  fetch?: typeof fetch;
  storage?: Storage;
  forceProbe?: boolean;
}

export async function ensureServiceCaller(
  options: EnsureServiceCallerOptions = {},
): Promise<ServiceCaller> {
  if (cached && !options.forceProbe) return cached;
  if (inflight && !options.forceProbe) return inflight;

  inflight = resolveFromNetwork(options);
  try {
    const next = await inflight;
    cached = next;
    return next;
  } finally {
    inflight = null;
  }
}

async function resolveFromNetwork(options: EnsureServiceCallerOptions): Promise<ServiceCaller> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const storage = options.storage ?? sessionStorage;

  const session = await fetchImpl('/v1/auth/session', { credentials: 'same-origin' });
  if (session.ok) {
    clearScratchCredential(storage);
    return { kind: 'session' };
  }

  const existing = loadScratchCredential(storage);
  if (existing) return { kind: 'scratch', credential: existing };

  const created = await fetchImpl('/v1/auth/scratch', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!created.ok) {
    throw new Error(`POST /v1/auth/scratch failed: ${created.status}`);
  }

  const body = (await created.json()) as {
    scratchId?: unknown;
    capability?: unknown;
    expiresAtMs?: unknown;
  };
  const credential: ScratchCredential = {
    version: 1,
    scratchId: typeof body.scratchId === 'string' ? body.scratchId : '',
    capability: typeof body.capability === 'string' ? body.capability : '',
    expiresAtMs: typeof body.expiresAtMs === 'number' ? body.expiresAtMs : 0,
  };
  saveScratchCredential(storage, credential);
  return { kind: 'scratch', credential };
}
