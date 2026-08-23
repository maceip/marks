interface OpeningShellProps {
  cached: boolean;
  offline: boolean;
}

/**
 * First-paint shell. Transform-only shimmer so it stays on the compositor
 * thread; `prefers-reduced-motion` already kills the animation globally.
 */
export function OpeningShell({ cached, offline }: OpeningShellProps) {
  const message = offline
    ? 'Opening your last local copy…'
    : cached
      ? 'Showing your last copy…'
      : 'Opening document…';

  return (
    <div className="opening-shell" aria-busy="true" aria-live="polite">
      <div className="opening-skeleton" aria-hidden="true">
        <div className="skeleton-line w-48" />
        <div className="skeleton-line w-92" />
        <div className="skeleton-line w-80" />
        <div className="skeleton-line w-88" />
        <div className="skeleton-line w-64" />
        <div className="skeleton-line w-84" />
      </div>
      <p className="hint opening-hint">{message}</p>
    </div>
  );
}
