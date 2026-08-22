import { isCoarsePointer } from './platform.ts';

export type ContextSurface = 'editor' | 'preview' | 'other';

export interface ContextMenuRequest {
  clientX: number;
  clientY: number;
  surface: ContextSurface;
  /** True when the user already has a text selection at the pointer. */
  hasSelection: boolean;
  pointerType: 'mouse' | 'touch' | 'pen' | 'unknown';
}

/**
 * Decide whether marks should replace the browser's context menu.
 *
 * Native menu is kept when it is the better tool:
 *  - a coarse pointer (phone/tablet) with a live text selection, so iOS/Android
 *    callouts (Copy, Look Up, Speak) still appear
 *  - anything outside the editor or preview
 *
 * Everywhere else we show our own menu so Cut/Copy/Paste/Select All
 * work the same in Chrome, Firefox, Safari and on a mouse-driven tablet.
 */
export function shouldOfferCustomMenu(request: ContextMenuRequest): boolean {
  if (request.surface === 'other') return false;
  if (request.surface === 'preview') return true;
  if (request.surface === 'editor' && isCoarsePointer() && request.hasSelection) return false;
  return request.surface === 'editor';
}

export function surfaceFromTarget(target: EventTarget | null): ContextSurface {
  if (!(target instanceof Element)) return 'other';
  if (target.closest('.cm-content, .cm-line, .cm-editor')) return 'editor';
  if (target.closest('.marks-preview, .preview-pane')) return 'preview';
  return 'other';
}

export function hasDomSelection(): boolean {
  const selection = document.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
}

export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport = { width: typeof window === 'undefined' ? 0 : window.innerWidth, height: typeof window === 'undefined' ? 0 : window.innerHeight },
): { x: number; y: number } {
  const pad = 8;
  return {
    x: Math.min(Math.max(pad, x), Math.max(pad, viewport.width - width - pad)),
    y: Math.min(Math.max(pad, y), Math.max(pad, viewport.height - height - pad)),
  };
}

/** Long-press delay that matches iOS/Android text-selection timing. */
export const LONG_PRESS_MS = 520;
export const LONG_PRESS_SLOP_PX = 12;

export interface LongPressController {
  start(event: PointerEvent): void;
  move(event: PointerEvent): void;
  cancel(): void;
  destroy(): void;
}

export function createLongPress(
  onFire: (event: PointerEvent) => void,
  delay = LONG_PRESS_MS,
): LongPressController {
  let timer: number | null = null;
  let origin: { x: number; y: number; pointerId: number } | null = null;

  const clear = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    origin = null;
  };

  return {
    start(event) {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      clear();
      origin = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      const started = event;
      timer = window.setTimeout(() => {
        timer = null;
        onFire(started);
      }, delay);
    },
    move(event) {
      if (!origin || event.pointerId !== origin.pointerId) return;
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      if (dx * dx + dy * dy > LONG_PRESS_SLOP_PX * LONG_PRESS_SLOP_PX) clear();
    },
    cancel: clear,
    destroy: clear,
  };
}
