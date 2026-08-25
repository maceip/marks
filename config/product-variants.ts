import { createHash } from 'node:crypto';
import type {
  ProductFeatureId,
  ProductFeatureIdentityMap,
  ProductFeatureKey,
} from './product-feature-schema.ts';

export type { ProductFeatureId, ProductFeatureKey } from './product-feature-schema.ts';

export const PRODUCT_BUILD_PLAN_SCHEMA = 'marks.product-build-plan.v1' as const;
export const PRODUCT_BUILD_RECEIPT_SCHEMA = 'marks.product-build-receipt.v1' as const;
export const DEFAULT_PRODUCT_VARIANT = 'stable' as const;
export const LEGACY_PRODUCT_FEATURE_ENV_KEYS = [
  'VITE_MARKS_AGENT_CHAT',
  'VITE_MARKS_RIBBON_WILD',
] as const;

export interface ClientArtifactBoundary {
  readonly requiredModules: readonly string[];
  readonly forbiddenModulePrefixes: readonly string[];
  readonly forbiddenModules: readonly string[];
  /** Stable string identities that must be present when enabled and absent
   * from emitted JavaScript when disabled. Add these only for feature-owned
   * branches that intentionally live in shared modules rather than lazy
   * chunks; an explicitly empty list is valid for a module-only feature. */
  readonly javascriptMarkers: readonly string[];
  /** Stable CSS identities that must be present when enabled and absent from
   * emitted stylesheets when disabled. Keep feature-owned selectors in gated
   * stylesheets so disabled cuts contain no dormant UI styling. */
  readonly stylesheetMarkers: readonly string[];
}

export interface ProductFeatureDefinition {
  readonly id: string;
  readonly label: string;
  readonly client: ClientArtifactBoundary | null;
  readonly serverCargoFeature: string | null;
  readonly requires: readonly string[];
  readonly interactions: readonly string[];
}

type ProductFeatureCatalogShape = {
  readonly [Key in ProductFeatureKey]: ProductFeatureDefinition & {
    readonly id: ProductFeatureIdentityMap[Key];
  };
};

/**
 * The catalog owns durable feature identity and artifact ownership. Feature
 * consumers still use direct Vite-injected literals at dynamic-import sites;
 * hiding those imports behind this module would let Rolldown discover chunks
 * before it can prove that a feature is disabled.
 */
export const PRODUCT_FEATURE_CATALOG = {
  agentChat: {
    id: 'agent-chat',
    label: 'Agent chat',
    client: {
      requiredModules: [
        'src/components/agent/AgentPill.tsx',
        'src/components/agent/AgentChatPill.tsx',
        'src/commands/AgentCommandBridge.tsx',
        'src/commands/webmcp.ts',
      ],
      forbiddenModulePrefixes: [
        'src/agent/',
        'src/components/agent/',
      ],
      forbiddenModules: [
        'src/commands/AgentCommandBridge.tsx',
        'src/commands/webmcp.ts',
        'src/styles/agent.css',
      ],
      javascriptMarkers: [
        'window.marksRibbon',
        'marks:command-state',
        'agentTools',
        'agent-raised',
        'agentRaised',
        'agentState',
        'agent-tab-dot',
        'data-agent-active',
        'data-agent-state',
        'Agent-chat pattern state',
        'Hosted agent receives pill prompts',
      ],
      stylesheetMarkers: [
        '.agent-pill',
        '.agent-chat-host',
        '.agent-tab-dot',
        '.exposure-agent',
      ],
    },
    serverCargoFeature: 'agent-chat',
    requires: [],
    interactions: ['ribbonWild'],
  },
  ribbonWild: {
    id: 'ribbon-wild',
    label: 'Ribbon wild',
    client: {
      requiredModules: [
        'src/components/wild/WildStudio.tsx',
        'src/components/wild/WildTelemetry.tsx',
        'src/wild/observations.ts',
      ],
      forbiddenModulePrefixes: [
        'src/wild/',
        'src/components/wild/',
      ],
      forbiddenModules: [
        'src/lib/wild-surfaces.ts',
        'src/styles/wild.css',
      ],
      javascriptMarkers: [
        'wild.intent-horizon',
        'wild.causal-lightpath',
        'wild.consequence-lanes',
        'wild.context-half-life',
        'wild.counterfactual-shelf',
        'wild-intent-horizon',
        'wild-causal-lightpath',
        'wild-consequence-lanes',
        'wild-context-half-life',
        'wild-counterfactual-shelf',
      ],
      stylesheetMarkers: [
        '.wild-studio',
        '.causal-lightpath',
      ],
    },
    serverCargoFeature: null,
    requires: [],
    interactions: ['agentChat'],
  },
} as const satisfies ProductFeatureCatalogShape;

export type ProductFeatureState = Readonly<Record<ProductFeatureKey, boolean>>;

export interface ProductVariantDefinition {
  readonly label: string;
  readonly deployable: boolean;
  readonly features: ProductFeatureState;
}

/**
 * Every variant spells out every known feature. Adding a catalog entry is a
 * compile-time error here until each supported product cut makes a decision.
 * Partial variants exist only to keep individual feature boundaries healthy;
 * privileged release tooling must require a deployable variant.
 */
export const PRODUCT_VARIANTS = {
  stable: {
    label: 'Stable',
    deployable: true,
    features: {
      agentChat: false,
      ribbonWild: false,
    },
  },
  beta: {
    label: 'Beta',
    deployable: true,
    features: {
      agentChat: true,
      ribbonWild: true,
    },
  },
  'agent-chat-validation': {
    label: 'Agent chat validation',
    deployable: false,
    features: {
      agentChat: true,
      ribbonWild: false,
    },
  },
  'ribbon-wild-validation': {
    label: 'Ribbon wild validation',
    deployable: false,
    features: {
      agentChat: false,
      ribbonWild: true,
    },
  },
} as const satisfies Record<string, ProductVariantDefinition>;

export type ProductVariantName = keyof typeof PRODUCT_VARIANTS;
export type ProductDataMode = 'local' | 'service';

export interface ProductBuildPlan {
  readonly schema: typeof PRODUCT_BUILD_PLAN_SCHEMA;
  readonly productVariant: ProductVariantName;
  readonly deployable: boolean;
  readonly features: Readonly<Record<ProductFeatureId, boolean>>;
  readonly client: Readonly<{
    dataMode: ProductDataMode;
  }>;
  readonly server: Readonly<{
    cargoFeatures: readonly string[];
  }>;
}

export interface ProductBuildReceipt {
  readonly schema: typeof PRODUCT_BUILD_RECEIPT_SCHEMA;
  readonly buildPlan: ProductBuildPlan;
  readonly buildPlanSha256: string;
}

interface RuntimeProductFeatureDefinition {
  readonly id: string;
  readonly label: string;
  readonly client: ClientArtifactBoundary | null;
  readonly serverCargoFeature: string | null;
  /** Directional, acyclic build dependencies. */
  readonly requires: readonly string[];
  /** Symmetric pairs whose enabled combination must be covered by a variant. */
  readonly interactions: readonly string[];
}

interface RuntimeProductVariantDefinition {
  readonly label: string;
  readonly deployable: boolean;
  readonly features: Readonly<Record<string, boolean>>;
}

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function hasOwn(source: NodeJS.ProcessEnv | Record<string, string | undefined>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function assertUnique(values: readonly string[], label: string): void {
  const duplicates = [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
  if (duplicates.length) throw new Error(`${label} must be unique: ${duplicates.join(', ')}`);
}

/**
 * Validate invariants that TypeScript cannot protect once catalog data crosses
 * a Node, Rust, shell, or JSON boundary. `requires` is intentionally
 * directional and must be acyclic; `interactions` is intentionally symmetric.
 */
export function validateProductVariantConfiguration(
  catalog: Readonly<Record<string, RuntimeProductFeatureDefinition>> = PRODUCT_FEATURE_CATALOG,
  variants: Readonly<Record<string, RuntimeProductVariantDefinition>> = PRODUCT_VARIANTS,
): void {
  const featureKeys = Object.keys(catalog).sort();
  if (featureKeys.length === 0) throw new Error('Product feature catalog must not be empty');
  const variantNames = Object.keys(variants).sort();
  if (variantNames.length === 0) throw new Error('Product variant catalog must not be empty');

  const safeIdentifier = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
  const isSafeIdentifier = (value: string): boolean =>
    value.length <= 64 && safeIdentifier.test(value);
  const safeProperty = /^[a-z][A-Za-z0-9]*$/u;
  for (const key of featureKeys) {
    if (!safeProperty.test(key)) {
      throw new Error(`Product feature key must be a JavaScript identifier: ${JSON.stringify(key)}`);
    }
  }
  const ids = featureKeys.map((key) => catalog[key].id);
  assertUnique(ids, 'Product feature IDs');
  for (const id of ids) {
    if (!isSafeIdentifier(id)) {
      throw new Error(`Product feature ID must be kebab-case: ${JSON.stringify(id)}`);
    }
  }
  for (const name of variantNames) {
    if (!isSafeIdentifier(name)) {
      throw new Error(`Product variant name must be kebab-case: ${JSON.stringify(name)}`);
    }
  }
  const cargoFeatures = featureKeys
    .map((key) => catalog[key].serverCargoFeature)
    .filter((value): value is string => value !== null);
  assertUnique(cargoFeatures, 'Product feature Cargo mappings');
  for (const cargoFeature of cargoFeatures) {
    if (!isSafeIdentifier(cargoFeature)) {
      throw new Error(`Cargo feature mapping must be kebab-case: ${JSON.stringify(cargoFeature)}`);
    }
  }

  for (const key of featureKeys) {
    const feature = catalog[key];
    if (feature.label.trim().length === 0) throw new Error(`${key}.label must not be empty`);
    assertUnique(feature.requires, `${key}.requires`);
    assertUnique(feature.interactions, `${key}.interactions`);
    for (const required of feature.requires) {
      if (!hasOwn(catalog, required)) throw new Error(`${key} requires unknown feature ${required}`);
      if (required === key) throw new Error(`${key} cannot require itself`);
    }
    for (const interacting of feature.interactions) {
      if (!hasOwn(catalog, interacting)) throw new Error(`${key} interacts with unknown feature ${interacting}`);
      if (interacting === key) throw new Error(`${key} cannot interact with itself`);
      if (!catalog[interacting].interactions.includes(key)) {
        throw new Error(`Interaction must be symmetric: ${key} -> ${interacting}`);
      }
    }

    const boundary = feature.client;
    if (boundary) {
      assertUnique(boundary.requiredModules, `${key}.client.requiredModules`);
      assertUnique(boundary.forbiddenModulePrefixes, `${key}.client.forbiddenModulePrefixes`);
      assertUnique(boundary.forbiddenModules, `${key}.client.forbiddenModules`);
      assertUnique(boundary.javascriptMarkers, `${key}.client.javascriptMarkers`);
      assertUnique(boundary.stylesheetMarkers, `${key}.client.stylesheetMarkers`);
      if (boundary.requiredModules.length === 0) {
        throw new Error(`${key}.client.requiredModules must own at least one emitted module`);
      }
      if (boundary.forbiddenModulePrefixes.length + boundary.forbiddenModules.length === 0) {
        throw new Error(`${key}.client must declare at least one forbidden module boundary`);
      }
      for (const marker of boundary.javascriptMarkers) {
        if (marker.length === 0 || marker.length > 128 || /[\r\n\0]/u.test(marker)) {
          throw new Error(`${key} client JavaScript marker is invalid: ${JSON.stringify(marker)}`);
        }
      }
      for (const marker of boundary.stylesheetMarkers) {
        if (marker.length === 0 || marker.length > 128 || /[\r\n\0]/u.test(marker)) {
          throw new Error(`${key} client stylesheet marker is invalid: ${JSON.stringify(marker)}`);
        }
      }
      const validateModuleId = (moduleId: string, allowTrailingSlash: boolean): void => {
        if (!moduleId.startsWith('src/')) {
          throw new Error(`${key} client artifact path must start with src/: ${moduleId}`);
        }
        if (moduleId.includes('\\')) {
          throw new Error(`${key} client artifact path must use forward slashes: ${moduleId}`);
        }
        const path = allowTrailingSlash && moduleId.endsWith('/') ? moduleId.slice(0, -1) : moduleId;
        if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
          throw new Error(`${key} client artifact path contains an unsafe segment: ${moduleId}`);
        }
      };
      for (const moduleId of boundary.requiredModules) validateModuleId(moduleId, false);
      for (const moduleId of boundary.forbiddenModulePrefixes) validateModuleId(moduleId, true);
      for (const moduleId of boundary.forbiddenModules) validateModuleId(moduleId, false);
      const uncoveredRequiredModules = boundary.requiredModules.filter((required) =>
        !boundary.forbiddenModules.includes(required)
        && !boundary.forbiddenModulePrefixes.some((prefix) => required.startsWith(prefix)));
      if (uncoveredRequiredModules.length) {
        throw new Error(
          `${key}.client.requiredModules must also be covered by a disabled module boundary; `
          + `uncovered: ${uncoveredRequiredModules.join(', ')}`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error(`Product feature dependency cycle includes ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const required of catalog[key].requires) visit(required);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of featureKeys) visit(key);

  for (const name of variantNames) {
    const variant = variants[name];
    if (variant.label.trim().length === 0) throw new Error(`${name}.label must not be empty`);
    const assignments = Object.keys(variant.features).sort();
    const missing = featureKeys.filter((key) => !assignments.includes(key));
    const extra = assignments.filter((key) => !featureKeys.includes(key));
    if (missing.length || extra.length) {
      throw new Error(
        `Product variant ${name} must assign every feature exactly once` +
        `${missing.length ? `; missing: ${missing.join(', ')}` : ''}` +
        `${extra.length ? `; unknown: ${extra.join(', ')}` : ''}`,
      );
    }
    if (name.endsWith('-validation') === variant.deployable) {
      throw new Error(
        `Product variant ${name} has invalid deployability; only nondeployable variants use -validation`,
      );
    }
    for (const key of featureKeys) {
      if (typeof variant.features[key] !== 'boolean') {
        throw new Error(`Product variant ${name} has a non-boolean assignment for ${key}`);
      }
      if (!variant.features[key]) continue;
      for (const required of catalog[key].requires) {
        if (!variant.features[required]) {
          throw new Error(`Product variant ${name} enables ${key} without required feature ${required}`);
        }
      }
    }
  }

  const stable = variants[DEFAULT_PRODUCT_VARIANT];
  if (!stable?.deployable) throw new Error(`${DEFAULT_PRODUCT_VARIANT} must be a deployable product variant`);

  const dependencyClosure = (key: string, closure = new Set<string>()): Set<string> => {
    if (closure.has(key)) return closure;
    closure.add(key);
    for (const required of catalog[key].requires) dependencyClosure(required, closure);
    return closure;
  };
  for (const key of featureKeys) {
    const expected = [...dependencyClosure(key)].sort();
    const covered = variantNames.some((name) => {
      const variant = variants[name];
      if (variant.deployable) return false;
      const enabled = featureKeys.filter((candidate) => variant.features[candidate]).sort();
      return enabled.length === expected.length && enabled.every((candidate, index) => candidate === expected[index]);
    });
    if (!covered) {
      throw new Error(`Product feature ${key} lacks an independent nondeployable validation variant`);
    }
  }

  for (const left of featureKeys) {
    for (const right of catalog[left].interactions) {
      if (left.localeCompare(right) >= 0) continue;
      const covered = variantNames.some((name) =>
        variants[name].features[left] && variants[name].features[right]);
      if (!covered) throw new Error(`Product feature interaction ${left} + ${right} lacks variant coverage`);
    }
  }
}

export function assertNoLegacyProductFeatureEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  const present = LEGACY_PRODUCT_FEATURE_ENV_KEYS.filter((key) => hasOwn(environment, key));
  if (present.length === 0) return;
  throw new Error(
    `Legacy per-feature build environment is forbidden: ${present.join(', ')}. ` +
    'Select a checked-in product variant with MARKS_PRODUCT_VARIANT instead.',
  );
}

export function parseProductVariantName(value: string | undefined): ProductVariantName {
  const candidate = value ?? DEFAULT_PRODUCT_VARIANT;
  if (hasOwn(PRODUCT_VARIANTS, candidate)) return candidate as ProductVariantName;
  throw new Error(
    `Unknown product variant ${JSON.stringify(candidate)}; expected one of: ` +
    Object.keys(PRODUCT_VARIANTS).join(', '),
  );
}

export function parseProductDataMode(
  value: string | undefined,
  fallback?: ProductDataMode,
): ProductDataMode {
  const candidate = value ?? fallback;
  if (candidate === 'local' || candidate === 'service') return candidate;
  if (candidate === undefined) throw new Error('Product data mode is required; expected local or service');
  throw new Error(`Unknown product data mode ${JSON.stringify(candidate)}; expected local or service`);
}

export function resolveProductBuildPlan({
  variant,
  dataMode,
  requireDeployable = false,
}: {
  readonly variant?: string;
  readonly dataMode: string;
  readonly requireDeployable?: boolean;
}): ProductBuildPlan {
  validateProductVariantConfiguration();
  const productVariant = parseProductVariantName(variant);
  const definition = PRODUCT_VARIANTS[productVariant];
  if (requireDeployable && !definition.deployable) {
    throw new Error(`Product variant ${productVariant} is validation-only and cannot be deployed`);
  }

  const entries = Object.entries(PRODUCT_FEATURE_CATALOG) as [
    ProductFeatureKey,
    (typeof PRODUCT_FEATURE_CATALOG)[ProductFeatureKey],
  ][];
  const features = Object.fromEntries(
    entries
      .map(([key, feature]) => [feature.id, definition.features[key]] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ) as Record<ProductFeatureId, boolean>;
  const cargoFeatures = entries
    .filter(([key, feature]) => definition.features[key] && feature.serverCargoFeature !== null)
    .map(([, feature]) => feature.serverCargoFeature as string)
    .sort();

  return {
    schema: PRODUCT_BUILD_PLAN_SCHEMA,
    productVariant,
    deployable: definition.deployable,
    features,
    client: { dataMode: parseProductDataMode(dataMode) },
    server: { cargoFeatures },
  };
}

export function productFeatureState(plan: ProductBuildPlan): ProductFeatureState {
  return Object.fromEntries(
    (Object.entries(PRODUCT_FEATURE_CATALOG) as [
      ProductFeatureKey,
      (typeof PRODUCT_FEATURE_CATALOG)[ProductFeatureKey],
    ][]).map(([key, feature]) => [key, plan.features[feature.id]]),
  ) as Record<ProductFeatureKey, boolean>;
}

function canonicalize(value: CanonicalJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as { readonly [key: string]: CanonicalJson };
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
}

export function canonicalJson(value: CanonicalJson): string {
  return canonicalize(value);
}

export function canonicalProductBuildPlan(plan: ProductBuildPlan): string {
  return canonicalJson(plan as unknown as CanonicalJson);
}

export function productBuildPlanSha256(plan: ProductBuildPlan): string {
  return createHash('sha256').update(canonicalProductBuildPlan(plan), 'utf8').digest('hex');
}

export function createProductBuildReceipt(plan: ProductBuildPlan): ProductBuildReceipt {
  return {
    schema: PRODUCT_BUILD_RECEIPT_SCHEMA,
    buildPlan: plan,
    buildPlanSha256: productBuildPlanSha256(plan),
  };
}

export function canonicalProductBuildReceipt(receipt: ProductBuildReceipt): string {
  return canonicalJson(receipt as unknown as CanonicalJson);
}
