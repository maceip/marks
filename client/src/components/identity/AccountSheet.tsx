import { useEffect, useState } from 'react';
import { fetchSession, listDevices, logout, revokeDevice, type DeviceInventory, type SessionInfo } from '../../auth/identity';
import { storagePersisted } from '../../auth/durable-storage';
import { keys } from 'idb-keyval';
import { LOGOUT_LOCAL_LINE, RETURN_VISIT_STEPS, REVOKE_LOCAL_LINE, ROLE_COPY, SCRATCH_HONEST_LINE } from '../../lib/identity-copy';
import { UI_DATA_MODE } from '../../lib/product';
import { SERVICE_ERROR_COPY } from '../../lib/service-errors';
import { Icon, icons } from '../ui/Icon';

interface AccountSheetProps {
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onSignedOut?: () => void;
}

export function AccountSheet({ onNotify, onSignedOut }: AccountSheetProps) {
  const service = UI_DATA_MODE === 'service';
  const [deviceKeyPresent, setDeviceKeyPresent] = useState(false);
  const [persisted, setPersisted] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [inventory, setInventory] = useState<DeviceInventory | null>(null);

  useEffect(() => {
    void keys().then((stored) => {
      setDeviceKeyPresent(stored.some((key) => String(key).startsWith('marks.auth.device-key.v1.')));
    });
    void storagePersisted().then(setPersisted);
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
      onNotify('Logged Out', 'This browser is anonymous again. Its public pages remain available by URL.', 'success');
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
      onNotify('Device removed', 'This browser will no longer log in automatically.', 'success');
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
          <strong>{session ? 'Logged In' : 'Not Logged In'}</strong>
          {session
            ? 'Your account pages are available on every device where you log in.'
            : SCRATCH_HONEST_LINE}
        </span>
      </div>

      <section className="identity-section">
        <h3>Login</h3>
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
                  <strong>{device.deviceId === session?.deviceId ? 'This browser' : 'Other logged-in device'}</strong>
                  <small>
                    {device.revokedAtMs
                      ? 'Removed. It cannot log in automatically.'
                      : 'This device can restore its login securely.'}
                  </small>
                </li>
              ))
            : (
              <li>
                <strong>This browser</strong>
                <small>
                  {deviceKeyPresent
                    ? 'This browser can restore its login securely.'
                    : 'This browser is not registered for automatic login yet.'}
                </small>
              </li>
            )}
          <li>
            <strong>{persisted ? 'Login storage is protected' : 'Login storage may be cleared'}</strong>
            <small>
              {persisted
                ? 'This browser granted persistent storage for your login.'
                : 'The browser may clear login storage when this site is unused. Installing the app can make it more durable.'}
            </small>
          </li>
        </ul>
      </section>

      <section className="identity-section">
        <h3>Account phone</h3>
        <ul className="account-list">
          {(inventory?.controllers ?? []).filter((entry) => !entry.revokedAtMs).length > 0
            ? inventory!.controllers
                .filter((entry) => !entry.revokedAtMs)
                .map((entry) => (
                  <li key={entry.controllerId}>
                    <strong>Account phone</strong>
                    <small>This phone can approve a login or remove a device.</small>
                  </li>
                ))
            : (
              <li>
                <strong>No account phone</strong>
                <small>Log in from a laptop and scan its QR code to add one.</small>
              </li>
            )}
        </ul>
      </section>

      <section className="identity-section">
        <h3>Logged-in browsers</h3>
        <ul className="account-list">
          {(inventory?.sessions ?? []).filter((entry) => !entry.revokedAtMs).length > 0
            ? inventory!.sessions
                .filter((entry) => !entry.revokedAtMs)
                .map((entry) => (
                  <li key={entry.sessionId}>
                    <strong>{entry.sessionId === session?.sessionId ? 'This browser' : 'Another browser'}</strong>
                    <small>{entry.deviceBound ? 'Protected by this device.' : 'Logged in with a secure session.'}</small>
                  </li>
                ))
            : (
              <li>
                <strong>No active login</strong>
                <small>Choose Log In to use your account on this browser.</small>
              </li>
            )}
        </ul>
      </section>

      <p className="identity-note">
        Roles stay {ROLE_COPY.owner.label}, {ROLE_COPY.editor.label.toLowerCase()},{' '}
        {ROLE_COPY.commenter.label.toLowerCase()}, and {ROLE_COPY.viewer.label.toLowerCase()}.
        Account and device identifiers are not shown as a person.
      </p>

      <div className="dialog-actions">
        <button type="button" className="button" onClick={() => void revoke()}>
          Remove This Device
        </button>
        <button type="button" className="button" onClick={() => void signOut()}>
          Log Out
        </button>
      </div>
    </div>
  );
}
