import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('webview', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('dist/webview', import.meta.url)),
    emptyOutDir: true,
  },
});
