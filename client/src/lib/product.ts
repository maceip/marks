export const PRODUCT_NAME = 'marks';

export const ENGINE = {
  id: 'esbt' as const,
  label: 'ESBT',
  blurb:
    'Weighted-identifier sequence CRDT (Mechaoui & Imine). Pure TypeScript, tombstone-free deletes, delta reconnect.',
};

export const UI_BREAKPOINTS = {
  phone: 720,
  overlayNavigation: 1099,
} as const;

export const UI_MEDIA = {
  phone: `(max-width: ${UI_BREAKPOINTS.phone}px), (max-height: 560px) and (pointer: coarse)`,
  overlayNavigation: `(max-width: ${UI_BREAKPOINTS.overlayNavigation}px)`,
} as const;
