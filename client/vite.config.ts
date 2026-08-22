import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const API_TARGET = process.env.MARKS_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
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
