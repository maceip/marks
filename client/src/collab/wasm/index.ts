import { EsbtError } from './esbt-document.ts';
export { MARKS_DOCUMENT_CONFIG } from '../profile.ts';

export {
  DEFAULT_LIMITS,
  ESBT_WASM_URL,
  EsbtDocument,
  EsbtError,
  EsbtRuntime,
  encodeDocumentConfig,
  envelopeTag,
  normalizeSiteId,
} from './esbt-document.ts';
export type {
  ApplyReceipt,
  ChangeEvent,
  CreateDocumentOptions,
  DocumentConfigInput,
  SnapshotReceipt,
  TransactOptions,
} from './esbt-document.ts';

/** Typed engine failures the Marks client must handle, not retry blindly. */
export const ESBT_ERROR = {
  AllocationExhausted: 3,
  MalformedEncoding: 4,
  UnsupportedFormatVersion: 5,
  NonCanonicalEncoding: 6,
  MessageTooLarge: 7,
  TooManyOperations: 8,
  IdentifierTooDeep: 9,
  DocumentTooLarge: 15,
  SnapshotHasSequenceGaps: 18,
  MissingLocalHistory: 20,
  HistoryUnavailable: 21,
  TransactionAlreadyActive: 22,
  NoActiveTransaction: 23,
} as const;

const MARKS_SITE_MAX = 0xffff_ffff;

/** Widen a room-allocated u32 site into the engine's 128-bit hex form. */
export function marksSiteToEngine(site: string | number): string {
  const value = typeof site === 'number' ? BigInt(site) : parseMarksSite(site);
  if (value <= 0n || value > BigInt(MARKS_SITE_MAX)) {
    throw new TypeError('esbt: Marks site must be a nonzero u32');
  }
  return value.toString(16).padStart(32, '0');
}

/** Narrow an engine site back to the decimal u32 the room admission API uses. */
export function engineSiteToMarks(hex: string): string {
  const value = BigInt(`0x${hex}`);
  if (value <= 0n || value > BigInt(MARKS_SITE_MAX)) {
    throw new TypeError('esbt: engine site is outside the Marks u32 site space');
  }
  return value.toString(10);
}

export function parseMarksSite(site: string): bigint {
  if (!/^[1-9][0-9]*$/.test(site)) {
    throw new TypeError('esbt: Marks site must be a decimal u32 string');
  }
  return BigInt(site);
}

export function isEsbtError(error: unknown): error is EsbtError {
  return error instanceof EsbtError;
}

export function isHistoryUnavailable(error: unknown): boolean {
  return isEsbtError(error) && error.code === ESBT_ERROR.HistoryUnavailable;
}

export function isSnapshotRefusal(error: unknown): boolean {
  return (
    isEsbtError(error) &&
    (error.code === ESBT_ERROR.HistoryUnavailable ||
      error.code === ESBT_ERROR.MissingLocalHistory ||
      error.code === ESBT_ERROR.SnapshotHasSequenceGaps)
  );
}

export function isRefusedEdit(error: unknown): boolean {
  return (
    isEsbtError(error) &&
    (error.code === ESBT_ERROR.AllocationExhausted ||
      error.code === ESBT_ERROR.IdentifierTooDeep ||
      error.code === ESBT_ERROR.DocumentTooLarge)
  );
}

export function userMessageForError(error: EsbtError): string {
  switch (error.code) {
    case ESBT_ERROR.AllocationExhausted:
      return 'This position cannot accept another character. Try inserting nearby.';
    case ESBT_ERROR.MessageTooLarge:
      return 'That change is too large for one update. Split the paste and try again.';
    case ESBT_ERROR.IdentifierTooDeep:
      return 'This position is too deep to edit. Insert in the adjacent paragraph instead.';
    case ESBT_ERROR.DocumentTooLarge:
      return 'This document has reached the size ceiling.';
    case ESBT_ERROR.MissingLocalHistory:
      return 'A newer snapshot is required before this replica can catch up.';
    case ESBT_ERROR.SnapshotHasSequenceGaps:
      return 'The offered snapshot is not a valid base. Request one from a caught-up peer.';
    case ESBT_ERROR.HistoryUnavailable:
      return 'History below this replica’s floor is gone; a snapshot is required.';
    default:
      return 'The collaboration engine rejected that change.';
  }
}

/** Export a reconnect delta, falling back to a compact snapshot at the history floor. */
export function exportReconnectPayload(
  doc: {
    exportUpdate(version?: Uint8Array): Uint8Array;
    exportCompactSnapshot(): Uint8Array;
  },
  remoteVersion: Uint8Array,
): { kind: 'update' | 'snapshot'; bytes: Uint8Array } {
  try {
    return { kind: 'update', bytes: doc.exportUpdate(remoteVersion) };
  } catch (error) {
    if (isHistoryUnavailable(error)) {
      return { kind: 'snapshot', bytes: doc.exportCompactSnapshot() };
    }
    throw error;
  }
}
