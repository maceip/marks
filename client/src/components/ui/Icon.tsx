import { useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ICON_MARKS,
  ICON_TONE,
  isIconName,
  type IconKind,
  type IconName,
  type IconTone,
} from '../icons/catalog';

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

function resolve(name?: string, path?: string): { name: IconName; mark: string; tone: IconTone } {
  const key = name && isIconName(name) ? name : path && isIconName(path) ? path : undefined;
  if (key) return { name: key, mark: ICON_MARKS[key], tone: ICON_TONE[key] };
  return { name: 'sparkles', mark: path && path.includes(' ') ? path : ICON_MARKS.sparkles, tone: 'amber' };
}

function setTilt(target: HTMLElement, event: ReactPointerEvent<HTMLElement>) {
  const bounds = target.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return;
  const x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  const y = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
  target.style.setProperty('--icon-tilt-x', x.toFixed(3));
  target.style.setProperty('--icon-tilt-y', y.toFixed(3));
}

function setPress(target: HTMLElement, pressed: boolean) {
  target.style.setProperty('--icon-press', pressed ? '1' : '0');
}

function clearTilt(target: HTMLElement) {
  target.style.setProperty('--icon-tilt-x', '0');
  target.style.setProperty('--icon-tilt-y', '0');
  target.style.setProperty('--icon-press', '0');
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
  size = 16,
  interactive = true,
  kind = 'chrome',
  className = '',
}: IconProps) {
  const resolved = resolve(name, path);
  const onMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!interactive) return;
    setTilt(event.currentTarget, event);
  }, [interactive]);

  return (
    <span
      className={`marks-icon marks-icon-${kind} marks-icon-${resolved.tone}${interactive ? ' marks-icon-live' : ''} icon${className ? ` ${className}` : ''}`}
      data-icon={resolved.name}
      style={{ width: size, height: size }}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      onPointerEnter={onMove}
      onPointerMove={onMove}
      onPointerDown={(event) => interactive && setPress(event.currentTarget, true)}
      onPointerUp={(event) => interactive && setPress(event.currentTarget, false)}
      onPointerLeave={(event) => clearTilt(event.currentTarget)}
    >
      <svg className="marks-icon-shadow" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <ellipse cx="16.4" cy="28.1" rx="9.4" ry="2.15" />
      </svg>
      <svg className="marks-icon-body" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <path className="marks-icon-side" d="M22.1 9.1 26.5 6.4v14.4L22.1 23.6z" />
        <path className="marks-icon-top" d="M9.7 9.1h12.4l4.4-2.7H14.1z" />
        <rect className="marks-icon-face" x="9.7" y="9.1" width="12.4" height="14.5" rx="3.1" />
        <path className="marks-icon-gloss" d="M11.1 10.4c3.4-1.15 8.2-1.05 10.1.9" />
        <g className="marks-icon-mark" transform="translate(10.35 11.15) scale(0.46)">
          <path d={resolved.mark} />
        </g>
      </svg>
    </span>
  );
}
