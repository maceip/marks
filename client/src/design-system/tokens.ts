/** Typed design-token handles for code that cannot conveniently consume CSS. */

export const collaboratorTokenNames = [
  '--color-collaborator-1',
  '--color-collaborator-2',
  '--color-collaborator-3',
  '--color-collaborator-4',
  '--color-collaborator-5',
  '--color-collaborator-6',
  '--color-collaborator-7',
  '--color-collaborator-8',
] as const;

export type CollaboratorTokenName = (typeof collaboratorTokenNames)[number];
export type CollaboratorSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const collaboratorToken = (slot: CollaboratorSlot): CollaboratorTokenName =>
  collaboratorTokenNames[slot - 1];

/** CSS properties read by canvas renderers through getComputedStyle. */
export const canvasTokenNames = {
  foreground: '--color-fg-default',
  action: '--color-action',
  selection: '--color-selection',
  materialHighlight: '--material-highlight',
} as const;

export type CanvasTokenName = (typeof canvasTokenNames)[keyof typeof canvasTokenNames];

export const intentTokenNames = [
  '--color-primary',
  '--color-secondary',
  '--color-tertiary',
  '--color-destructive',
  '--color-success',
  '--color-warning',
  '--color-info',
] as const;

export const elevationTokenNames = [
  '--elevation-none',
  '--elevation-xs',
  '--elevation-sm',
  '--elevation-md',
  '--elevation-lg',
  '--elevation-xl',
  '--elevation-overlay',
] as const;

export const radiusTokenNames = [
  '--radius-none',
  '--radius-tight',
  '--radius-control',
  '--radius-card',
  '--radius-panel',
  '--radius-sheet',
  '--radius-pill',
  '--radius-round',
] as const;

export const interactivityTokenNames = [
  '--interact-press-translate',
  '--interact-hover-lift',
  '--interact-press-scale',
  '--interact-icon-tilt',
  '--interact-focus-offset',
  '--color-focus-ring',
] as const;

export function readCssToken(
  styles: Pick<CSSStyleDeclaration, 'getPropertyValue'>,
  token: CanvasTokenName | CollaboratorTokenName,
): string {
  return styles.getPropertyValue(token).trim();
}
