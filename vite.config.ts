/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { analytics } from './src/analytics/plugin';
import { manualPage } from './src/manual/plugin';
import { pwa } from './src/pwa/plugin';

export default defineConfig({
  // Relative base: the build works at the domain root and under https://<user>.github.io/<repo>/
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')).version),
  },
  plugins: [manualPage(import.meta.dirname), pwa(), analytics()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        manual: resolve(import.meta.dirname, 'manual.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // The DSP renders whole songs in some tests; instrumented for coverage they run several times slower.
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'text-summary', 'html'],
      // The engine is held to its coverage; the UI (main.ts and friends) is covered by the browser smoke test.
      thresholds: {
        'src/dsp/**': { lines: 95, branches: 85 },
        'src/tracker/**': { lines: 85, branches: 80 },
        'src/export/{spc,stream,wav,xm,zip}.ts': { lines: 90, branches: 80 },
      },
    },
  },
});
