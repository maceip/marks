import type { HTMLAttributes, ReactNode } from 'react';
export function Pill({ children, className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
  return <span {...props} className={`ui-pill${className ? ` ${className}` : ''}`}>{children}</span>;
}
