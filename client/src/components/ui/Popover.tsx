import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { SurfaceMaterial } from './SurfaceMaterial';

export function Popover({
  open,
  title,
  children,
  onClose,
  className = '',
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className={`ui-popover motion-popover-in surface-material-host${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${uid}-title`}
    >
      <SurfaceMaterial variant="floating" />
      <header className="ui-popover-head">
        <strong id={`${uid}-title`}>{title}</strong>
        <button type="button" className="ui-control icon-button icon-button-small" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="ui-popover-body">{children}</div>
    </div>
  );
}
