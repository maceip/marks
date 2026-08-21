import type { Peer } from '../collab/types';
import { colorVar, initials } from '../collab/user';

interface PresenceBarProps {
  peers: Peer[];
  max?: number;
}

export function PresenceBar({ peers, max = 5 }: PresenceBarProps) {
  const shown = peers.slice(0, max);
  const overflow = peers.length - shown.length;

  return (
    <div className="presence" aria-label={`${peers.length} people here`}>
      {shown.map((peer) => (
        <span
          key={peer.id}
          className={`avatar${peer.self ? ' avatar-self' : ''}`}
          style={{ '--avatar-color': colorVar(peer.colorIndex) } as React.CSSProperties}
          title={peer.self ? `${peer.name} (you)` : peer.name}
        >
          {initials(peer.name)}
        </span>
      ))}
      {overflow > 0 && <span className="avatar avatar-overflow">+{overflow}</span>}
    </div>
  );
}
