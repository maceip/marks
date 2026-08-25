type MarksProductFeatureKey = import('../../../config/product-feature-schema.ts').ProductFeatureKey;
type MarksProductFeatureId = import('../../../config/product-feature-schema.ts').ProductFeatureId;
type MarksProductFeatures = Readonly<Record<MarksProductFeatureKey, boolean>>;
type MarksProductPlanFeatures = Readonly<Record<MarksProductFeatureId, boolean>>;

interface MarksProductBuildPlan {
  readonly schema: 'marks.product-build-plan.v1';
  readonly productVariant: string;
  readonly deployable: boolean;
  readonly features: MarksProductPlanFeatures;
  readonly client: Readonly<{
    dataMode: 'local' | 'service';
  }>;
  readonly server: Readonly<{
    cargoFeatures: readonly string[];
  }>;
}

interface MarksProductBuildReceipt {
  readonly schema: 'marks.product-build-receipt.v1';
  readonly buildPlan: MarksProductBuildPlan;
  readonly buildPlanSha256: string;
}

/** Direct build literals injected by client/vite.config.ts at gated import sites. */
declare const __MARKS_FEATURES__: Readonly<MarksProductFeatures>;
declare const __MARKS_VITE_BUILD__: true;
declare const __MARKS_PRODUCT_BUILD__: Readonly<MarksProductBuildReceipt>;
declare const __MARKS_PRODUCT_BUILD_JSON__: string;
