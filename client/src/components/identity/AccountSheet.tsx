import { useEffect, useState } from 'react';
import { fetchSession, listDevices, logout, revokeDevice, type DeviceInventory, type SessionInfo } from '../../auth/identity';
import { keys } from 'idb-keyval';
import { LOGOUT_LOCAL_LINE, RETURN_VISIT_STEPS, REVOKE_LOCAL_LINE, ROLE_COPY, SCRATCH_HONEST_LINE } from '../../lib/identity-copy';
import { UI_DATA_MODE } from '../../lib/product';
import { SERVICE_ERROR_COPY } from '../../lib/service-errors';
import { Icon, icons } from '../ui/Icon';

interface AccountSheetProps {
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onKeep: () => void;
  onSignedOut?: () => void;
}

export function AccountSheet({ onNotify, onKeep, onSignedOut }: AccountSheetProps) {
  const service = UI_DATA_MODE === 'service';
  const [deviceKeyPresent, setDeviceKeyPresent] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [inventory, setInventory] = useState<DeviceInventory | null>(null);

  useEffect(() => {
    void keys().then((stored) => {
      setDeviceKeyPresent(stored.some((key) => String(key).startsWith('marks.auth.device-key.v1.')));
    });
  }, []);

  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    void fetchSession()
      .then(async (next) => {
        if (cancelled) return;
        setSession(next);
        if (!next) return;
        try {
          setInventory(await listDevices());
        } catch {
          setInventory(null);
        }
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, [service]);

  const signOut = async () => {
    if (!service || !session) {
      onNotify(SERVICE_ERROR_COPY[401].title, LOGOUT_LOCAL_LINE, 'neutral');
      return;
    }
    try {
      await logout();
      setSession(null);
      setInventory(null);
      onNotify('Signed out', 'This tab is a temporary workspace again until you keep it.', 'success');
      onSignedOut?.();
    } catch {
      onNotify(SERVICE_ERROR_COPY[403].title, SERVICE_ERROR_COPY[403].detail, SERVICE_ERROR_COPY[403].tone);
    }
  };

  const revoke = async () => {
    if (!service || !session) {
      onNotify(SERVICE_ERROR_COPY[403].title, REVOKE_LOCAL_LINE, 'neutral');
      return;
    }
    try {
      await revokeDevice(session.deviceId);
      onNotify('Device revoked', 'This browser cannot silently sign in again.', 'success');
      onSignedOut?.();
    } catch {
      onNotify(SERVICE_ERROR_COPY[403].title, SERVICE_ERROR_COPY[403].detail, SERVICE_ERROR_COPY[403].tone);
    }
  };

  return (
    <div className="identity-dialog">
      <div className="local-notice">
        <Icon path={icons.check} size={15} />
        <span>
          <strong>{session ? 'Kept workspace' : 'Temporary workspace'}</strong>
          {session
            ? 'This tab has a rotating session. Documents you keep are visible on every linked device.'
            : SCRATCH_HONEST_LINE}
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
          {(inventory?.devices ?? []).length > 0
            ? inventory!.devices.map((device) => (
                <li key={device.deviceId}>
                  <strong>{device.deviceId === session?.deviceId ? 'This browser' : 'Linked device'}</strong>
                  <small>
                    {device.revokedAtMs
                      ? 'Revoked. It cannot mint a new session.'
                      : 'A silent device key. It can redeem a session. It cannot enroll another device.'}
                  </small>
                </li>
              ))
            : (
              <li>
                <strong>This browser</strong>
                <small>
                  {deviceKeyPresent
                    ? 'A silent device key is stored here. Binding happens once and does not promote the workspace.'
                    : 'No device key on this tab yet. Binding happens once, after the key exists, and does not promote the workspace.'}
                </small>
              </li>
            )}
        </ul>
      </section>

      <section className="identity-section">
        <h3>Controllers</h3>
        <ul className="account-list">
          {(inventory?.controllers ?? []).filter((entry) => !entry.revokedAtMs).length > 0
            ? inventory!.controllers
                .filter((entry) => !entry.revokedAtMs)
                .map((entry) => (
                  <li key={entry.controllerId}>
                    <strong>Phone controller</strong>
                    <small>This controller can enroll or revoke devices. A linked laptop cannot enroll another laptop.</small>
                  </li>
                ))
            : (
              <li>
                <strong>No phone controller</strong>
                <small>The phone rail enrolls or revokes devices. A linked laptop cannot enroll another laptop.</small>
              </li>
            )}
        </ul>
      </section>

      <section className="identity-section">
        <h3>Sessions</h3>
        <ul className="account-list">
          {(inventory?.sessions ?? []).filter((entry) => !entry.revokedAtMs).length > 0
            ? inventory!.sessions
                .filter((entry) => !entry.revokedAtMs)
                .map((entry) => (
                  <li key={entry.sessionId}>
                    <strong>{entry.sessionId === session?.sessionId ? 'This tab' : 'Another session'}</strong>
                    <small>CSRF for logout and revoke stays in memory. It is not persisted.</small>
                  </li>
                ))
            : (
              <li>
                <strong>No live session</strong>
                <small>CSRF for logout and revoke stays in memory after a session probe. It is not persisted.</small>
              </li>
            )}
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
        <button type="button" className="button" onClick={() => void revoke()}>
          Revoke device
        </button>
        <button type="button" className="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
