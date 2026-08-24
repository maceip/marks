import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonSize = 'small' | 'medium' | 'large';
export type ButtonTone = 'neutral' | 'accent' | 'danger';
export type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'danger' | 'link';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: ButtonSize;
  tone?: ButtonTone;
  variant?: ButtonVariant;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { children, className = '', disabled, leadingIcon, loading = false, size = 'medium', tone, trailingIcon, type = 'button', variant = 'secondary', ...props },
  ref,
) {
  const resolvedTone = tone ?? (variant === 'danger' ? 'danger' : variant === 'primary' ? 'accent' : 'neutral');
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      data-tone={resolvedTone}
      className={`ui-control button button-${variant} button-${size} ${variant}${className ? ` ${className}` : ''}`}
    >
      {leadingIcon && <span className="button-icon" aria-hidden="true">{leadingIcon}</span>}
      <span className="button-label">{children}</span>
      {trailingIcon && <span className="button-icon" aria-hidden="true">{trailingIcon}</span>}
      {loading && <span className="button-spinner" aria-hidden="true"><span className="ui-spinner" /></span>}
    </button>
  );
});
