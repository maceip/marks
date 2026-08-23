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
import { Icon, icons } from '../ui/Icon';

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
      onNotify('No pairing fragment', 'Local mode does not look up a four-word code.', 'neutral');
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
          ? 'Bootstrap creates the first principal on an unseen controller. No service is attached.'
          : 'Approve needs a controller session on the phone. This tab is not signed in.',
        action === 'bootstrap' ? SERVICE_ERROR_COPY[404].tone : SERVICE_ERROR_COPY[401].tone,
      );
      return;
    }
    if (!details || !proof) {
      onNotify('No pairing fragment', 'Scan the QR or type the four words first.', 'neutral');
      return;
    }
    setBusy(true);
    try {
      if (action === 'bootstrap') {
        await bootstrapPairing(details, proof);
        onNotify('Phone is the controller', 'The original tab will keep the workspace and sign in.', 'success');
      } else {
        await approvePairing(details, proof);
        onNotify('Device approved', 'The original tab will finalize and drop scratch.', 'success');
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
        <Icon path={resolvedState === 'ready' || details ? icons.check : icons.share} size={15} />
        <span>
          <strong>
            {details
              ? 'Pairing ready'
              : resolvedState === 'invalid'
                ? 'Authentication failed'
                : 'Waiting for a scan'}
          </strong>
          {details
            ? 'This phone can create the first controller or approve an existing one. Identifiers are not shown as a person.'
            : resolvedState === 'invalid'
              ? SERVICE_ERROR_COPY[401].detail
              : 'Scan the QR, paste the secure link, or type the four words.'}
        </span>
      </div>

      <label className="pairing-words-entry">
        <strong>Four words</strong>
        <input
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="four words from the other device"
          value={words}
          onChange={(event) => setWords(event.target.value)}
        />
      </label>

      <ul className="account-list">
        <li>
          <strong>Inspect</strong>
          <small>
            {details
              ? `Expires soon. Pending device is bound. Origin is ${details.origin}.`
              : 'Origin, pending device, and expiry. A guessed id without the secret is the same as a missing one.'}
          </small>
        </li>
        <li>
          <strong>First phone</strong>
          <small>Bootstrap creates one principal. A 409 means another request won — do not retry into a second account.</small>
        </li>
        <li>
          <strong>Existing phone</strong>
          <small>
            {controller
              ? 'This phone already has a controller key. Approve enrolls the other browser.'
              : 'Approve enrolls this browser. The original tab then finalizes and drops scratch.'}
          </small>
        </li>
      </ul>

      <div className="dialog-actions pairing-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void submitWords()}>
          Use words
        </button>
        <button type="button" className="button" disabled={busy || !details} onClick={() => void run('bootstrap')}>
          First phone
        </button>
        <button type="button" className="button primary" disabled={busy || !details} onClick={() => void run('approve')}>
          Approve
        </button>
      </div>
    </div>
  );
}
