import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonTone = 'default' | 'primary' | 'subtle' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  leading?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = 'default', leading, className = '', children, type = 'button', ...props },
  ref,
) {
  const tones = tone === 'default' ? '' : ` ${tone}`;
  return (
    <button ref={ref} type={type} className={`button${tones}${className ? ` ${className}` : ''}`} {...props}>
      {leading}
      {children}
    </button>
  );
});
