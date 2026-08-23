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

export interface PracticalSurfaceDescriptor {
  capability: PracticalCapability;
  label: string;
  shortLabel: string;
  description: string;
}

export const PRACTICAL_SURFACES: readonly PracticalSurfaceDescriptor[] = [
  { capability: 'health', label: 'Document health', shortLabel: 'Health', description: 'One prioritized view of issues that can change the outcome.' },
  { capability: 'render', label: 'Render diagnostics', shortLabel: 'Render', description: 'Find source constructs that make compiled output fail or drift.' },
  { capability: 'accessibility', label: 'Accessibility', shortLabel: 'Access', description: 'Check headings, images, links, and table semantics.' },
  { capability: 'schema', label: 'Front matter & schema', shortLabel: 'Schema', description: 'Edit portable metadata without discarding unknown YAML or comments.' },
  { capability: 'publish', label: 'Publish profiles', shortLabel: 'Publish', description: 'Declare and preview web, print, README, or slide intent.' },
  { capability: 'links', label: 'Link intelligence', shortLabel: 'Links', description: 'Resolve internal targets and explicitly check external destinations.' },
  { capability: 'citations', label: 'Citation ledger', shortLabel: 'Citations', description: 'Reconcile citations, footnotes, source records, and DOI metadata.' },
  { capability: 'structure', label: 'Structural refactoring', shortLabel: 'Structure', description: 'Move, rename, promote, demote, or extract complete sections.' },
  { capability: 'collaboration', label: 'Collaboration console', shortLabel: 'People', description: 'See authority, peers, connection, and live durability state.' },
  { capability: 'recovery', label: 'Durability & recovery', shortLabel: 'Recovery', description: 'Prove savedness and create portable recovery checkpoints.' },
  { capability: 'versions', label: 'Versions & branches', shortLabel: 'Versions', description: 'Compare durable snapshots and branch without overwriting the source.' },
  { capability: 'assets', label: 'Asset inspector', shortLabel: 'Assets', description: 'Audit image origins, alt text, reuse, and portable-asset state.' },
  { capability: 'reader', label: 'Reader simulation', shortLabel: 'Reader', description: 'Preview pace, density, and layout for real reading contexts.' },
  { capability: 'privacy', label: 'Privacy & exposure', shortLabel: 'Privacy', description: 'Find sensitive values and understand outbound exposure before sharing.' },
  { capability: 'ledger', label: 'Task & decision ledger', shortLabel: 'Ledger', description: 'Collect actionable work and decisions without moving them out of Markdown.' },
  { capability: 'paste', label: 'Paste intent & provenance', shortLabel: 'Paste', description: 'Choose how clipboard material lands and whether its source travels with it.' },
  { capability: 'blocks', label: 'Cross-document blocks', shortLabel: 'Blocks', description: 'Insert readable, access-checked references to another document section.' },
  { capability: 'quality', label: 'Audience & quality contract', shortLabel: 'Quality', description: 'Declare who this is for and keep readability within an explicit target.' },
] as const;
