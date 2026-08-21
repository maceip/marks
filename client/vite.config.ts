import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.MARKS_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/collab': { target: API_TARGET.replace(/^http/, 'ws'), ws: true },
    },
  },
  // loro-crdt ships wasm-bindgen glue whose WebAssembly instance breaks when
  // esbuild pre-bundles it in dev, throwing "Cannot read properties of
  // undefined (reading 'memory')" at startup. Serve it unbundled instead.
  optimizeDeps: { exclude: ['loro-crdt'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Mermaid and the benchmark are dynamically imported, and the markdown
    // renderer lives in a worker, so the heavy dependencies already split out
    // of the critical path without hand-written chunking.
    chunkSizeWarningLimit: 900,
  },
});
