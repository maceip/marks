import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, icons } from './Icon';
import { SurfaceMaterial } from './SurfaceMaterial';

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  size?: 'small' | 'medium' | 'large';
  children: ReactNode;
  onClose: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, title, description, size = 'medium', children, onClose }: ModalProps) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [mounted, open]);

  useEffect(() => {
    if (!mounted || closing) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    root?.setAttribute('aria-hidden', 'true');

    const focusable = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    requestAnimationFrame(() => {
      const preferred = panelRef.current?.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? focusable()[0])?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      root?.removeAttribute('inert');
      root?.removeAttribute('aria-hidden');
      previous?.focus();
    };
  }, [closing, mounted, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className={`modal-layer${closing ? ' is-closing' : ''}`}>
      <button type="button" className="modal-scrim" aria-label="Close dialog" onClick={onClose} />
      <div
        className={`modal-card modal-${size} surface-material-host`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="marks-modal-title"
        aria-describedby={description ? 'marks-modal-description' : undefined}
        ref={panelRef}
      >
        <SurfaceMaterial variant="floating" />
        <header className="modal-head">
          <div>
            <h2 id="marks-modal-title">{title}</h2>
            {description && <p id="marks-modal-description">{description}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon path={icons.close} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
