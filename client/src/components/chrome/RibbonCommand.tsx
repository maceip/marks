import type { ReactNode } from 'react';
import { Glyph, type GlyphName } from '../glyphs/Glyph';

interface RibbonCommandProps {
  glyph: GlyphName;
  label: string;
  title?: string;
  pressed?: boolean;
  disabled?: boolean;
  danger?: boolean;
  large?: boolean;
  onClick: () => void;
  children?: ReactNode;
}

export function RibbonCommand({
  glyph,
  label,
  title,
  pressed,
  disabled,
  danger,
  large,
  onClick,
  children,
}: RibbonCommandProps) {
  return (
    <button
      type="button"
      className={`ribbon-command${pressed ? ' active' : ''}${danger ? ' danger-command' : ''}${large ? ' ribbon-command-large' : ''}`}
      title={title ?? label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Glyph name={glyph} size={large ? 28 : 22} />
      <span className="ribbon-command-label">{label}</span>
      {children}
    </button>
  );
}

interface RibbonGroupProps {
  label: string;
  children: ReactNode;
  onLaunch?: () => void;
  launchLabel?: string;
}

export function RibbonGroup({ label, children, onLaunch, launchLabel }: RibbonGroupProps) {
  return (
    <div className="ribbon-command-group">
      <div className="ribbon-command-row">{children}</div>
      <span className="ribbon-group-label">
        {label}
        {onLaunch && (
          <button
            type="button"
            className="ribbon-launcher"
            aria-label={launchLabel ?? `More ${label} options`}
            onClick={onLaunch}
          >
            ▢
          </button>
        )}
      </span>
    </div>
  );
}
