import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_TARGET = process.env.MARKS_SERVER ?? 'http://localhost:3000';

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
    closeBundle() {
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

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
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
    rollupOptions: {
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
});
