import { SERVICE_ERROR_COPY } from '../../lib/service-errors';
import '../../styles/overlays.css';
import { Icon, icons } from '../ui/Icon';

interface PairingInspectProps {
  state: 'waiting' | 'ready' | 'invalid';
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

export function PairingInspect({ state, onNotify }: PairingInspectProps) {
  const inspect = () => {
    if (state === 'invalid') {
      onNotify(SERVICE_ERROR_COPY[401].title, SERVICE_ERROR_COPY[401].detail, SERVICE_ERROR_COPY[401].tone);
      return;
    }
    if (state === 'waiting') {
      onNotify('No pairing fragment', 'The phone confirmation reads #v1.pairingId.secret. Nothing was minted on this tab.', 'neutral');
      return;
    }
    onNotify(
      SERVICE_ERROR_COPY[401].title,
      'Inspect is a phone confirmation. This prototype does not call the pairing service.',
      'neutral',
    );
  };

  const approve = () => {
    onNotify(
      SERVICE_ERROR_COPY[401].title,
      'Approve needs a controller session on the phone. This tab is not signed in.',
      SERVICE_ERROR_COPY[401].tone,
    );
  };

  const bootstrap = () => {
    onNotify(
      SERVICE_ERROR_COPY[404].title,
      'Bootstrap creates the first principal on an unseen controller. No service is attached.',
      SERVICE_ERROR_COPY[404].tone,
    );
  };

  return (
    <div className="identity-dialog pairing-inspect">
      <div className={`local-notice${state === 'invalid' ? ' local-notice-danger' : ''}`}>
        <Icon path={state === 'ready' ? icons.check : icons.share} size={15} />
        <span>
          <strong>
            {state === 'ready' ? 'Pairing fragment present' : state === 'invalid' ? 'Authentication failed' : 'Waiting for a scan'}
          </strong>
          {state === 'ready'
            ? 'The secret stays in the fragment. Identifiers are not shown as a person.'
            : state === 'invalid'
              ? SERVICE_ERROR_COPY[401].detail
              : 'Open this page from a pairing QR. The service fills the fragment.'}
        </span>
      </div>

      <ul className="account-list">
        <li>
          <strong>Inspect</strong>
          <small>Origin, pending device, and expiry. A guessed id without the secret is the same as a missing one.</small>
        </li>
        <li>
          <strong>First phone</strong>
          <small>Bootstrap creates one principal. A 409 means another request won — do not retry into a second account.</small>
        </li>
        <li>
          <strong>Existing phone</strong>
          <small>Approve enrolls this browser. The original tab then finalizes and drops scratch.</small>
        </li>
      </ul>

      <div className="dialog-actions pairing-actions">
        <button type="button" className="button" onClick={inspect}>
          Inspect
        </button>
        <button type="button" className="button" onClick={bootstrap}>
          First phone
        </button>
        <button type="button" className="button primary" onClick={approve}>
          Approve
        </button>
      </div>
    </div>
  );
}
