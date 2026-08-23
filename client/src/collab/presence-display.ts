export type DocumentPresenceDisplay = 'exact' | 'section' | 'off';

const KEY = 'marks:ui-preferences:v1';
export const PRESENCE_DISPLAY_EVENT = 'marks:presence-display';

/** Editor/source panes default to exact; a rendered-only surface defaults to section. */
export function getPresenceDisplay(renderedOnly: boolean): DocumentPresenceDisplay {
  let stored: unknown;
  try { stored = JSON.parse(localStorage.getItem(KEY) ?? '{}').documentPresence; } catch { stored = undefined; }
  return stored === 'exact' || stored === 'section' || stored === 'off'
    ? stored
    : renderedOnly ? 'section' : 'exact';
}

export function setPresenceDisplay(value: DocumentPresenceDisplay): void {
  let preferences: Record<string, unknown> = {};
  try { preferences = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>; } catch { /* replace corrupt preferences */ }
  localStorage.setItem(KEY, JSON.stringify({ ...preferences, documentPresence: value }));
  window.dispatchEvent(new CustomEvent(PRESENCE_DISPLAY_EVENT, { detail: value }));
}
