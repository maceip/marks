import type { WildCapability } from '../wild/types.ts';

export const WILD_ACTIONS = [
  'wild-intent-horizon',
  'wild-causal-lightpath',
  'wild-consequence-lanes',
  'wild-context-half-life',
  'wild-counterfactual-shelf',
] as const;

export type WildActionId = typeof WILD_ACTIONS[number];

const CAPABILITY_BY_ACTION: Record<WildActionId, WildCapability> = {
  'wild-intent-horizon': 'intent',
  'wild-causal-lightpath': 'causal',
  'wild-consequence-lanes': 'consequences',
  'wild-context-half-life': 'half-life',
  'wild-counterfactual-shelf': 'counterfactuals',
};

export function wildCapabilityForAction(action: string): WildCapability | null {
  return Object.hasOwn(CAPABILITY_BY_ACTION, action)
    ? CAPABILITY_BY_ACTION[action as WildActionId]
    : null;
}

export const WILD_SURFACES: ReadonlyArray<{
  capability: WildCapability;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  { capability: 'intent', label: 'Intent Horizon', shortLabel: 'Horizon', description: 'Turn declared work and document signals into an inspectable next-action horizon.' },
  { capability: 'causal', label: 'Causal Lightpath', shortLabel: 'Lightpath', description: 'Trace a real ribbon or agent command through source, rendering, collaboration, and durability.' },
  { capability: 'consequences', label: 'Consequence Lanes', shortLabel: 'Lanes', description: 'See which product planes a command can touch before choosing to run it.' },
  { capability: 'half-life', label: 'Context Half-Life', shortLabel: 'Half-life', description: 'Track claims whose usefulness decays as dates, versions, links, and assumptions age.' },
  { capability: 'counterfactuals', label: 'Counterfactual Shelf', shortLabel: 'Shelf', description: 'Keep durable, previewable alternatives beside the document without overwriting it.' },
];
