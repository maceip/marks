import { useEffect, useState } from 'react';

export interface UiPreferences {
  density: 'comfortable' | 'compact';
  glass: boolean;
  motion: boolean;
  /** Shared document-presence override; omitted retains pane-aware defaults. */
  documentPresence?: 'exact' | 'section' | 'off';
}

const KEY = 'marks:ui-preferences:v1';
const DEFAULTS: UiPreferences = { density: 'comfortable', glass: true, motion: true };

function load(): UiPreferences {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

export function useUiPreferences(): [UiPreferences, (patch: Partial<UiPreferences>) => void] {
  const [preferences, setPreferences] = useState<UiPreferences>(load);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = preferences.density;
    root.dataset.glass = preferences.glass ? 'full' : 'reduced';
    root.dataset.motion = preferences.motion ? 'full' : 'reduced';
    localStorage.setItem(KEY, JSON.stringify(preferences));
  }, [preferences]);

  return [preferences, (patch) => setPreferences((current) => ({ ...current, ...patch }))];
}
