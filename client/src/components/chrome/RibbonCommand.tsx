import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Glyph, type GlyphName } from '../glyphs/Glyph';

export interface RibbonCommandProps {
  glyph: GlyphName;
  label: string;
  title?: string;
  pressed?: boolean;
  disabled?: boolean;
  danger?: boolean;
  large?: boolean;
  loading?: boolean;
  className?: string;
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
  loading,
  className,
  onClick,
  children,
}: RibbonCommandProps) {
  return (
    <button
      type="button"
      className={`ribbon-command${pressed ? ' active' : ''}${danger ? ' danger-command' : ''}${large ? ' ribbon-command-large' : ''}${className ? ` ${className}` : ''}`}
      title={title ?? label}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      data-danger={danger || undefined}
      disabled={disabled || loading}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Glyph name={glyph} size={large ? 28 : 22} />
      <span className="ribbon-command-label">{label}</span>
      {children}
    </button>
  );
}

export interface RibbonGroupProps {
  label: string;
  children: ReactNode;
  onLaunch?: () => void;
  launchLabel?: string;
}

export function RibbonTabList({ children, ...props }: HTMLAttributes<HTMLElement>) {
  return <nav className="ribbon-tabs" aria-label="Command ribbon" {...props}>{children}</nav>;
}

export interface RibbonTabButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected: boolean;
  contextual?: boolean;
}

export function RibbonTabButton({ selected, contextual, className, ...props }: RibbonTabButtonProps) {
  return <button type="button" role="tab" aria-selected={selected} className={`ribbon-tab${contextual ? ' contextual' : ''}${selected ? ' active' : ''}${className ? ` ${className}` : ''}`} {...props} />;
}

export function RibbonDeck({ children, className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`ribbon-deck${className ? ` ${className}` : ''}`} {...props}>{children}</div>;
}

export function RibbonToolbar({ children, className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`ribbon-toolbar${className ? ` ${className}` : ''}`} role="toolbar" {...props}>{children}</div>;
}

export function RibbonGallery({ children, className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`ribbon-gallery${className ? ` ${className}` : ''}`} {...props}>{children}</div>;
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
