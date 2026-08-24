import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ButtonSize, ButtonTone } from './Button';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  size?: ButtonSize;
  tone?: ButtonTone;
  loading?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className = '', disabled, icon, label, loading, size = 'medium', tone = 'neutral', type = 'button', ...props }, ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={label}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      data-tone={tone}
      className={`ui-control icon-button icon-button-${size}${className ? ` ${className}` : ''}`}
    >
      <span className="icon-button-face">{icon}</span>
      {loading && <span className="button-spinner" aria-hidden="true"><span className="ui-spinner" /></span>}
    </button>
  );
});
