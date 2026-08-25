import { useCallback, useEffect, useState } from 'react';
import {
  parseUiPreferences,
  type UiPreferences,
} from '../lib/ui-preferences';

export type { UiPreferences } from '../lib/ui-preferences';

const KEY = 'marks:ui-preferences:v1';

function load(): UiPreferences {
  return parseUiPreferences(localStorage.getItem(KEY));
}

export function useUiPreferences(): [UiPreferences, (patch: Partial<UiPreferences>) => void] {
  const [preferences, setPreferences] = useState<UiPreferences>(load);
  const updatePreferences = useCallback(
    (patch: Partial<UiPreferences>) => setPreferences((current) => ({ ...current, ...patch })),
    [],
  );

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = preferences.density;
    root.dataset.glass = preferences.glass ? 'full' : 'reduced';
    root.dataset.motion = preferences.motion ? 'full' : 'reduced';
    localStorage.setItem(KEY, JSON.stringify(preferences));
  }, [preferences]);

  return [preferences, updatePreferences];
}
