// Apply the stored theme before first paint without weakening script-src.
try {
  const stored = localStorage.getItem('marks:theme');
  const theme = stored
    ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
} catch {
  // Storage can be disabled; CSS color-scheme remains the safe fallback.
}
