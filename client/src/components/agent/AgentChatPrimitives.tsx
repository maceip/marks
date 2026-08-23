import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { Glyph, type GlyphName } from '../glyphs/Glyph';
import { SurfaceMaterial } from '../ui/SurfaceMaterial';

export function PillSurface({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`agent-chat-surface surface-material-host ${className}`}><SurfaceMaterial variant="floating" />{children}</div>;
}

export function AgentIconButton({ glyph, tooltip, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { glyph: GlyphName; tooltip: string }) {
  return <button type="button" className="agent-chat-icon-button" aria-label={tooltip} data-tooltip={tooltip} {...props}><Glyph name={glyph} size={18} interactive={false} /></button>;
}

export const PromptInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function PromptInput(props, ref) {
  return <input ref={ref} className="agent-chat-input" type="text" {...props} />;
});

export function StatusIndicator({ active, label }: { active: boolean; label: string }) {
  return <span className={`agent-chat-status${active ? ' active' : ''}`} aria-hidden="true"><span />{label}</span>;
}

export function AgentActionButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className="agent-chat-action" {...props}>{children}</button>;
}
