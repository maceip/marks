import { useCallback, useEffect, useState } from 'react';
import { setMermaidTheme } from '../markdown/mermaid';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'marks:theme';

function initialTheme(): Theme {
  const stored = document.documentElement.dataset.theme;
  if (stored === 'light' || stored === 'dark') return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(): [Theme, () => void, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    setMermaidTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not being able to remember the theme is not worth surfacing.
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  const choose = useCallback((next: Theme) => setTheme(next), []);

  return [theme, toggle, choose];
}
