import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  danger?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, danger, className = '', type = 'button', title, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`icon-button${danger ? ' danger' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={title ?? label}
      {...props}
    >
      {icon}
    </button>
  );
});
