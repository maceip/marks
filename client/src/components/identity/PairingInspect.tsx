import { useEffect, useState } from 'react';
import {
  approvePairing,
  bootstrapPairing,
  fetchSession,
  inspectPairing,
  lookupPairingWords,
  type PairingDetails,
} from '../../auth/identity';
import { loadActiveDevice } from '../../auth/active-device';
import { encodeBase64Url, type PairingLink } from '../../auth/protocol';
import { SERVICE_ERROR_COPY } from '../../lib/service-errors';
import { UI_DATA_MODE } from '../../lib/product';
import '../../styles/overlays.css';
import { Icon } from '../ui';

interface PairingInspectProps {
  state?: 'waiting' | 'ready' | 'invalid';
  pairing?: PairingLink | 'invalid' | null;
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

function copyForFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('409')) return SERVICE_ERROR_COPY[409];
  if (message.includes('403')) return SERVICE_ERROR_COPY[403];
  if (message.includes('404')) return SERVICE_ERROR_COPY[404];
  return SERVICE_ERROR_COPY[401];
}

export function PairingInspect({ state, pairing, onNotify }: PairingInspectProps) {
  const service = UI_DATA_MODE === 'service';
  const fragment = pairing && pairing !== 'invalid' ? pairing : null;
  const [words, setWords] = useState('');
  const [details, setDetails] = useState<PairingDetails | null>(null);
  const [proof, setProof] = useState<{ secret?: string; words?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [controller, setController] = useState(false);

  useEffect(() => {
    void loadActiveDevice().then((active) => setController(Boolean(active?.controllerId)));
    void fetchSession();
  }, []);

  useEffect(() => {
    if (!service || !fragment) return;
    let cancelled = false;
    void inspectPairing(fragment.pairingId, encodeBase64Url(fragment.secret))
      .then((next) => {
        if (cancelled) return;
        setDetails(next);
        setProof({ secret: encodeBase64Url(fragment.secret) });
      })
      .catch((error: unknown) => {
        if (!cancelled) onNotify(copyForFailure(error).title, copyForFailure(error).detail, copyForFailure(error).tone);
      });
    return () => {
      cancelled = true;
    };
  }, [fragment, onNotify, service]);

  const resolvedState = details ? 'ready' : state === 'invalid' || pairing === 'invalid' ? 'invalid' : fragment ? 'ready' : 'waiting';

  const submitWords = async () => {
    if (!service) {
      onNotify('No login request', 'Local mode cannot look up a login code.', 'neutral');
      return;
    }
    setBusy(true);
    try {
      const next = await lookupPairingWords(words);
      setDetails(next);
      setProof({ words });
    } catch (error) {
      onNotify(copyForFailure(error).title, copyForFailure(error).detail, copyForFailure(error).tone);
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: 'bootstrap' | 'approve') => {
    if (!service) {
      onNotify(
        action === 'bootstrap' ? SERVICE_ERROR_COPY[404].title : SERVICE_ERROR_COPY[401].title,
        action === 'bootstrap'
          ? 'A connected service is required to create an account.'
          : 'Log in on this phone before approving another browser.',
        action === 'bootstrap' ? SERVICE_ERROR_COPY[404].tone : SERVICE_ERROR_COPY[401].tone,
      );
      return;
    }
    if (!details || !proof) {
      onNotify('No login request', 'Scan the QR code or enter the login code first.', 'neutral');
      return;
    }
    setBusy(true);
    try {
      if (action === 'bootstrap') {
        await bootstrapPairing(details, proof);
        onNotify('Account Created', 'Return to the original browser; it will finish logging in.', 'success');
      } else {
        await approvePairing(details, proof);
        onNotify('Login Approved', 'Return to the original browser; it will finish logging in.', 'success');
      }
    } catch (error) {
      onNotify(copyForFailure(error).title, copyForFailure(error).detail, copyForFailure(error).tone);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="identity-dialog pairing-inspect">
      <div className={`local-notice${resolvedState === 'invalid' ? ' local-notice-danger' : ''}`}>
        <Icon name={resolvedState === 'ready' || details ? 'check' : 'share'} size={15} />
        <span>
          <strong>
            {details
              ? 'Ready to Log In'
              : resolvedState === 'invalid'
                ? 'Login Failed'
                : 'Waiting for a QR Code'}
          </strong>
          {details
            ? 'Create an account if you are new to Marks, or approve the login if you already have one.'
            : resolvedState === 'invalid'
              ? SERVICE_ERROR_COPY[401].detail
              : 'Scan the QR code, open the secure link, or enter the four-word login code.'}
        </span>
      </div>

      <label className="pairing-words-entry">
        <strong>Login code</strong>
        <input
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="four words from the other browser"
          value={words}
          onChange={(event) => setWords(event.target.value)}
        />
      </label>

      <ul className="account-list">
        <li>
          <strong>Login request</strong>
          <small>
            {details
              ? `This request expires soon and came from ${details.origin}.`
              : 'Open the secure login request from your other browser.'}
          </small>
        </li>
        <li>
          <strong>New to Marks</strong>
          <small>Create an account and log in the other browser.</small>
        </li>
        <li>
          <strong>Already have an account</strong>
          <small>
            {controller
              ? 'Approve the login to use your account on the other browser.'
              : 'Log in on this phone before approving another browser.'}
          </small>
        </li>
      </ul>

      <div className="dialog-actions pairing-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void submitWords()}>
          Use Login Code
        </button>
        <button type="button" className="button" disabled={busy || !details} onClick={() => void run('bootstrap')}>
          Create Account
        </button>
        <button type="button" className="button primary" disabled={busy || !details} onClick={() => void run('approve')}>
          Approve Log In
        </button>
      </div>
    </div>
  );
}
