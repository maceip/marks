import { useEffect, useState } from 'react';
import { keys } from 'idb-keyval';
import { LOGOUT_LOCAL_LINE, RETURN_VISIT_STEPS, REVOKE_LOCAL_LINE, ROLE_COPY, SCRATCH_HONEST_LINE } from '../../lib/identity-copy';
import { SERVICE_ERROR_COPY } from '../../lib/service-errors';
import { Icon, icons } from '../ui/Icon';

interface AccountSheetProps {
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onKeep: () => void;
}

export function AccountSheet({ onNotify, onKeep }: AccountSheetProps) {
  const [deviceKeyPresent, setDeviceKeyPresent] = useState(false);

  useEffect(() => {
    void keys().then((stored) => {
      setDeviceKeyPresent(stored.some((key) => String(key).startsWith('marks.auth.device-key.v1.')));
    });
  }, []);

  return (
    <div className="identity-dialog">
      <div className="local-notice">
        <Icon path={icons.check} size={15} />
        <span>
          <strong>Temporary workspace</strong>
          {SCRATCH_HONEST_LINE}
        </span>
      </div>

      <section className="identity-section">
        <h3>Return visit</h3>
        <ol className="identity-steps">
          {RETURN_VISIT_STEPS.map((step, index) => (
            <li key={step.title}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{step.title}</strong>
              <small>{step.detail}</small>
            </li>
          ))}
        </ol>
      </section>

      <section className="identity-section">
        <h3>Devices</h3>
        <ul className="account-list">
          <li>
            <strong>This browser</strong>
            <small>
              {deviceKeyPresent
                ? 'A silent device key is stored here. It can redeem a session. It cannot enroll another device.'
                : 'No device key on this tab yet. Binding happens once, after the key exists, and does not promote the workspace.'}
            </small>
          </li>
        </ul>
      </section>

      <section className="identity-section">
        <h3>Controllers</h3>
        <ul className="account-list">
          <li>
            <strong>No phone controller</strong>
            <small>The phone rail enrolls or revokes devices. A linked laptop cannot enroll another laptop.</small>
          </li>
        </ul>
      </section>

      <section className="identity-section">
        <h3>Sessions</h3>
        <ul className="account-list">
          <li>
            <strong>No live session</strong>
            <small>CSRF for logout and revoke stays in memory after a session probe. It is not persisted.</small>
          </li>
        </ul>
      </section>

      <p className="identity-note">
        Roles stay {ROLE_COPY.owner.label}, {ROLE_COPY.editor.label.toLowerCase()},{' '}
        {ROLE_COPY.commenter.label.toLowerCase()}, and {ROLE_COPY.viewer.label.toLowerCase()}.
        Scratch, device, and site identifiers are never shown as a person.
      </p>

      <div className="dialog-actions">
        <button type="button" className="button" onClick={onKeep}>
          Keep this workspace
        </button>
        <button
          type="button"
          className="button"
          onClick={() => onNotify(SERVICE_ERROR_COPY[403].title, REVOKE_LOCAL_LINE, 'neutral')}
        >
          Revoke device
        </button>
        <button
          type="button"
          className="button"
          onClick={() => onNotify(SERVICE_ERROR_COPY[401].title, LOGOUT_LOCAL_LINE, 'neutral')}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
