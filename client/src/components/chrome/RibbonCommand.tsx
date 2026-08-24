import type { ReactNode } from 'react';
import type { CommandRunStatus } from '../../commands/types.ts';
import { Glyph, type GlyphName } from '../glyphs/Glyph';

interface RibbonCommandProps {
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
  onClick,
  onContextMenu,
  children,
}: RibbonCommandProps) {
  return (
    <button
      type="button"
      className={`ribbon-command${pressed ? ' active' : ''}${danger ? ' danger-command' : ''}${large ? ' ribbon-command-large' : ''}${agentRaised ? ' agent-raised' : ''}${agentState ? ` agent-${agentState}` : ''}`}
      data-command-id={commandId}
      data-agent-state={agentState}
      title={title ?? label}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={agentState === 'running' || undefined}
      disabled={disabled}
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
    </button>
  );
}

interface RibbonGroupProps {
  label: string;
  children: ReactNode;
  onLaunch?: () => void;
  launchLabel?: string;
  agentRaised?: boolean;
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
