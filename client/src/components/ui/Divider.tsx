import type { HTMLAttributes } from 'react';
export function Divider({ className = '', ...props }: HTMLAttributes<HTMLHRElement>) {
  return <hr {...props} className={`ui-divider${className ? ` ${className}` : ''}`} />;
}
