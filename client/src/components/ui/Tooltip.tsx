import type { ReactNode } from 'react';
export function Tooltip({ children, content }: { children: ReactNode; content: ReactNode }) {
  return <span className="ui-tooltip"><span className="ui-tooltip-trigger">{children}</span><span role="tooltip" className="ui-tooltip-content">{content}</span></span>;
}
