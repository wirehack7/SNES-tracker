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
  },
});
