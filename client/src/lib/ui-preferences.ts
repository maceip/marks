export interface UiPreferences {
  density: 'comfortable' | 'compact';
  glass: boolean;
  motion: boolean;
  /** Device-local preference; a missing value keeps the phone ghost on. */
  phoneGhost: boolean;
  /** Shared document-presence override; omitted retains pane-aware defaults. */
  documentPresence?: 'exact' | 'section' | 'off';
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  density: 'comfortable',
  glass: true,
  motion: true,
  phoneGhost: true,
};

export function parseUiPreferences(serialized: string | null): UiPreferences {
  try {
    const value: unknown = JSON.parse(serialized ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_UI_PREFERENCES;
    const stored = value as Record<string, unknown>;
    const presence = stored.documentPresence;
    return {
      density: stored.density === 'compact' ? 'compact' : 'comfortable',
      glass: typeof stored.glass === 'boolean' ? stored.glass : DEFAULT_UI_PREFERENCES.glass,
      motion: typeof stored.motion === 'boolean' ? stored.motion : DEFAULT_UI_PREFERENCES.motion,
      phoneGhost: typeof stored.phoneGhost === 'boolean'
        ? stored.phoneGhost
        : DEFAULT_UI_PREFERENCES.phoneGhost,
      documentPresence: presence === 'exact' || presence === 'section' || presence === 'off'
        ? presence
        : undefined,
    };
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}
