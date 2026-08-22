import { ROLE_COPY, SCRATCH_HONEST_LINE } from '../../lib/identity-copy';
import { Icon, icons } from '../Icon';

interface AccountSheetProps {
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onKeep: () => void;
}

export function AccountSheet({ onNotify, onKeep }: AccountSheetProps) {
  return (
    <div className="identity-dialog">
      <div className="local-notice">
        <Icon path={icons.check} size={15} />
        <span>
          <strong>Temporary workspace</strong>
          {SCRATCH_HONEST_LINE}
        </span>
      </div>

      <ul className="account-list">
        <li>
          <strong>This browser</strong>
          <small>A linked device can sign itself back in. It cannot enroll another device.</small>
        </li>
        <li>
          <strong>No phone controller yet</strong>
          <small>The phone rail enrolls or revokes devices. Ordinary return visits use a session cookie, then a silent device key.</small>
        </li>
        <li>
          <strong>Not a named account</strong>
          <small>Scratch, device, and site identifiers are never shown as a person.</small>
        </li>
      </ul>

      <p className="identity-note">
        Document roles stay {ROLE_COPY.owner.label}, {ROLE_COPY.editor.label.toLowerCase()},{' '}
        {ROLE_COPY.commenter.label.toLowerCase()}, and {ROLE_COPY.viewer.label.toLowerCase()}.
      </p>

      <div className="dialog-actions">
        <button type="button" className="button" onClick={onKeep}>
          Keep this workspace
        </button>
        <button
          type="button"
          className="button"
          onClick={() =>
            onNotify(
              'Still a temporary tab',
              'There is no remote session to sign out of in this prototype.',
              'neutral',
            )
          }
        >
          Leave scratch
        </button>
      </div>
    </div>
  );
}
