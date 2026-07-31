import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: [
      'src/**/*.test.ts',
      'webview/src/**/*.test.ts',
      'webview/src/**/*.test.tsx',
    ],
  },
});
