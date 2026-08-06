import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, `npm run dev` serves the UI from Vite and proxies the API and the
// SSH byte-pipe to a locally running `vibe-os start --port 7681`.
const BACKEND = process.env.VIBE_OS_BACKEND ?? 'http://127.0.0.1:7681';

export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/websocket': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    target: 'es2022',
    // The 20MB ssh.wasm lives in publicDir and is copied verbatim; nothing here
    // should try to inline it.
    assetsInlineLimit: 4096,
  },
});
