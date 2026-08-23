/**
 * Device posture is a capability model, not a width breakpoint.
 *
 * Shells are chosen from viewport segments, the Device Posture API, pointer
 * type, and the visual viewport. Width is only a fallback when those signals
 * are absent, so a foldable never becomes “a tablet CSS file.”
 */

export type Shell = 'phone' | 'studio' | 'desktop' | 'fold-book' | 'fold-laptop';

export type Hinge = 'none' | 'vertical' | 'horizontal';

export interface ViewportSegment {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PostureInput {
  width: number;
  height: number;
  coarse: boolean;
  segments?: ViewportSegment[];
  devicePosture?: 'continuous' | 'folded';
  visualViewportHeight?: number;
  spanningHorizontal?: boolean;
  spanningVertical?: boolean;
  override?: Shell | null;
}

export interface Posture {
  shell: Shell;
  segments: 1 | 2;
  hinge: Hinge;
  folded: boolean;
  coarse: boolean;
  keyboardOpen: boolean;
  keyboardInset: number;
  overlayNavigation: boolean;
  phone: boolean;
  foldable: boolean;
  geometry: {
    segment0Width: number;
    segment1Width: number;
    segment0Height: number;
    segment1Height: number;
    hingeGap: number;
  };
}

export const PHONE_FALLBACK_WIDTH = 720;
export const STUDIO_FALLBACK_WIDTH = 1099;
export const KEYBOARD_INSET_THRESHOLD = 120;

const SHELLS: readonly Shell[] = ['phone', 'studio', 'desktop', 'fold-book', 'fold-laptop'];

export function isShell(value: string | null | undefined): value is Shell {
  return Boolean(value && (SHELLS as readonly string[]).includes(value));
}

export function classifyPosture(input: PostureInput): Posture {
  const width = Math.max(1, input.width);
  const height = Math.max(1, input.height);
  const keyboardInset = Math.max(0, height - (input.visualViewportHeight ?? height));
  const keyboardOpen = keyboardInset > KEYBOARD_INSET_THRESHOLD;
  const folded = input.devicePosture === 'folded';
  const segments = normalizeSegments(input.segments, width, height);
  const spanning =
    input.spanningHorizontal || input.spanningVertical || segments.length >= 2;

  let shell: Shell;
  let hinge: Hinge = 'none';
  let usedSegments: ViewportSegment[] = [{ x: 0, y: 0, width, height }];

  if (input.override) {
    shell = input.override;
    hinge = input.override === 'fold-book' ? 'vertical' : input.override === 'fold-laptop' ? 'horizontal' : 'none';
    if (hinge !== 'none' && segments.length < 2) {
      usedSegments = syntheticSegments(width, height, hinge);
    } else if (segments.length >= 2) {
      usedSegments = segments;
    }
  } else if (spanning && (input.spanningVertical || isStacked(segments))) {
    shell = 'fold-laptop';
    hinge = 'horizontal';
    usedSegments = segments.length >= 2 ? segments : syntheticSegments(width, height, 'horizontal');
  } else if (spanning) {
    shell = 'fold-book';
    hinge = 'vertical';
    usedSegments = segments.length >= 2 ? segments : syntheticSegments(width, height, 'vertical');
  } else if (width <= PHONE_FALLBACK_WIDTH || (height <= 560 && input.coarse)) {
    shell = 'phone';
  } else if (width <= STUDIO_FALLBACK_WIDTH) {
    shell = 'studio';
  } else {
    shell = 'desktop';
  }

  const pair = usedSegments.length >= 2 ? usedSegments : [usedSegments[0], usedSegments[0]];
  const hingeGap =
    hinge === 'vertical'
      ? Math.max(0, pair[1].x - (pair[0].x + pair[0].width))
      : hinge === 'horizontal'
        ? Math.max(0, pair[1].y - (pair[0].y + pair[0].height))
        : 0;

  return {
    shell,
    segments: hinge === 'none' ? 1 : 2,
    hinge,
    folded,
    coarse: input.coarse,
    keyboardOpen,
    keyboardInset,
    overlayNavigation: shell === 'phone' || shell === 'studio',
    phone: shell === 'phone',
    foldable: shell === 'fold-book' || shell === 'fold-laptop',
    geometry: {
      segment0Width: pair[0].width,
      segment1Width: pair[1].width,
      segment0Height: pair[0].height,
      segment1Height: pair[1].height,
      hingeGap,
    },
  };
}

function normalizeSegments(
  segments: ViewportSegment[] | undefined,
  width: number,
  height: number,
): ViewportSegment[] {
  if (!segments?.length) return [{ x: 0, y: 0, width, height }];
  return segments
    .filter((segment) => segment.width > 0 && segment.height > 0)
    .map((segment) => ({
      x: segment.x,
      y: segment.y,
      width: segment.width,
      height: segment.height,
    }))
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

function isStacked(segments: ViewportSegment[]): boolean {
  if (segments.length < 2) return false;
  return segments[1].y >= segments[0].y + segments[0].height * 0.4;
}

function syntheticSegments(width: number, height: number, hinge: Exclude<Hinge, 'none'>): ViewportSegment[] {
  if (hinge === 'vertical') {
    const pane = Math.round((width - 28) / 2);
    return [
      { x: 0, y: 0, width: pane, height },
      { x: pane + 28, y: 0, width: width - pane - 28, height },
    ];
  }
  const pane = Math.round((height - 24) / 2);
  return [
    { x: 0, y: 0, width, height: pane },
    { x: 0, y: pane + 24, width, height: height - pane - 24 },
  ];
}

export function postureCssVars(posture: Posture): Record<string, string> {
  return {
    '--segment-0-width': `${Math.round(posture.geometry.segment0Width)}px`,
    '--segment-1-width': `${Math.round(posture.geometry.segment1Width)}px`,
    '--segment-0-height': `${Math.round(posture.geometry.segment0Height)}px`,
    '--segment-1-height': `${Math.round(posture.geometry.segment1Height)}px`,
    '--hinge-gap': `${Math.round(posture.geometry.hingeGap)}px`,
    '--keyboard-inset': `${Math.round(posture.keyboardInset)}px`,
  };
}
