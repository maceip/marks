/**
 * Pure type-level feature identity shared by browser declarations and the
 * executable catalog. Keeping this file free of Node imports lets the client
 * derive exact build-plan keys without pulling build tooling into its runtime.
 */
export interface ProductFeatureIdentityMap {
  readonly agentChat: 'agent-chat';
  readonly ribbonWild: 'ribbon-wild';
}

export type ProductFeatureKey = keyof ProductFeatureIdentityMap;
export type ProductFeatureId = ProductFeatureIdentityMap[ProductFeatureKey];
