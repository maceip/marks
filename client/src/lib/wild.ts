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
