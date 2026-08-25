import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRODUCT_FEATURE_CATALOG,
  PRODUCT_VARIANTS,
  validateProductVariantConfiguration,
} from './product-variants.ts';

type MutableConfiguration = {
  catalog: Record<string, {
    id: string;
    label: string;
    client: {
      requiredModules: string[];
      forbiddenModulePrefixes: string[];
      forbiddenModules: string[];
      javascriptMarkers: string[];
      stylesheetMarkers: string[];
    } | null;
    serverCargoFeature: string | null;
    requires: string[];
    interactions: string[];
  }>;
  variants: Record<string, {
    label: string;
    deployable: boolean;
    features: Record<string, boolean>;
  }>;
};

function mutableConfiguration(): MutableConfiguration {
  return structuredClone({
    catalog: PRODUCT_FEATURE_CATALOG,
    variants: PRODUCT_VARIANTS,
  });
}

function rejects(
  mutate: (configuration: MutableConfiguration) => void,
  expected: RegExp,
): void {
  const configuration = mutableConfiguration();
  mutate(configuration);
  assert.throws(
    () => validateProductVariantConfiguration(configuration.catalog, configuration.variants),
    expected,
  );
}

test('checked-in product feature catalog and variants satisfy every runtime invariant', () => {
  assert.doesNotThrow(() => validateProductVariantConfiguration());
});

test('every current required client module is owned by its disabled boundary', () => {
  for (const [key, feature] of Object.entries(PRODUCT_FEATURE_CATALOG)) {
    if (!feature.client) continue;
    const forbiddenModules = new Set<string>(feature.client.forbiddenModules);
    for (const required of feature.client.requiredModules) {
      assert.ok(
        forbiddenModules.has(required)
          || feature.client.forbiddenModulePrefixes.some((prefix) => required.startsWith(prefix)),
        `${key} required module is not covered when disabled: ${required}`,
      );
    }
  }
});

test('feature and Cargo identities are unique', () => {
  rejects(({ catalog }) => {
    catalog.ribbonWild.id = catalog.agentChat.id;
  }, /feature IDs must be unique/u);
  rejects(({ catalog }) => {
    catalog.ribbonWild.serverCargoFeature = catalog.agentChat.serverCargoFeature;
  }, /Cargo mappings must be unique/u);
});

test('feature keys are safe property-level Vite define targets', () => {
  rejects((configuration) => {
    configuration.catalog['unsafe-key'] = configuration.catalog.agentChat;
    delete configuration.catalog.agentChat;
  }, /feature key must be a JavaScript identifier/u);
});

test('cross-boundary identities, labels, and artifact paths are safe', () => {
  rejects(({ variants }) => {
    variants['bad_name'] = structuredClone(variants.stable);
  }, /variant name must be kebab-case/u);
  rejects(({ catalog }) => {
    catalog.agentChat.serverCargoFeature = 'agent_chat';
  }, /Cargo feature mapping must be kebab-case/u);
  rejects(({ catalog }) => {
    catalog.agentChat.label = '   ';
  }, /agentChat\.label must not be empty/u);
  rejects(({ variants }) => {
    variants.stable.label = '';
  }, /stable\.label must not be empty/u);
  rejects(({ catalog }) => {
    catalog.agentChat.client.requiredModules[0] = 'src\\agent\\AgentPill.tsx';
  }, /must start with src\/|must use forward slashes/u);
  rejects(({ catalog }) => {
    catalog.agentChat.client.requiredModules[0] = 'src/agent/../escape.ts';
  }, /contains an unsafe segment/u);
  rejects(({ catalog }) => {
    catalog.agentChat.client.requiredModules = [];
  }, /must own at least one emitted module/u);
  rejects(({ catalog }) => {
    catalog.agentChat.client.forbiddenModulePrefixes = [];
    catalog.agentChat.client.forbiddenModules = [];
  }, /must declare at least one forbidden module boundary/u);
  rejects(({ catalog }) => {
    catalog.agentChat.client.javascriptMarkers[0] = 'unsafe\nmarker';
  }, /JavaScript marker is invalid/u);
  rejects(({ catalog }) => {
    catalog.agentChat.client.stylesheetMarkers[0] = 'unsafe\nmarker';
  }, /stylesheet marker is invalid/u);
  rejects(({ catalog }) => {
    catalog.agentChat.client.stylesheetMarkers.push(catalog.agentChat.client.stylesheetMarkers[0]);
  }, /stylesheetMarkers must be unique/u);
  rejects(({ catalog }) => {
    catalog.agentChat.client.requiredModules.push('src/commands/UnownedAgentCapability.ts');
  }, /requiredModules must also be covered by a disabled module boundary.*UnownedAgentCapability/u);
});

test('variant feature assignments must be complete, exact, and boolean', () => {
  rejects(({ variants }) => {
    delete variants.stable.features.ribbonWild;
  }, /missing: ribbonWild/u);
  rejects(({ variants }) => {
    variants.stable.features.futureFeature = false;
  }, /unknown: futureFeature/u);
  rejects(({ variants }) => {
    variants.stable.features.agentChat = 'off' as unknown as boolean;
  }, /non-boolean assignment/u);
});

test('dependencies are known, directional, acyclic, and honored by every variant', () => {
  rejects(({ catalog }) => {
    catalog.agentChat.requires = ['missing'];
  }, /requires unknown feature missing/u);
  rejects(({ catalog }) => {
    catalog.agentChat.requires = ['agentChat'];
  }, /cannot require itself/u);
  rejects(({ catalog }) => {
    catalog.agentChat.requires = ['ribbonWild'];
    catalog.ribbonWild.requires = ['agentChat'];
  }, /dependency cycle/u);
  rejects(({ catalog }) => {
    catalog.agentChat.requires = ['ribbonWild'];
  }, /enables agentChat without required feature ribbonWild/u);
});

test('interactions are known, non-self, symmetric, and covered by a variant', () => {
  rejects(({ catalog }) => {
    catalog.agentChat.interactions = ['missing'];
  }, /interacts with unknown feature missing/u);
  rejects(({ catalog }) => {
    catalog.agentChat.interactions = ['agentChat'];
  }, /cannot interact with itself/u);
  rejects(({ catalog }) => {
    catalog.ribbonWild.interactions = [];
  }, /Interaction must be symmetric/u);
  rejects(({ variants }) => {
    variants.beta.features.ribbonWild = false;
  }, /interaction agentChat \+ ribbonWild lacks variant coverage/u);
});

test('every feature keeps an independent validation cut and validation cuts cannot deploy', () => {
  rejects(({ variants }) => {
    delete variants['agent-chat-validation'];
  }, /agentChat lacks an independent nondeployable validation variant/u);
  rejects(({ variants }) => {
    variants['agent-chat-validation'].deployable = true;
  }, /invalid deployability/u);
  rejects(({ variants }) => {
    variants.preview = structuredClone(variants['agent-chat-validation']);
    delete variants['agent-chat-validation'];
  }, /only nondeployable variants use -validation/u);
});
