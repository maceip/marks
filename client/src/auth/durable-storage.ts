/**
 * Ask the browser to exempt this origin's storage bucket — the IndexedDB
 * device keys included — from automatic eviction. Chrome auto-grants on
 * engagement, install, or notification permission; WebKit keys off Home
 * Screen installation; Safari's seven-day script-writable-storage eviction
 * skips persistent origins entirely. Durability is requested at the moment a
 * workspace becomes durable, never demanded: a denied request changes
 * nothing, and the request may be repeated later.
 */
export async function requestDurableStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage?.persist) return false;
    if (storage.persisted && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}

/** Current persistence state, for honest chrome. Never throws. */
export async function storagePersisted(): Promise<boolean> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage?.persisted) return false;
    return await storage.persisted();
  } catch {
    return false;
  }
}
