import profile from '../../../engine-profile.json' with { type: 'json' };
import type { DocumentConfigInput } from './wasm/esbt-document.ts';

/** One cross-language Marks policy; Rust loads the same checked-in JSON. */
export const MARKS_MAX_FRAME_BYTES = profile.max_frame_bytes;
export const MARKS_SERVER_COMPACT_OPERATIONS = profile.server_compact_operations;
export const JOURNAL_RETAINED_THRESHOLD = profile.client_prune_operations;
export const EDITOR_CHUNK_UNITS = profile.editor_chunk_units;
export const MARKS_MAX_DOCUMENT_UNITS = profile.limits.max_document_units;

export const MARKS_DOCUMENT_CONFIG: DocumentConfigInput = {
  strategy: { kind: 'midpoint' },
  adaptiveDmax: { floor: 16, ceiling: 2_147_483_648, window: 256, holdoffWindows: 4 },
  limits: {
    maxMessageBytes: profile.limits.max_message_bytes,
    maxOperationsPerUpdate: profile.limits.max_operations_per_update,
    maxIdentifierDepth: profile.limits.max_identifier_depth,
    maxVersionSites: profile.limits.max_version_sites,
    maxSparseReceipts: profile.limits.max_sparse_receipts,
    maxSnapshotItems: profile.limits.max_snapshot_items,
    maxPendingOperations: profile.limits.max_pending_operations,
    maxDeferredDeletes: profile.limits.max_deferred_deletes,
    maxDocumentUnits: profile.limits.max_document_units,
    maxAllocationAttempts: profile.limits.max_allocation_attempts,
    maxRetainedOperations: profile.limits.max_retained_operations,
    maxUndoTransactions: profile.limits.max_undo_transactions,
  },
};
