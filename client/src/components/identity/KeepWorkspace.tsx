import { SCRATCH_HONEST_LINE, SCRATCH_LOCAL_LINE, SCRATCH_UPGRADE_LINE } from '../../lib/identity-copy';
import { Icon, icons } from '../Icon';

interface KeepWorkspaceProps {
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

export function KeepWorkspace({ onNotify }: KeepWorkspaceProps) {
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      onNotify('Keep link copied', 'This is a local page link, not a pairing ticket.', 'success');
    } catch {
      onNotify('Copy was blocked', 'The address bar still has this page.', 'danger');
    }
  };

  return (
    <div className="identity-dialog">
      <p className="identity-lede">{SCRATCH_UPGRADE_LINE}</p>
      <p className="identity-note">{SCRATCH_HONEST_LINE}</p>

      <div className="keep-stage" aria-hidden="true">
        <div className="keep-qr">
          <span />
          <span />
          <span />
          <span />
          <i />
        </div>
        <div>
          <strong>Phone controller</strong>
          <small>Scan a high-entropy QR. The phone becomes the controller for one principal. This browser keeps a silent device key.</small>
        </div>
      </div>

      <p className="identity-note">{SCRATCH_LOCAL_LINE}</p>

      <div className="dialog-actions">
        <button type="button" className="button primary" onClick={() => void copyLink()}>
          <Icon path={icons.link} /> Copy page link
        </button>
      </div>
    </div>
  );
}
