import type { LocalUser } from './types';

const STORAGE_KEY = 'marks:user';

const ADJECTIVES = [
  'Swift', 'Quiet', 'Bright', 'Curious', 'Nimble', 'Calm', 'Bold', 'Clever',
];
const ANIMALS = [
  'Otter', 'Heron', 'Fox', 'Ibex', 'Marten', 'Falcon', 'Lynx', 'Tapir',
];

export const PALETTE_SIZE = 8;

function randomUser(): LocalUser {
  const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
  return {
    name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
    colorIndex: 1 + Math.floor(Math.random() * PALETTE_SIZE),
    id: crypto.randomUUID(),
  };
}

export function loadUser(): LocalUser {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalUser>;
      if (typeof parsed.name === 'string' && typeof parsed.colorIndex === 'number') {
        const user = { name: parsed.name, colorIndex: parsed.colorIndex, id: typeof parsed.id === 'string' ? parsed.id : crypto.randomUUID() };
        if (!parsed.id) saveUser(user);
        return user;
      }
    }
  } catch {
    // fall through to a fresh identity
  }
  const user = randomUser();
  saveUser(user);
  return user;
}

export function saveUser(user: LocalUser): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } catch {
    // private mode: identity just won't survive a reload
  }
}

/** Colour for a peer, as a CSS custom property reference. */
export function colorVar(colorIndex: number): string {
  return `var(--user-${((colorIndex - 1) % PALETTE_SIZE) + 1})`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}
