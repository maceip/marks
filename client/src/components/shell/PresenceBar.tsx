import type { Peer } from '../../collab/types';
import { colorVar, initials } from '../../collab/user';
import { revealPresence } from '../../collab/presence';

interface PresenceBarProps {
  peers: Peer[];
  max?: number;
}

export function PresenceBar({ peers, max = 5 }: PresenceBarProps) {
  const people = [...new Map(peers.map((peer) => [peer.participantId, peer])).values()];
  const shown = people.slice(0, max);
  const overflow = people.length - shown.length;

  return (
    <div className="presence" aria-label={`${people.length} people here`}>
      {shown.map((peer) => (
        <span
          key={peer.participantId}
          className={`avatar${peer.self ? ' avatar-self' : ''}`}
          style={{ '--avatar-color': colorVar(peer.colorIndex) } as React.CSSProperties}
          title={peer.self ? `${peer.name} (you)` : peer.name}
          tabIndex={peer.self ? undefined : 0}
          onPointerEnter={() => !peer.self && revealPresence(peer.id)}
          onFocus={() => !peer.self && revealPresence(peer.id)}
        >
          {initials(peer.name)}
        </span>
      ))}
      {overflow > 0 && <span className="avatar avatar-overflow">+{overflow}</span>}
    </div>
  );
}
