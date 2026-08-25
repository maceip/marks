import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_TARGET = process.env.MARKS_SERVER ?? 'http://localhost:3000';
const CLIENT_ROOT = fileURLToPath(new URL('.', import.meta.url));

interface ProductFeatureFlags {
  agentChat: boolean;
  ribbonWild: boolean;
}

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
function assertProductFeatureChunks(flags: ProductFeatureFlags): Plugin {
  const source = (path: string) => normalizeModuleId(fileURLToPath(new URL(path, import.meta.url)));
  const root = normalizeModuleId(CLIENT_ROOT).replace(/\/$/u, '');
  const agentRequired = [
    source('./src/components/agent/AgentPill.tsx'),
    source('./src/components/agent/AgentChatPill.tsx'),
    source('./src/commands/webmcp.ts'),
  ];
  const agentForbiddenPrefixes = [
    source('./src/agent/'),
    source('./src/components/agent/'),
  ];
  const agentForbiddenExact = [
    source('./src/commands/webmcp.ts'),
    source('./src/styles/agent.css'),
  ];
  const wildRequired = [
    source('./src/components/wild/WildStudio.tsx'),
    source('./src/components/wild/WildTelemetry.tsx'),
    source('./src/wild/observations.ts'),
  ];
  const wildForbiddenPrefixes = [
    source('./src/wild/'),
    source('./src/components/wild/'),
  ];
  const wildForbiddenExact = [
    source('./src/lib/wild-surfaces.ts'),
    source('./src/styles/wild.css'),
  ];
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

      const assertFeature = (
        label: string,
        enabled: boolean,
        required: string[],
        forbiddenPrefixes: string[],
        forbiddenExact: string[],
      ) => {
        if (enabled) {
          const missing = required.filter((id) => !modules.has(id));
          if (missing.length) {
            this.error(`${label} is enabled but its entry modules were not emitted: ${missing.map(display).join(', ')}`);
          }
          return;
        }
        const forbidden = [...modules].filter((id) =>
          forbiddenExact.includes(id) || forbiddenPrefixes.some((prefix) => id.startsWith(prefix)));
        if (forbidden.length) {
          this.error(`${label} is disabled but gated modules were emitted: ${forbidden.map(display).sort().join(', ')}`);
        }
      };

      assertFeature(
        'Agent chat',
        flags.agentChat,
        agentRequired,
        agentForbiddenPrefixes,
        agentForbiddenExact,
      );
      assertFeature(
        'Ribbon wild',
        flags.ribbonWild,
        wildRequired,
        wildForbiddenPrefixes,
        wildForbiddenExact,
      );
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
  const env = loadEnv(mode, CLIENT_ROOT, 'VITE_');
  const flags: ProductFeatureFlags = {
    agentChat: env.VITE_MARKS_AGENT_CHAT === '1',
    ribbonWild: env.VITE_MARKS_RIBBON_WILD === '1',
  };

  return {
    define: {
      __MARKS_AGENT_CHAT_ENABLED__: JSON.stringify(flags.agentChat),
      __MARKS_RIBBON_WILD_ENABLED__: JSON.stringify(flags.ribbonWild),
    },
    plugins: [react(), assertProductFeatureChunks(flags), stampServiceWorker()],
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
