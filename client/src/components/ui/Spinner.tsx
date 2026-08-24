import type { HTMLAttributes } from 'react';
export function Spinner({ className = '', ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span role="status" aria-label="Loading" {...props} className={`ui-spinner${className ? ` ${className}` : ''}`} />;
}
