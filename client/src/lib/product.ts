export const PRODUCT_NAME = 'marks';

/** User inactivity only hides transient presence; document sync stays live. */
export const PRESENCE_IDLE_MS = 60_000;

/** Latest level-9 gzip receipt, rounded so recording it does not perturb itself. */
export const UI_PERFORMANCE_RECEIPT = {
  appCriticalKb: '106.1',
  marketingCriticalKb: '0.55',
} as const;

const NODE_TEST_PRODUCT_BUILD: MarksProductBuildReceipt = {
  schema: 'marks.product-build-receipt.v1',
  buildPlan: {
    schema: 'marks.product-build-plan.v1',
    productVariant: 'stable',
    deployable: true,
    features: {
      'agent-chat': false,
      'ribbon-wild': false,
    },
    client: { dataMode: 'local' },
    server: { cargoFeatures: [] },
  },
  // Node unit tests import this module without Vite. Browser and release
  // artifacts always receive the real resolver-owned digest at build time.
  buildPlanSha256: 'unresolved-node-test',
};

export const PRODUCT_BUILD = typeof __MARKS_PRODUCT_BUILD__ === 'undefined'
  ? NODE_TEST_PRODUCT_BUILD
  : __MARKS_PRODUCT_BUILD__;

export const PRODUCT_BUILD_JSON = typeof __MARKS_PRODUCT_BUILD_JSON__ === 'undefined'
  ? JSON.stringify(PRODUCT_BUILD)
  : __MARKS_PRODUCT_BUILD_JSON__;

export const PRODUCT_VARIANT = PRODUCT_BUILD.buildPlan.productVariant;
export const UI_DATA_MODE = PRODUCT_BUILD.buildPlan.client.dataMode;
export const RIBBON_WILD_ENABLED = PRODUCT_BUILD.buildPlan.features['ribbon-wild'];
export const AGENT_CHAT_ENABLED = PRODUCT_BUILD.buildPlan.features['agent-chat'];

export const ENGINE = {
  id: 'esbt' as const,
  label: 'ESBT',
  blurb:
    'Weighted-identifier sequence CRDT (Mechaoui & Imine). Rust/Wasm replica, per-peer undo, IndexedDB journal, compact format v3.',
};

export const UI_BREAKPOINTS = {
  phone: 720,
  overlayNavigation: 1099,
} as const;

export const UI_MEDIA = {
  phone: `(max-width: ${UI_BREAKPOINTS.phone}px), (max-height: 560px) and (pointer: coarse)`,
  overlayNavigation: `(max-width: ${UI_BREAKPOINTS.overlayNavigation}px)`,
  foldBook: '(horizontal-viewport-segments: 2), (spanning: single-fold-vertical)',
  foldLaptop: '(vertical-viewport-segments: 2), (spanning: single-fold-horizontal)',
} as const;
