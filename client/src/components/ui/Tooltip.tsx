import type { ReactNode } from 'react';

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return <span className="ds-tooltip" data-tooltip={label}>{children}</span>;
}
