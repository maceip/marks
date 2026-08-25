export const PRODUCT_NAME = 'marks';

/** User inactivity only hides transient presence; document sync stays live. */
export const PRESENCE_IDLE_MS = 60_000;

/** Latest deterministic level-9 gzip receipt from `npm run check:ui-budgets`. */
export const UI_PERFORMANCE_RECEIPT = {
  appCriticalKb: '106.08',
  marketingCriticalKb: '0.55',
} as const;

/**
 * The complete UI runs against a deterministic local workspace by default.
 * Set VITE_MARKS_DATA_MODE=service when the document service is ready to own
 * metadata, admission, and persistence again.
 */
export const UI_DATA_MODE =
  import.meta.env?.VITE_MARKS_DATA_MODE === 'service' ? ('service' as const) : ('local' as const);

/**
 * The ribbon possibility layer is merged but intentionally dormant until its
 * product and design review is complete. This is a build-time flag so an
 * unflagged production bundle cannot accidentally activate it at runtime.
 */
export const RIBBON_WILD_ENABLED =
  import.meta.env?.VITE_MARKS_RIBBON_WILD === '1';

export const ENGINE = {
  id: 'esbt' as const,
  label: 'ESBT',
  blurb:
    'Weighted-identifier sequence CRDT (Mechaoui & Imine). Rust/Wasm replica, per-peer undo, IndexedDB journal, compact format v3.',
};

export const UI_BREAKPOINTS = {
  phone: 720,
  overlayNavigation: 1099,
} as const;

export const UI_MEDIA = {
  phone: `(max-width: ${UI_BREAKPOINTS.phone}px), (max-height: 560px) and (pointer: coarse)`,
  overlayNavigation: `(max-width: ${UI_BREAKPOINTS.overlayNavigation}px)`,
  foldBook: '(horizontal-viewport-segments: 2), (spanning: single-fold-vertical)',
  foldLaptop: '(vertical-viewport-segments: 2), (spanning: single-fold-horizontal)',
} as const;
