import { Icon, icons } from '../ui/Icon';
import { MarksMark } from '../ui/MarksMark';

export interface ToastMessage {
  id: string;
  title: string;
  detail?: string;
  tone?: 'neutral' | 'success' | 'danger';
}

interface ToastRegionProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastRegion({ toasts, onDismiss }: ToastRegionProps) {
  return (
    <div className="toast-region" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone ?? 'neutral'}`}>
          <span className="toast-icon" aria-hidden="true">
            {toast.tone === 'success' ? <Icon path={icons.check} size={14} /> : <MarksMark size={17} />}
          </span>
          <div className="toast-copy">
            <strong>{toast.title}</strong>
            {toast.detail && <span>{toast.detail}</span>}
          </div>
          <button type="button" className="icon-button" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
            <Icon path={icons.close} size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
