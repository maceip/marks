/**
 * Phone Write-mode ghost: a full-measure preview painted only in a right-hand
 * viewfinder. The editor stays full-width and fully editable. Two-finger
 * horizontal pan snaps which half of that page sits in the viewfinder.
 */

export type GhostShift = 'start' | 'end';

export interface PhoneGhostControl {
  enabled: boolean;
  shift: GhostShift;
  setEnabled: (enabled: boolean) => void;
  /** Non-gesture control used by accessible left/right-half buttons. */
  setShift: (shift: GhostShift) => void;
}

export interface PhoneGhostSessionPosition {
  documentId: string | null;
  shift: GhostShift;
}

export function ghostShiftForDocument(
  position: PhoneGhostSessionPosition,
  documentId: string | null,
): GhostShift {
  return position.documentId === documentId ? position.shift : 'start';
}

export function resetGhostPositionForDocument(
  position: PhoneGhostSessionPosition,
  documentId: string | null,
): PhoneGhostSessionPosition {
  return position.documentId === documentId
    ? position
    : { documentId, shift: 'start' };
}

/** Left half of the typeset page, translated into the right-hand viewfinder. */
export const GHOST_SHIFT_START_PERCENT = 50;
/** Right half of the typeset page, aligned with the viewfinder. */
export const GHOST_SHIFT_END_PERCENT = 0;
export const GHOST_SNAP_MID_PERCENT = 25;
/** Scale change that aborts a pan so pinch-zoom can proceed. */
export const GHOST_PINCH_RATIO = 1.12;
/** Horizontal travel must dominate vertical by this ratio. */
export const GHOST_PAN_AXIS_RATIO = 1.2;
export const GHOST_PAN_MIN_DISTANCE = 10;

export interface GhostPoint {
  x: number;
  y: number;
}

export function shiftToPercent(shift: GhostShift): number {
  return shift === 'start' ? GHOST_SHIFT_START_PERCENT : GHOST_SHIFT_END_PERCENT;
}

export function percentToShift(percent: number): GhostShift {
  return percent < GHOST_SNAP_MID_PERCENT ? 'end' : 'start';
}

export function clampGhostPercent(percent: number): number {
  return Math.min(GHOST_SHIFT_START_PERCENT, Math.max(GHOST_SHIFT_END_PERCENT, percent));
}

export function ghostPercentFromDrag(startPercent: number, dx: number, width: number): number {
  if (width <= 0) return startPercent;
  return clampGhostPercent(startPercent + (dx / width) * 100);
}

export function pointDistance(a: GhostPoint, b: GhostPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pinchRatio(startDistance: number, currentDistance: number): number {
  if (startDistance <= 0) return 1;
  const ratio = currentDistance / startDistance;
  return ratio < 1 ? 1 / ratio : ratio;
}

export function isPinchGesture(startDistance: number, currentDistance: number): boolean {
  return pinchRatio(startDistance, currentDistance) >= GHOST_PINCH_RATIO;
}

export function isHorizontalPan(dx: number, dy: number): boolean {
  return Math.abs(dx) >= GHOST_PAN_MIN_DISTANCE && Math.abs(dx) >= Math.abs(dy) * GHOST_PAN_AXIS_RATIO;
}

export type GhostGestureKind = 'idle' | 'undecided' | 'pan' | 'pinch';

export type GhostMoveResult =
  | { kind: 'idle' }
  | { kind: 'undecided' }
  | { kind: 'pan'; percent: number }
  | { kind: 'pinch'; percent: number };

export type GhostUpResult =
  | { type: 'continue' }
  | { type: 'snap'; shift: GhostShift; percent: number }
  | { type: 'restore'; percent: number };

/**
 * Two-pointer recognizer. One finger is always ignored so CodeMirror can
 * place the caret and scroll. A second finger captures the gesture: horizontal
 * pan updates the ghost, pinch aborts and restores the committed shift.
 */
export class PhoneGhostGesture {
  private readonly pointers = new Map<number, GhostPoint>();
  private session: {
    ids: [number, number];
    start: [GhostPoint, GhostPoint];
    startDistance: number;
    startMid: GhostPoint;
    startPercent: number;
    lastPercent: number;
    kind: 'undecided' | 'pan' | 'pinch';
  } | null = null;

  get pointerCount(): number {
    return this.pointers.size;
  }

  get kind(): GhostGestureKind {
    return this.session?.kind ?? 'idle';
  }

  get capturing(): boolean {
    return this.session !== null;
  }

  reset(): void {
    this.pointers.clear();
    this.session = null;
  }

  down(id: number, x: number, y: number, currentPercent: number): 'pass' | 'capture' {
    this.pointers.set(id, { x, y });
    if (this.pointers.size === 2) {
      const ids = [...this.pointers.keys()] as [number, number];
      const start: [GhostPoint, GhostPoint] = [
        { ...this.pointers.get(ids[0])! },
        { ...this.pointers.get(ids[1])! },
      ];
      this.session = {
        ids,
        start,
        startDistance: pointDistance(start[0], start[1]),
        startMid: midpoint(start[0], start[1]),
        startPercent: currentPercent,
        lastPercent: currentPercent,
        kind: 'undecided',
      };
      return 'capture';
    }
    if (this.pointers.size > 2 && this.session) {
      this.session.kind = 'pinch';
      this.session.lastPercent = this.session.startPercent;
    }
    return 'pass';
  }

  move(id: number, x: number, y: number, width: number): GhostMoveResult {
    if (!this.pointers.has(id)) return { kind: 'idle' };
    this.pointers.set(id, { x, y });
    if (!this.session) return { kind: 'idle' };
    if (this.pointers.size < 2) return snapshotMove(this.session);

    const first = this.pointers.get(this.session.ids[0]);
    const second = this.pointers.get(this.session.ids[1]);
    if (!first || !second) return snapshotMove(this.session);

    const classified = classifyTwoFinger(this.session.start[0], first, this.session.start[1], second, this.session.startDistance);
    if (this.session.kind === 'undecided' && classified !== 'undecided') {
      this.session.kind = classified;
    }
    if (this.session.kind === 'pinch') {
      this.session.lastPercent = this.session.startPercent;
      return { kind: 'pinch', percent: this.session.startPercent };
    }
    if (this.session.kind === 'pan') {
      const mid = midpoint(first, second);
      const percent = ghostPercentFromDrag(this.session.startPercent, mid.x - this.session.startMid.x, width);
      this.session.lastPercent = percent;
      return { kind: 'pan', percent };
    }
    return { kind: 'undecided' };
  }

  up(id: number): GhostUpResult {
    this.pointers.delete(id);
    if (!this.session) return { type: 'continue' };
    if (this.pointers.size >= 2) return { type: 'continue' };

    const session = this.session;
    this.session = null;
    if (session.kind === 'pan') {
      const shift = percentToShift(session.lastPercent);
      return { type: 'snap', shift, percent: shiftToPercent(shift) };
    }
    return { type: 'restore', percent: session.startPercent };
  }
}

export function formatGhostPercent(percent: number): string {
  return `${clampGhostPercent(percent)}%`;
}

export interface PhoneGhostBindings {
  getPercent: () => number;
  setPercent: (percent: number) => void;
  setDragging: (dragging: boolean) => void;
  setShift: (shift: GhostShift) => void;
  /** Fires only after a pan snaps, never during live drag or pinch restore. */
  onShiftCommit?: (shift: GhostShift) => void;
  onSuppressSwipe: (suppress: boolean) => void;
}

/**
 * Attach two-finger ghost controls to the phone workspace. The overlay must
 * remain `pointer-events: none`; these listeners sit on the workspace itself.
 */
export function bindPhoneGhostControls(root: HTMLElement, bindings: PhoneGhostBindings): () => void {
  const gesture = new PhoneGhostGesture();
  const firstPointer = { id: -1, target: null as EventTarget | null };

  const applyPercent = (percent: number, shift = percentToShift(percent)) => {
    bindings.setPercent(percent);
    bindings.setShift(shift);
    root.style.setProperty('--phone-ghost-shift', formatGhostPercent(percent));
    root.dataset.ghostShift = shift;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const result = gesture.down(event.pointerId, event.clientX, event.clientY, bindings.getPercent());
    if (gesture.pointerCount === 1) {
      firstPointer.id = event.pointerId;
      firstPointer.target = event.target;
    }
    if (result === 'capture') {
      bindings.onSuppressSwipe(true);
      bindings.setDragging(true);
      root.classList.add('phone-ghost-dragging');
      cancelEditorPointer(firstPointer.target, firstPointer.id, event);
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic harness events cannot capture; window listeners still see bubbles.
      }
      if (event.cancelable) event.preventDefault();
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const width = root.getBoundingClientRect().width;
    const result = gesture.move(event.pointerId, event.clientX, event.clientY, width);
    if (result.kind === 'pan' && result.percent !== undefined) {
      if (event.cancelable) event.preventDefault();
      applyPercent(result.percent);
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    // The editor-cancel we synthesize to drop a one-finger selection is an
    // untrusted pointercancel. It must not end the two-finger ghost session.
    if (event.type === 'pointercancel' && !event.isTrusted) return;
    const result = gesture.up(event.pointerId);
    if (result.type === 'snap') {
      bindings.setDragging(false);
      root.classList.remove('phone-ghost-dragging');
      applyPercent(result.percent, result.shift);
      bindings.onShiftCommit?.(result.shift);
    } else if (result.type === 'restore') {
      bindings.setDragging(false);
      root.classList.remove('phone-ghost-dragging');
      applyPercent(result.percent);
    }
    if (gesture.pointerCount === 0) {
      firstPointer.id = -1;
      firstPointer.target = null;
      root.classList.remove('phone-ghost-dragging');
      queueMicrotask(() => {
        if (gesture.pointerCount === 0) bindings.onSuppressSwipe(false);
      });
    }
  };

  const onTouchMove = (event: TouchEvent) => {
    if (gesture.kind === 'pan' && event.touches.length >= 2 && event.cancelable) {
      event.preventDefault();
    }
  };

  root.addEventListener('pointerdown', onPointerDown, { capture: true });
  root.addEventListener('pointermove', onPointerMove, { capture: true });
  root.addEventListener('pointerup', onPointerUp, { capture: true });
  root.addEventListener('pointercancel', onPointerUp, { capture: true });
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  root.addEventListener('touchmove', onTouchMove, { passive: false });

  return () => {
    gesture.reset();
    root.classList.remove('phone-ghost-dragging');
    root.removeEventListener('pointerdown', onPointerDown, { capture: true });
    root.removeEventListener('pointermove', onPointerMove, { capture: true });
    root.removeEventListener('pointerup', onPointerUp, { capture: true });
    root.removeEventListener('pointercancel', onPointerUp, { capture: true });
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    root.removeEventListener('touchmove', onTouchMove);
  };
}

function classifyTwoFinger(
  startA: GhostPoint,
  nowA: GhostPoint,
  startB: GhostPoint,
  nowB: GhostPoint,
  startDistance: number,
): 'undecided' | 'pan' | 'pinch' {
  const a = { x: nowA.x - startA.x, y: nowA.y - startA.y };
  const b = { x: nowB.x - startB.x, y: nowB.y - startB.y };
  const aLen = Math.hypot(a.x, a.y);
  const bLen = Math.hypot(b.x, b.y);
  const currentDistance = pointDistance(nowA, nowB);
  const midTravel = Math.hypot(
    (nowA.x + nowB.x) / 2 - (startA.x + startB.x) / 2,
    (nowA.y + nowB.y) / 2 - (startA.y + startB.y) / 2,
  );
  if (isPinchGesture(startDistance, currentDistance) && midTravel < GHOST_PAN_MIN_DISTANCE) {
    return 'pinch';
  }
  if (aLen < GHOST_PAN_MIN_DISTANCE || bLen < GHOST_PAN_MIN_DISTANCE) return 'undecided';
  const dot = a.x * b.x + a.y * b.y;
  if (dot < 0 && isPinchGesture(startDistance, currentDistance)) return 'pinch';
  const avgDx = (a.x + b.x) / 2;
  const avgDy = (a.y + b.y) / 2;
  if (dot >= 0 && isHorizontalPan(avgDx, avgDy)) return 'pan';
  return 'undecided';
}

function snapshotMove(session: {
  kind: 'undecided' | 'pan' | 'pinch';
  lastPercent: number;
  startPercent: number;
}): GhostMoveResult {
  if (session.kind === 'pan') return { kind: 'pan', percent: session.lastPercent };
  if (session.kind === 'pinch') return { kind: 'pinch', percent: session.startPercent };
  return { kind: 'undecided' };
}

function midpoint(a: GhostPoint, b: GhostPoint): GhostPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function cancelEditorPointer(target: EventTarget | null, pointerId: number, source: PointerEvent): void {
  if (!(target instanceof HTMLElement) || pointerId < 0) return;
  target.dispatchEvent(
    new PointerEvent('pointercancel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId,
      pointerType: source.pointerType,
      clientX: source.clientX,
      clientY: source.clientY,
    }),
  );
}
