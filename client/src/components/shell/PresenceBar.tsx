import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Peer } from '../../collab/types';
import { colorVar, initials } from '../../collab/user';
import { Icon } from '../ui';

export interface ActiveParticipant extends Peer {
  activity: 'editing' | 'active';
  orderKey: string;
  connectionIds: string[];
}


/**
 * Presence policy: show self and every active remote person, aggregating their
 * tabs by participantId. Self is first, then editors, then active viewers;
 * ties use the immutable first connection id, never a mutable display name.
 */
export function normalizeActiveParticipants(peers: readonly Peer[]): ActiveParticipant[] {
  const people = new Map<string, ActiveParticipant>();
  for (const peer of peers) {
    const key = peer.participantId || peer.id;
    const previous = people.get(key);
    if (!previous) {
      people.set(key, { ...peer, activity: peer.selection ? 'editing' : 'active', orderKey: peer.joinedAt?.toString().padStart(16, '0') || peer.id, connectionIds: [peer.id] });
    } else {
      previous.connectionIds.push(peer.id);
      previous.self ||= peer.self;
      if (peer.selection) { previous.selection = peer.selection; previous.activity = 'editing'; }
      previous.orderKey = previous.orderKey < peer.id ? previous.orderKey : peer.id;
    }
  }
  return [...people.values()].sort((a, b) => Number(b.self) - Number(a.self) || Number(b.activity === 'editing') - Number(a.activity === 'editing') || a.orderKey.localeCompare(b.orderKey));
}

interface Props { peers: Peer[]; max?: number; onJump?: (peer: ActiveParticipant) => void }

function Avatar({ person }: { person: ActiveParticipant }) {
  const [broken, setBroken] = useState(false);
  return <span className={`avatar avatar-${person.activity}${person.self ? ' avatar-self' : ''}`} style={{ '--avatar-color': colorVar(person.colorIndex) } as CSSProperties} aria-hidden="true">
    {person.avatarUrl && !broken ? <img src={person.avatarUrl} alt="" onError={() => setBroken(true)} /> : initials(person.name)}
  </span>;
}

export function PresenceBar({ peers, max = 5, onJump }: Props) {
  const people = useMemo(() => normalizeActiveParticipants(peers), [peers]);
  const [open, setOpen] = useState(false);
  const [following, setFollowing] = useState<string>();
  const panel = useRef<HTMLDivElement>(null);
  const previous = useRef(new Map<string, string>());
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const next = new Map(people.map((p) => [p.participantId || p.id, p.name]));
    const joined = [...next].filter(([id]) => !previous.current.has(id)).map(([, name]) => `${name} joined`);
    const left = [...previous.current].filter(([id]) => !next.has(id)).map(([, name]) => `${name} left`);
    if (previous.current.size) setAnnouncement([...joined, ...left].join('. '));
    previous.current = next;
    if (following && !next.has(following)) setFollowing(undefined);
  }, [people, following]);
  useEffect(() => { if (open) requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('button')?.focus()); }, [open]);
  useEffect(() => {
    if (!following) return;
    const person = people.find((candidate) => (candidate.participantId || candidate.id) === following);
    if (person?.selection) onJump?.(person);
  }, [following, people, onJump]);
  const shown = people.slice(0, max);
  const keyNav = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button') || [])];
    if (!buttons.length) return;
    event.preventDefault(); const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  };
  return <div className="presence" aria-label={`${people.length} active ${people.length === 1 ? 'participant' : 'participants'}`}>
    <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
    {shown.map((person) => <button type="button" className="presence-avatar-button" key={person.participantId || person.id} title={`${person.name}${person.self ? ' (you)' : ''}, ${person.activity}`} onClick={() => setOpen(true)}><Avatar person={person} /><span className="sr-only">{person.name}, {person.activity}</span></button>)}
    {people.length > shown.length && <button type="button" className="avatar avatar-overflow" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>+{people.length - shown.length}</button>}
    {open && <div className="presence-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}><div className="presence-panel" role="dialog" aria-modal="true" aria-label="Active participants" ref={panel} onKeyDown={keyNav}>
      <header><strong>People here</strong><button type="button" onClick={() => setOpen(false)} aria-label="Close participant list"><Icon name="close" size={14} /></button></header>
      <ul>{people.map((person) => { const id = person.participantId || person.id; return <li key={id}><Avatar person={person} /><div className="presence-details"><strong>{person.name}{person.self ? ' (you)' : ''}</strong><span>{person.authenticated === false ? 'Guest · ' : person.authenticated ? 'Signed in · ' : ''}{person.activity} · {person.section || 'Document'}{person.connectionIds.length > 1 ? ` · ${person.connectionIds.length} tabs` : ''}</span></div>{!person.self && <div className="presence-actions"><button type="button" onClick={() => onJump?.(person)}>Jump</button><button type="button" aria-pressed={following === id} onClick={() => { const next = following === id ? undefined : id; setFollowing(next); setAnnouncement(next ? `Following ${person.name}` : `Stopped following ${person.name}`); }}>{following === id ? 'Stop following' : 'Follow'}</button></div>}</li>; })}</ul>
    </div></div>}
  </div>;

}
