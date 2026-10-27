import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** The service worker for a build: the template with the cache name and the files to keep offline. */
export function serviceWorker(files: { path: string; data: Uint8Array }[]): string {
  const hash = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1)))
    hash.update(f.path).update('\0').update(f.data);
  // The tracker is opened as ./ and as ./index.html.
  const paths = ['./', ...files.map((f) => f.path).sort()];
  const template = readFileSync(resolve(import.meta.dirname, 'sw.js'), 'utf8');
  return (
    `const CACHE = ${JSON.stringify(`snes-tracker-${hash.digest('hex').slice(0, 12)}`)};\n` +
    `const FILES = ${JSON.stringify(paths)};\n` +
    template
  );
}

function listFiles(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), root) : [relative(root, join(dir, e.name)).split('\\').join('/')],
  );
}

/**
 * Writes sw.js next to the built site, so the installed app (PWA) works
 * offline. The whole build is small (well under a megabyte), so all of it is
 * cached on install.
 */
export function pwa(): Plugin {
  let outDir = '';
  return {
    name: 'snes-tracker-pwa',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = listFiles(outDir)
        .filter((path) => path !== 'sw.js')
        .map((path) => ({ path, data: readFileSync(join(outDir, path)) }));
      writeFileSync(join(outDir, 'sw.js'), serviceWorker(files));
    },
  };
}
