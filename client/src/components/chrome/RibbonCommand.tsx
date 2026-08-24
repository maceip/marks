import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import type { CommandRunStatus } from '../../commands/types.ts';
import { Glyph, type GlyphName } from '../glyphs/Glyph';

export interface RibbonCommandProps {
  glyph: GlyphName;
  label: string;
  title?: string;
  pressed?: boolean;
  disabled?: boolean;
  danger?: boolean;
  large?: boolean;
  commandId?: string;
  agentState?: CommandRunStatus;
  agentRaised?: boolean;
  loading?: boolean;
  className?: string;
  onClick: () => void;
  onContextMenu?: () => void;
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
  commandId,
  agentState,
  agentRaised,
  loading,
  className,
  onClick,
  onContextMenu,
  children,
}: RibbonCommandProps) {
  return (
    <button
      type="button"
      className={`ribbon-command${pressed ? ' active' : ''}${danger ? ' danger-command' : ''}${large ? ' ribbon-command-large' : ''}${agentRaised ? ' agent-raised' : ''}${agentState ? ` agent-${agentState}` : ''}${className ? ` ${className}` : ''}`}
      data-command-id={commandId}
      data-agent-state={agentState}
      data-loading={loading || undefined}
      data-danger={danger || undefined}
      title={title ?? label}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || agentState === 'running' || undefined}
      disabled={disabled || loading}
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => {
        if (!onContextMenu) return;
        event.preventDefault();
        onContextMenu();
      }}
      onClick={onClick}
    >
      <Glyph name={glyph} size={large ? 28 : 22} />
      <span className="ribbon-command-label">{label}</span>
      {children}
      {loading && <span className="button-spinner" aria-hidden="true"><span className="ui-spinner" /></span>}
    </button>
  );
}

export interface RibbonGroupProps {
  label: string;
  children: ReactNode;
  onLaunch?: () => void;
  launchLabel?: string;
  agentRaised?: boolean;
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

export function RibbonDeck({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ribbon-deck${className ? ` ${className}` : ''}`} {...props}>{children}</div>;
}

export function RibbonToolbar({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ribbon-toolbar${className ? ` ${className}` : ''}`} role="toolbar" {...props}>{children}</div>;
}

export function RibbonGallery({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ribbon-gallery${className ? ` ${className}` : ''}`} {...props}>{children}</div>;
}

export function RibbonGroup({ label, children, onLaunch, launchLabel, agentRaised }: RibbonGroupProps) {
  return (
    <div className={`ribbon-command-group${agentRaised ? ' agent-raised' : ''}`}>
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
