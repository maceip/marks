/**
 * Presence store. Not in the ESBT paper — marks needs it for avatars and
 * remote cursors. Values are JSON-cloneable. Entries expire after `ttlMs`
 * without a local or remote refresh.
 */
export interface EphemeralStore {
  set(key: string, value: unknown): void;
  get(key: string): unknown;
  delete(key: string): void;
  getAllStates(): Record<string, unknown>;

  /** Encode every live entry. Sent on socket open and on local change. */
  encodeAll(): Uint8Array;
  /** Merge remote presence. Unknown keys are added; expired keys dropped. */
  apply(bytes: Uint8Array): void;

  subscribe(listener: () => void): () => void;
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void;
  destroy(): void;
}

export interface EphemeralStoreStatic {
  /**
   * @param ttlMs - marks uses 30_000. An entry not refreshed in that window
   *   disappears from `getAllStates`.
   */
  new (ttlMs: number): EphemeralStore;
}
