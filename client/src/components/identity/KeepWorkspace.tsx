import { useEffect, useRef, useState } from 'react';
import { getActiveCaller } from '../../auth/caller';
import { pollPairingUntilSettled } from '../../auth/pairing-poll.ts';
import { bindPendingDevice } from '../../auth/pending-device';
import { runWithTimeout, SERVICE_REQUEST_TIMEOUT_MS } from '../../browser/network.ts';
import {
  finalizePairing,
  mintPairing,
  pairingUrlFromTicket,
  selfBootstrap,
  type PairingTicket,
} from '../../auth/identity';
import {
  PAIRING_STEPS,
  SCRATCH_HONEST_LINE,
  SCRATCH_LOCAL_LINE,
  SCRATCH_UPGRADE_LINE,
  SELF_KEEP_DEVICE_LINE,
  SELF_KEEP_HONEST_LINE,
  SELF_KEEP_LOCAL_LINE,
  SELF_KEEP_PHONE_LINE,
} from '../../lib/identity-copy';
import { pairingLandingPath } from '../../lib/pairing-link';
import { UI_DATA_MODE } from '../../lib/product';
import { SERVICE_ERROR_COPY, copyForHttpStatus } from '../../lib/service-errors';
import { Icon, icons } from '../ui/Icon';
import { QrMark } from './QrMark';

interface KeepWorkspaceProps {
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onOpenPhone?: () => void;
  onPromoted?: () => void;
  /** Phone posture: this device has no second screen to scan from. */
  phone?: boolean;
}

function copyForFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const status = /\b(400|401|403|404|409|429)\b/u.exec(message);
  return copyForHttpStatus(status ? Number(status[1]) : 500);
}

export function KeepWorkspace({ onNotify, onOpenPhone, onPromoted, phone = false }: KeepWorkspaceProps) {
  const service = UI_DATA_MODE === 'service';
  // Reopening the dialog on an already-promoted tab shows the logged-in state
  // instead of an action that can only fail closed.
  const [alreadyKept] = useState(() => service && getActiveCaller()?.kind === 'session');
  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const [status, setStatus] = useState<'idle' | 'minting' | 'waiting' | 'kept' | 'failed'>(
    alreadyKept ? 'kept' : 'idle',
  );
  const [keeping, setKeeping] = useState(false);
  // On a phone there is nothing to scan this QR with. The preferred path is
  // opening the public page on a laptop; solo-phone bootstrap stays disclosed.
  const [pairingOpen, setPairingOpen] = useState(!phone && !alreadyKept);
  const onNotifyRef = useRef(onNotify);
  const onPromotedRef = useRef(onPromoted);
  onNotifyRef.current = onNotify;
  onPromotedRef.current = onPromoted;

  useEffect(() => {
    if (!service || !pairingOpen || alreadyKept) return;
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      setStatus('minting');
      try {
        await runWithTimeout(
          (signal) => bindPendingDevice(signal),
          SERVICE_REQUEST_TIMEOUT_MS,
          controller.signal,
        );
        const minted = await runWithTimeout(
          (signal) => mintPairing(signal),
          SERVICE_REQUEST_TIMEOUT_MS,
          controller.signal,
        );
        if (cancelled) return;
        setTicket(minted);
        setStatus('waiting');
        const result = await pollPairingUntilSettled({
          expiresAtMs: minted.expiresAtMs,
          signal: controller.signal,
          finalize: (signal) => finalizePairing(minted.pairingId, signal),
        });
        if (cancelled) return;
        if (result === 'gone') {
          setStatus('failed');
          return;
        }
        setStatus('kept');
        onNotifyRef.current('Logged in', 'This browser is linked and can open your account documents.', 'success');
        onPromotedRef.current?.();
      } catch {
        if (cancelled || controller.signal.aborted) return;
        setStatus('failed');
        onNotifyRef.current(SERVICE_ERROR_COPY[401].title, SERVICE_ERROR_COPY[401].detail, SERVICE_ERROR_COPY[401].tone);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort(new DOMException('Login dialog closed.', 'AbortError'));
    };
  }, [service, pairingOpen, alreadyKept]);

  const keepHere = async () => {
    if (!service) {
      onNotify('Kept in this browser', SELF_KEEP_LOCAL_LINE, 'neutral');
      return;
    }
    setKeeping(true);
    try {
      await runWithTimeout(
        (signal) => selfBootstrap(signal),
        SERVICE_REQUEST_TIMEOUT_MS,
      );
      setPairingOpen(false);
      setStatus('kept');
      onNotify(
        'Logged in',
        phone
          ? 'This phone now holds a solo account key. Link a laptop soon so the account does not depend on one phone.'
          : 'This device now holds the account key. Choose Log In on another device to link it.',
        'success',
      );
      onPromotedRef.current?.();
    } catch (error) {
      const copy = copyForFailure(error);
      onNotify(copy.title, copy.detail, copy.tone);
    } finally {
      setKeeping(false);
    }
  };

  const loggedIn = status === 'kept';
  const landing = ticket ? pairingUrlFromTicket(ticket) : pairingLandingPath(location.origin);

  const copyValue = async (value: string, title: string, detail: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onNotify(title, detail, 'success');
    } catch {
      onNotify('Copy was blocked', 'Type the four words or open /link on the phone.', 'danger');
    }
  };

  return (
    <div className="identity-dialog">
      <p className="identity-lede">
        {loggedIn
          ? 'You are logged in. Account documents open on every device you link.'
          : phone
            ? SELF_KEEP_PHONE_LINE
            : SCRATCH_UPGRADE_LINE}
      </p>
      {!loggedIn && <p className="identity-note">{SCRATCH_HONEST_LINE}</p>}

      {phone && !loggedIn && (
        <div className="mobile-login-path">
          <div className="keep-stage laptop-login-stage">
            <Icon path={icons.document} size={36} />
            <div>
              <strong>Open this page on a laptop</strong>
              <small>The page URL is already public. On the laptop, choose Log In and use the phone-link flow to join your account.</small>
            </div>
          </div>
          <button
            type="button"
            className="button primary"
            onClick={() => void copyValue(
              `${location.origin}${location.pathname}${location.search}`,
              'Laptop link copied',
              'Paste it into a browser on your laptop, then choose Log In.',
            )}
          >
            <Icon path={icons.link} /> Copy page link for laptop
          </button>
          <details className="keep-solo keep-solo-disclosure">
            <summary>Continue with only this phone</summary>
            <small>{SELF_KEEP_HONEST_LINE}</small>
            <button type="button" className="button" disabled={keeping} onClick={() => void keepHere()}>
              <Icon path={icons.check} /> Log in on this phone only
            </button>
          </details>
        </div>
      )}

      {loggedIn && (
        <div className="keep-stage">
          <div>
            <strong>You are logged in</strong>
            <small>Documents follow the account key on this device. Choose Log In on another device to link it.</small>
          </div>
        </div>
      )}

      {!loggedIn && pairingOpen && (
        <>
          <div className="keep-stage">
            <QrMark value={landing} label="QR for the Marks pairing ticket" />
            <div>
              <strong>Phone controller</strong>
              <small>
                {service
                  ? 'Scan the QR, or type the four words on a phone that cannot scan. The secret stays out of toasts.'
                  : 'This build shows the landing path. The service puts only the pairing URL in this QR.'}
              </small>
            </div>
          </div>

          {ticket && (
            <div className="pairing-words" aria-live="polite">
              <strong>Four words</strong>
              <p className="pairing-words-phrase">{ticket.words}</p>
              <small>For a phone, terminal, or other low-fidelity client that cannot scan.</small>
            </div>
          )}

          <ol className="identity-steps">
            {PAIRING_STEPS.map((step, index) => (
              <li key={step.title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
              </li>
            ))}
          </ol>

          {!service && <p className="identity-note">{SCRATCH_LOCAL_LINE}</p>}
          {service && status === 'waiting' && (
            <p className="identity-note">
              {phone
                ? 'Waiting for the device that already holds your account to confirm. This tab finalizes itself.'
                : 'Waiting for the phone to confirm. This tab finalizes itself.'}
            </p>
          )}
          {service && status === 'failed' && (
            <p className="identity-note">The pairing expired or failed. Open Log In again for a fresh code.</p>
          )}

          <div className="dialog-actions">
            <button
              type="button"
              className="button primary"
              onClick={() =>
                void copyValue(
                  ticket?.url ?? landing,
                  ticket ? 'Secure link copied' : 'Pairing path copied',
                  ticket
                    ? 'Open this on the phone. The secret is in the fragment.'
                    : 'This is /link. It is not a pairing ticket until the service mints one.',
                )
              }
            >
              <Icon path={icons.link} /> {ticket ? 'Copy secure link' : 'Copy /link'}
            </button>
            {ticket && (
              <button
                type="button"
                className="button"
                onClick={() => void copyValue(ticket.words, 'Four words copied', 'Type these on the phone confirmation page.')}
              >
                Copy words
              </button>
            )}
            {onOpenPhone && (
              <button type="button" className="button" onClick={onOpenPhone}>
                Open phone confirmation
              </button>
            )}
          </div>
        </>
      )}

      {!phone && !loggedIn && (
        <div className="keep-solo">
          <small>
            {SELF_KEEP_DEVICE_LINE} {SELF_KEEP_HONEST_LINE}
          </small>
          <button type="button" className="button" disabled={keeping} onClick={() => void keepHere()}>
            Log in on this device only
          </button>
        </div>
      )}
    </div>
  );
}
