import { SurfaceMaterial } from '../components/ui/SurfaceMaterial';
import { PairingInspect } from '../components/identity/PairingInspect';
import { MarksMark } from '../components/ui/MarksMark';
import type { PairingLink } from '../auth/protocol';
import '../styles/home.css';

interface LinkPageProps {
  pairing: PairingLink | 'invalid' | null;
  onNotify: (title: string, detail?: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onKeep: () => void;
}

/** Phone-side login approval surface. Same tokens as the desktop identity chrome. */
export function LinkPage({ pairing, onNotify, onKeep }: LinkPageProps) {
  const state = pairing === 'invalid' ? 'invalid' : pairing ? 'ready' : 'waiting';

  return (
    <div className="home-surface pairing-landing">
      <section className="home-hero surface-material-host">
        <SurfaceMaterial variant="hero" />
        <div className="home-hero-copy">
          <span className="home-kicker"><MarksMark size={16} /> Log In</span>
          <h2>Finish logging in on your phone.</h2>
          <p>
            Scan the QR, or type the four words if this client cannot scan. The secret stays in the
            fragment or the words. This page does not invent a password, a passcode, or a sent
            invitation.
          </p>
        </div>
      </section>
      <section className="home-section pairing-landing-body">
        <PairingInspect state={state} pairing={pairing} onNotify={onNotify} />
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onKeep}>
            Open Login Help
          </button>
        </div>
      </section>
    </div>
  );
}
