import type { CommandId, CommandReceipt } from '../commands/types.ts';

const VERSION = 1;
const MAX_CALLS = 8;
const MAX_DETAIL_CHARS = 1_024;

export interface StoredHostedToolCall {
  callId: string;
  requestId: string;
  commandId: CommandId;
  state: 'executing' | 'terminal';
  status?: CommandReceipt['status'];
  message?: string;
  error?: string;
}

export interface ActiveHostedRunRecord {
  version: 1;
  documentId: string;
  runId: string;
  requestId: string;
  eventsUrl: string;
  expiresAtMs: number;
  lastEventId: string;
  calls: StoredHostedToolCall[];
}

function key(documentId: string): string {
  return `marks:hosted-agent-run:v${VERSION}:${encodeURIComponent(documentId)}`;
}

function defaultStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readActiveHostedRun(
  documentId: string,
  storage: Storage | null = defaultStorage(),
  now = Date.now(),
): ActiveHostedRunRecord | null {
  if (!storage) return null;
  let parsed: unknown;
  try {
    const raw = storage.getItem(key(documentId));
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    storage.removeItem(key(documentId));
    return null;
  }
  const record = validateRecord(parsed, documentId);
  if (!record || record.expiresAtMs <= now) {
    storage.removeItem(key(documentId));
    return null;
  }
  return record;
}

export function writeActiveHostedRun(
  record: ActiveHostedRunRecord,
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) return;
  const bounded: ActiveHostedRunRecord = {
    ...record,
    calls: record.calls.slice(-MAX_CALLS).map((call) => ({
      ...call,
      message: call.message?.slice(0, MAX_DETAIL_CHARS),
      error: call.error?.slice(0, MAX_DETAIL_CHARS),
    })),
  };
  storage.setItem(key(record.documentId), JSON.stringify(bounded));
}

export function clearActiveHostedRun(
  documentId: string,
  storage: Storage | null = defaultStorage(),
): void {
  storage?.removeItem(key(documentId));
}

function validateRecord(value: unknown, expectedDocumentId: string): ActiveHostedRunRecord | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== VERSION ||
    value.documentId !== expectedDocumentId ||
    !boundedId(value.runId) ||
    !boundedId(value.requestId) ||
    typeof value.eventsUrl !== 'string' ||
    value.eventsUrl.length > 512 ||
    typeof value.expiresAtMs !== 'number' ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    typeof value.lastEventId !== 'string' ||
    !/^\d*$/u.test(value.lastEventId) ||
    !Array.isArray(value.calls) ||
    value.calls.length > MAX_CALLS
  ) return null;
  const calls: StoredHostedToolCall[] = [];
  for (const candidate of value.calls) {
    if (!isRecord(candidate)) return null;
    if (
      !boundedId(candidate.callId) ||
      !boundedId(candidate.requestId) ||
      !boundedId(candidate.commandId) ||
      !(candidate.state === 'executing' || candidate.state === 'terminal') ||
      (candidate.status !== undefined && !isStatus(candidate.status)) ||
      (candidate.state === 'terminal' && !isStatus(candidate.status)) ||
      !optionalBoundedString(candidate.message) ||
      !optionalBoundedString(candidate.error)
    ) return null;
    const call: StoredHostedToolCall = {
      callId: candidate.callId,
      requestId: candidate.requestId,
      commandId: candidate.commandId,
      state: candidate.state,
      status: candidate.status,
    };
    if (candidate.message !== undefined) call.message = candidate.message;
    if (candidate.error !== undefined) call.error = candidate.error;
    calls.push(call);
  }
  return {
    version: 1,
    documentId: value.documentId,
    runId: value.runId,
    requestId: value.requestId,
    eventsUrl: value.eventsUrl,
    expiresAtMs: value.expiresAtMs,
    lastEventId: value.lastEventId,
    calls,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

function optionalBoundedString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_DETAIL_CHARS);
}

function isStatus(value: unknown): value is CommandReceipt['status'] {
  return value === 'succeeded' || value === 'failed' || value === 'cancelled';
}

