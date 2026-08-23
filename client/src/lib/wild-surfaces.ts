import type { WildCapability } from '../wild/types.ts';

export interface WildSurfaceDescriptor {
  capability: WildCapability;
  label: string;
  shortLabel: string;
  description: string;
}

/** Studio-only copy stays out of the critical application entry chunk. */
export const WILD_SURFACES: readonly WildSurfaceDescriptor[] = [
  { capability: 'intent', label: 'Intent Horizon', shortLabel: 'Horizon', description: 'Turn declared work and document signals into an inspectable next-action horizon.' },
  { capability: 'causal', label: 'Causal Lightpath', shortLabel: 'Lightpath', description: 'Trace a real ribbon or agent command through source, rendering, collaboration, and durability.' },
  { capability: 'consequences', label: 'Consequence Lanes', shortLabel: 'Lanes', description: 'See which product planes a command can touch before choosing to run it.' },
  { capability: 'half-life', label: 'Context Half-Life', shortLabel: 'Half-life', description: 'Track claims whose usefulness decays as dates, versions, links, and assumptions age.' },
  { capability: 'counterfactuals', label: 'Counterfactual Shelf', shortLabel: 'Shelf', description: 'Keep durable, previewable alternatives beside the document without overwriting it.' },
] as const;
