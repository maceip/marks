export type ServiceApi = typeof import('./api.ts');

let loaded: Promise<ServiceApi> | undefined;

/**
 * One lazy ownership boundary for the remote metadata plane. Local-first
 * startup never needs to parse HTTP/auth request code; service callers share
 * the same module promise when they do cross that boundary.
 */
export function loadServiceApi(): Promise<ServiceApi> {
  loaded ??= import('./api.ts');
  return loaded;
}
