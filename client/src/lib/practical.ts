import type { PracticalCapability } from '../intelligence/types.ts';

export const PRACTICAL_ACTIONS = [
  'practical-health',
  'practical-render',
  'practical-accessibility',
  'practical-schema',
  'practical-publish',
  'practical-links',
  'practical-citations',
  'practical-structure',
  'practical-collaboration',
  'practical-recovery',
  'practical-versions',
  'practical-assets',
  'practical-reader',
  'practical-privacy',
  'practical-ledger',
  'practical-paste',
  'practical-blocks',
  'practical-quality',
] as const;

export type PracticalActionId = typeof PRACTICAL_ACTIONS[number];

const CAPABILITY_BY_ACTION: Record<PracticalActionId, PracticalCapability> = {
  'practical-health': 'health',
  'practical-render': 'render',
  'practical-accessibility': 'accessibility',
  'practical-schema': 'schema',
  'practical-publish': 'publish',
  'practical-links': 'links',
  'practical-citations': 'citations',
  'practical-structure': 'structure',
  'practical-collaboration': 'collaboration',
  'practical-recovery': 'recovery',
  'practical-versions': 'versions',
  'practical-assets': 'assets',
  'practical-reader': 'reader',
  'practical-privacy': 'privacy',
  'practical-ledger': 'ledger',
  'practical-paste': 'paste',
  'practical-blocks': 'blocks',
  'practical-quality': 'quality',
};

export function practicalCapabilityForAction(action: string): PracticalCapability | null {
  return Object.hasOwn(CAPABILITY_BY_ACTION, action)
    ? CAPABILITY_BY_ACTION[action as PracticalActionId]
    : null;
}
