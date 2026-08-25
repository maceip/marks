import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCT_FEATURE_CATALOG,
  assertNoLegacyProductFeatureEnvironment,
  canonicalProductBuildPlan,
  canonicalProductBuildReceipt,
  createProductBuildReceipt,
  productFeatureState,
  resolveProductBuildPlan,
  type ProductBuildPlan,
} from '../config/product-variants.ts';

const API_TARGET = process.env.MARKS_SERVER ?? 'http://localhost:3000';
const CLIENT_ROOT = fileURLToPath(new URL('.', import.meta.url));

function normalizeModuleId(id: string): string {
  return id.replaceAll('\\', '/').split('?', 1)[0];
}

/**
 * Vite 8/Rolldown discovers dynamic-import entries before it propagates an
 * imported boolean through another module. Without this invariant, a false
 * product flag can leave unreachable agent or wild chunks in the artifact.
 * Inspect the final module graph rather than filenames so hashing, chunk
 * merging, or future component names cannot silently weaken the boundary.
 */
function assertProductFeatureChunks(plan: ProductBuildPlan): Plugin {
  const source = (path: string) => normalizeModuleId(fileURLToPath(new URL(`./${path}`, import.meta.url)));
  const root = normalizeModuleId(CLIENT_ROOT).replace(/\/$/u, '');
  const display = (id: string) => relative(root, id).replaceAll('\\', '/');

  return {
    name: 'marks-assert-product-feature-chunks',
    apply: 'build',
    generateBundle(_options, bundle) {
      const modules = new Set(
        Object.values(bundle).flatMap((output) => output.type === 'chunk'
          ? Object.keys(output.modules).map(normalizeModuleId)
          : []),
      );
      // Module ownership proves that feature entry points are cut correctly.
      // Shared command/ribbon modules can still retain disabled branches, so
      // also inspect emitted JavaScript and CSS for catalog-owned identities.
      // Source maps are deliberately excluded: they preserve source text and
      // are not executable artifact code.
      const javascript = Object.values(bundle)
        .filter((output) => output.type === 'chunk')
        .map((output) => output.code)
        .join('\n');
      const stylesheets = Object.values(bundle)
        .filter((output) => output.type === 'asset' && output.fileName.endsWith('.css'))
        .map((output) => typeof output.source === 'string'
          ? output.source
          : new TextDecoder().decode(output.source))
        .join('\n');

      for (const feature of Object.values(PRODUCT_FEATURE_CATALOG)) {
        if (!feature.client) continue;
        const enabled = plan.features[feature.id];
        const required = feature.client.requiredModules.map(source);
        const forbiddenPrefixes = feature.client.forbiddenModulePrefixes.map(source);
        const forbiddenExact = feature.client.forbiddenModules.map(source);
        const javascriptMarkers = feature.client.javascriptMarkers;
        const stylesheetMarkers = feature.client.stylesheetMarkers;
        if (enabled) {
          const missing = required.filter((id) => !modules.has(id));
          if (missing.length) {
            this.error(`${feature.label} is enabled but its entry modules were not emitted: ${missing.map(display).join(', ')}`);
          }
          const missingJavaScriptMarkers = javascriptMarkers.filter((marker) => !javascript.includes(marker));
          if (missingJavaScriptMarkers.length) {
            this.error(`${feature.label} is enabled but JavaScript markers were not emitted: ${missingJavaScriptMarkers.join(', ')}`);
          }
          const missingStylesheetMarkers = stylesheetMarkers.filter((marker) => !stylesheets.includes(marker));
          if (missingStylesheetMarkers.length) {
            this.error(`${feature.label} is enabled but stylesheet markers were not emitted: ${missingStylesheetMarkers.join(', ')}`);
          }
          continue;
        }
        const forbidden = [...modules].filter((id) =>
          forbiddenExact.includes(id) || forbiddenPrefixes.some((prefix) => id.startsWith(prefix)));
        if (forbidden.length) {
          this.error(`${feature.label} is disabled but gated modules were emitted: ${forbidden.map(display).sort().join(', ')}`);
        }
        const retainedJavaScriptMarkers = javascriptMarkers.filter((marker) => javascript.includes(marker));
        if (retainedJavaScriptMarkers.length) {
          this.error(`${feature.label} is disabled but JavaScript markers were emitted: ${retainedJavaScriptMarkers.join(', ')}`);
        }
        const retainedStylesheetMarkers = stylesheetMarkers.filter((marker) => stylesheets.includes(marker));
        if (retainedStylesheetMarkers.length) {
          this.error(`${feature.label} is disabled but stylesheet markers were emitted: ${retainedStylesheetMarkers.join(', ')}`);
        }
      }
    },
  };
}

function emitProductBuildReceipt(receiptJson: string): Plugin {
  return {
    name: 'marks-emit-product-build-receipt',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'marks-product-build.json',
        source: receiptJson,
      });
    },
  };
}

// Browsers decide whether a new service worker exists by byte-comparing
// sw.js, and the worker serves the stable-path ESBT artifacts cache-first.
// A hand-maintained version constant therefore lets an old worker keep
// serving a previous release's component forever. Stamp the cache
// namespace from the built entry documents and the component manifest so
// any release that changes the shell or the component also changes sw.js.
function stampServiceWorker(): Plugin {
  let outputDir = 'dist';
  let projectRoot = '';
  return {
    name: 'marks-stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      outputDir = config.build.outDir;
      projectRoot = config.root;
    },
    writeBundle() {
      const dist = resolve(projectRoot, outputDir);
      const digest = createHash('sha256');
      for (const input of ['index.html', 'welcome/index.html', 'esbt.component.manifest.json']) {
        digest.update(readFileSync(join(dist, input)));
      }
      const worker = join(dist, 'sw.js');
      const source = readFileSync(worker, 'utf8');
      const pattern = /^const VERSION = '[^']+';$/m;
      if (!pattern.test(source)) throw new Error('sw.js VERSION stamp target is missing');
      writeFileSync(
        worker,
        source.replace(pattern, `const VERSION = '${digest.digest('hex').slice(0, 16)}';`),
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, CLIENT_ROOT, '');
  assertNoLegacyProductFeatureEnvironment(env);
  const plan = resolveProductBuildPlan({
    variant: env.MARKS_PRODUCT_VARIANT,
    dataMode: env.VITE_MARKS_DATA_MODE ?? 'local',
  });
  const planJson = canonicalProductBuildPlan(plan);
  const receipt = createProductBuildReceipt(plan);
  const receiptJson = canonicalProductBuildReceipt(receipt);
  const suppliedPlan = env.MARKS_BUILD_PLAN_JSON;
  const suppliedDigest = env.MARKS_BUILD_PLAN_SHA256;
  const suppliedCargoFeatures = env.MARKS_SERVER_CARGO_FEATURES;
  if (suppliedPlan !== undefined && suppliedPlan !== planJson) {
    throw new Error('MARKS_BUILD_PLAN_JSON does not match the product variant resolved by Vite');
  }
  if (suppliedDigest !== undefined && suppliedDigest !== receipt.buildPlanSha256) {
    throw new Error('MARKS_BUILD_PLAN_SHA256 does not match the product variant resolved by Vite');
  }
  if (suppliedCargoFeatures !== undefined && suppliedCargoFeatures !== plan.server.cargoFeatures.join(',')) {
    throw new Error('MARKS_SERVER_CARGO_FEATURES does not match the product variant resolved by Vite');
  }
  const flags = productFeatureState(plan);
  const featureDefines = Object.fromEntries(
    Object.entries(flags).map(([key, enabled]) => [
      `__MARKS_FEATURES__.${key}`,
      JSON.stringify(enabled),
    ]),
  );

  return {
    define: {
      // Property-level replacements are deliberate. Replacing the whole object
      // leaves Rolldown dynamic-import entries alive until after graph
      // discovery; direct literal properties prune disabled feature chunks.
      ...featureDefines,
      // Shared catalogs are also executed directly by Node unit tests. This
      // build sentinel lets them retain a safe fallback there while Vite can
      // still fold their property-level feature guards to literals.
      __MARKS_VITE_BUILD__: 'true',
      __MARKS_PRODUCT_BUILD__: JSON.stringify(receipt),
      __MARKS_PRODUCT_BUILD_JSON__: JSON.stringify(receiptJson),
    },
    plugins: [
      react(),
      assertProductFeatureChunks(plan),
      emitProductBuildReceipt(receiptJson),
      stampServiceWorker(),
    ],
    server: {
      port: 5173,
      proxy: {
        '/v1': { target: API_TARGET, changeOrigin: true },
        '/collab': { target: API_TARGET.replace(/^http/, 'ws'), ws: true },
      },
    },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      modulePreload: { polyfill: false },
      // Source maps are opt-in so production uploads and runtime caches do not
      // carry tens of megabytes of debugger-only payload.
      sourcemap: process.env.MARKS_SOURCEMAP === '1',
      rolldownOptions: {
        input: {
          app: fileURLToPath(new URL('./index.html', import.meta.url)),
          marketing: fileURLToPath(new URL('./welcome/index.html', import.meta.url)),
        },
      },
      // Mermaid and the benchmark are dynamically imported, and the markdown
      // renderer lives in a worker, so the heavy dependencies already split out
      // of the critical path without hand-written chunking.
      chunkSizeWarningLimit: 900,
    },
  };
});
