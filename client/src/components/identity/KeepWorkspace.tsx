import { PAIRING_STEPS, SCRATCH_HONEST_LINE, SCRATCH_LOCAL_LINE, SCRATCH_UPGRADE_LINE } from '../../lib/identity-copy';
import { pairingLandingPath } from '../../lib/pairing-link';
import { Icon, icons } from '../ui/Icon';
import { QrMark } from './QrMark';

interface KeepWorkspaceProps {
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onOpenPhone?: () => void;
}

export function KeepWorkspace({ onNotify, onOpenPhone }: KeepWorkspaceProps) {
  const landing = pairingLandingPath(location.origin);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(landing);
      onNotify('Pairing path copied', 'This is /link, the phone confirmation surface. It is not a pairing ticket.', 'success');
    } catch {
      onNotify('Copy was blocked', 'Open /link on the phone. The address bar still has this origin.', 'danger');
    }
  };

  return (
    <div className="identity-dialog">
      <p className="identity-lede">{SCRATCH_UPGRADE_LINE}</p>
      <p className="identity-note">{SCRATCH_HONEST_LINE}</p>

      <div className="keep-stage">
        <QrMark value={landing} label="QR for the Marks pairing landing page" />
        <div>
          <strong>Phone controller</strong>
          <small>
            The service puts only the pairing URL in this QR — <code>/link#v1.…</code>. This build
            shows the landing path. The secret never belongs in a toast.
          </small>
        </div>
      </div>

      <ol className="identity-steps">
        {PAIRING_STEPS.map((step, index) => (
          <li key={step.title}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
          </li>
        ))}
      </ol>

      <p className="identity-note">{SCRATCH_LOCAL_LINE}</p>

      <div className="dialog-actions">
        <button type="button" className="button primary" onClick={() => void copyLink()}>
          <Icon path={icons.link} /> Copy /link
        </button>
        {onOpenPhone && (
          <button type="button" className="button" onClick={onOpenPhone}>
            Open phone confirmation
          </button>
        )}
      </div>
    </div>
  );
}
