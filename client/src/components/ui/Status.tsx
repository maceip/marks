import type { ReactNode } from 'react';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export function Status({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={`ds-status ds-status-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
    <span className="ds-status-dot" aria-hidden="true" />{children}
  </span>;
}
