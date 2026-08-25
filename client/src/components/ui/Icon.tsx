import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ICON_MARKS,
  ICON_TONE,
  isIconName,
  type IconKind,
  type IconName,
  type IconTone,
} from '../icons/catalog';
import { isSheetIconName, SHEET_ICON_SIZE } from '../icons/assets';
import type { IconActivationLayer } from '../icons/motion';

export type { IconName, IconTone, IconKind };
export { icons, ICON_NAMES, ICON_MARKS, ICON_TONE } from '../icons/catalog';

export interface IconProps {
  name?: IconName;
  path?: string;
  label?: string;
  size?: number;
  interactive?: boolean;
  kind?: IconKind;
  className?: string;
}

const FACE: Record<IconTone, string> = {
  navy: 'var(--color-brand-primary)',
  blue: 'var(--color-primary)',
  green: 'var(--color-success)',
  teal: 'var(--color-brand-teal)',
  amber: 'var(--color-brand-warm)',
  rose: 'var(--color-destructive)',
  slate: 'var(--color-fg-muted)',
};

const SHEET_ICON_ROOT = `${import.meta.env.BASE_URL}icons/isometric`;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const ACTIVE_ICON_ANIMATIONS = new WeakMap<HTMLElement, Animation[]>();
const ACTIVE_ICON_REQUESTS = new WeakMap<HTMLElement, object>();
let iconMotionModule: Promise<typeof import('../icons/motion')> | undefined;

function loadIconMotion() {
  iconMotionModule ??= import('../icons/motion');
  return iconMotionModule;
}

function resolve(name?: string, path?: string): { name: IconName; mark: string; tone: IconTone } {
  const key = name && isIconName(name) ? name : path && isIconName(path) ? path : undefined;
  if (key) return { name: key, mark: ICON_MARKS[key], tone: ICON_TONE[key] };
  return { name: 'sparkles', mark: path && path.includes(' ') ? path : ICON_MARKS.sparkles, tone: 'amber' };
}

function motionIsReduced() {
  const root = document.documentElement;
  return root.dataset.motion === 'reduced'
    || root.dataset.surfaceTier === 'foundation'
    || window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function controlIsUnavailable(target: HTMLElement) {
  return target.matches(':disabled, [aria-disabled="true"], [data-loading="true"]');
}

function setTilt(target: HTMLElement, clientX: number, clientY: number, bounds: DOMRect) {
  if (bounds.width === 0 || bounds.height === 0) return;
  const x = Math.max(-1, Math.min(1, ((clientX - bounds.left) / bounds.width) * 2 - 1));
  const y = Math.max(-1, Math.min(1, ((clientY - bounds.top) / bounds.height) * 2 - 1));
  target.style.setProperty('--icon-tilt-x', x.toFixed(3));
  target.style.setProperty('--icon-tilt-y', y.toFixed(3));
  target.style.setProperty('--icon-hover', '1');
}

function setPress(target: HTMLElement, pressed: boolean) {
  target.style.setProperty('--icon-press', pressed ? '1' : '0');
}

function clearHover(target: HTMLElement) {
  target.style.setProperty('--icon-tilt-x', '0');
  target.style.setProperty('--icon-tilt-y', '0');
  target.style.setProperty('--icon-hover', '0');
}

function clearTilt(target: HTMLElement) {
  clearHover(target);
  target.style.setProperty('--icon-press', '0');
}

function cancelActivation(target: HTMLElement) {
  ACTIVE_ICON_REQUESTS.delete(target);
  ACTIVE_ICON_ANIMATIONS.get(target)?.forEach((animation) => animation.cancel());
  ACTIVE_ICON_ANIMATIONS.delete(target);
  target.removeAttribute('data-icon-activating');
}

async function animateActivation(target: HTMLElement) {
  const action = target.querySelector<HTMLElement>('.marks-icon-action');
  const halo = target.querySelector<HTMLElement>('.marks-icon-halo');
  const beam = target.querySelector<HTMLElement>('.marks-icon-beam');
  const particles = Array.from(target.querySelectorAll<HTMLElement>('.marks-icon-particle'));
  if (!action || !halo || !beam || typeof action.animate !== 'function') return;

  cancelActivation(target);
  const request = {};
  ACTIVE_ICON_REQUESTS.set(target, request);
  target.setAttribute('data-icon-activating', 'true');

  let motion: typeof import('../icons/motion');
  try {
    motion = await loadIconMotion();
  } catch {
    iconMotionModule = undefined;
    if (ACTIVE_ICON_REQUESTS.get(target) === request) {
      ACTIVE_ICON_REQUESTS.delete(target);
      target.removeAttribute('data-icon-activating');
    }
    return;
  }
  if (ACTIVE_ICON_REQUESTS.get(target) !== request) return;
  const { createIconActivationPlan } = motion;
  const layers: Record<Exclude<IconActivationLayer, 'particle'>, HTMLElement> = { action, halo, beam };
  const animations = createIconActivationPlan(motionIsReduced(), particles.length).map((animationStep) => {
    const layer = animationStep.layer === 'particle'
      ? particles[animationStep.particleIndex ?? -1]
      : layers[animationStep.layer];
    return layer.animate(animationStep.keyframes, animationStep.options);
  });

  ACTIVE_ICON_ANIMATIONS.set(target, animations);
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (ACTIVE_ICON_ANIMATIONS.get(target) !== animations) return;
    ACTIVE_ICON_ANIMATIONS.delete(target);
    target.removeAttribute('data-icon-activating');
  });
}

/**
 * Isometric 2.5D Marks icon. A thick rounded slab, gloss, and a stroke mark
 * on the face — a modern reading of Palm webOS launcher tiles. Tilt and press
 * are CSS variables so hover never starts a private animation loop.
 */
export function Icon({
  name,
  path,
  label,
  size = 24,
  interactive = true,
  kind = 'chrome',
  className = '',
}: IconProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [failedSheetAsset, setFailedSheetAsset] = useState<IconName | null>(null);
  const resolved = resolve(name, path);
  const face = FACE[resolved.tone];
  const sheetAsset = isSheetIconName(resolved.name) && failedSheetAsset !== resolved.name;

  useEffect(() => {
    const target = iconRef.current;
    if (!target || !interactive) return;

    const control = target.closest<HTMLElement>('button') ?? target;
    let hoverBounds: DOMRect | null = null;
    let pressedPointer: number | null = null;

    const clearPress = () => {
      pressedPointer = null;
      setPress(target, false);
      window.removeEventListener('pointerup', onWindowRelease);
      window.removeEventListener('pointercancel', onWindowRelease);
    };
    const onWindowRelease = (event: PointerEvent) => {
      if (pressedPointer !== null && event.pointerId !== pressedPointer) return;
      clearPress();
    };
    const reset = () => {
      hoverBounds = null;
      clearPress();
      clearTilt(target);
    };
    const queueTilt = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || controlIsUnavailable(control) || motionIsReduced()) {
        clearHover(target);
        return;
      }
      hoverBounds ??= control.getBoundingClientRect();
      setTilt(target, event.clientX, event.clientY, hoverBounds);
    };
    const onPointerEnter = (event: PointerEvent) => {
      hoverBounds = control.getBoundingClientRect();
      queueTilt(event);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0) || controlIsUnavailable(control)) return;
      pressedPointer = event.pointerId;
      setPress(target, true);
      window.addEventListener('pointerup', onWindowRelease);
      window.addEventListener('pointercancel', onWindowRelease);
    };
    const onPointerRelease = (event: PointerEvent) => {
      if (pressedPointer !== null && event.pointerId !== pressedPointer) return;
      clearPress();
    };
    const onClick = () => {
      clearPress();
      if (!controlIsUnavailable(control)) void animateActivation(target);
    };

    control.addEventListener('pointerenter', onPointerEnter);
    control.addEventListener('pointermove', queueTilt);
    control.addEventListener('pointerdown', onPointerDown);
    control.addEventListener('pointerup', onPointerRelease);
    control.addEventListener('pointercancel', onPointerRelease);
    control.addEventListener('lostpointercapture', onPointerRelease);
    control.addEventListener('pointerleave', reset);
    control.addEventListener('click', onClick);
    window.addEventListener('blur', reset);

    return () => {
      reset();
      cancelActivation(target);
      control.removeEventListener('pointerenter', onPointerEnter);
      control.removeEventListener('pointermove', queueTilt);
      control.removeEventListener('pointerdown', onPointerDown);
      control.removeEventListener('pointerup', onPointerRelease);
      control.removeEventListener('pointercancel', onPointerRelease);
      control.removeEventListener('lostpointercapture', onPointerRelease);
      control.removeEventListener('pointerleave', reset);
      control.removeEventListener('click', onClick);
      window.removeEventListener('blur', reset);
    };
  }, [interactive]);

  return (
    <span
      ref={iconRef}
      className={`marks-icon marks-icon-${kind} marks-icon-${resolved.tone}${interactive ? ' marks-icon-live' : ''} icon${className ? ` ${className}` : ''}`}
      data-icon={resolved.name}
      data-icon-source={sheetAsset ? 'sheet' : 'vector-fallback'}
      style={{
        '--marks-icon-base-size': `${size}px`,
        '--marks-icon-accent': face,
      } as CSSProperties}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    >
      <span className="marks-icon-body marks-icon-pivot">
        <span className="marks-icon-action">
          {sheetAsset ? (
            <img
              className="marks-icon-art marks-icon-sheet"
              src={`${SHEET_ICON_ROOT}/${resolved.name}.png`}
              onError={() => setFailedSheetAsset(resolved.name)}
              alt=""
              aria-hidden="true"
              width={SHEET_ICON_SIZE}
              height={SHEET_ICON_SIZE}
              draggable={false}
            />
          ) : (
            <>
              <svg className="marks-icon-art marks-icon-shadow" viewBox="4 3 24 28" aria-hidden="true">
                <ellipse cx="16.4" cy="28.1" rx="9.4" ry="2.15" fill="rgb(12 28 72 / 0.22)" />
              </svg>
              <svg className="marks-icon-art" viewBox="4 3 24 28" aria-hidden="true">
                <path className="marks-icon-side" fill={`color-mix(in srgb, ${face} 68%, black)`} d="M22.1 9.1 26.5 6.4v14.4L22.1 23.6z" />
                <path className="marks-icon-top" fill={`color-mix(in srgb, ${face} 62%, white)`} d="M9.7 9.1h12.4l4.4-2.7H14.1z" />
                <rect className="marks-icon-face" x="9.7" y="9.1" width="12.4" height="14.5" rx="3.1" fill={face} stroke={`color-mix(in srgb, ${face} 45%, white)`} strokeWidth="0.6" />
                <path className="marks-icon-gloss" d="M11.1 10.4c3.4-1.15 8.2-1.05 10.1.9" fill="none" stroke="rgb(255 255 255 / 0.58)" strokeWidth="1.1" strokeLinecap="round" />
                <g className="marks-icon-mark" transform="translate(10.35 11.15) scale(0.46)" fill="none" stroke="rgb(255 255 255 / 0.94)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d={resolved.mark} />
                </g>
              </svg>
            </>
          )}
          <span className="marks-icon-beam" aria-hidden="true" />
        </span>
      </span>
      <span className="marks-icon-halo" aria-hidden="true" />
      <span className="marks-icon-particles" aria-hidden="true">
        <i className="marks-icon-particle" />
        <i className="marks-icon-particle" />
        <i className="marks-icon-particle" />
        <i className="marks-icon-particle" />
      </span>
    </span>
  );
}
