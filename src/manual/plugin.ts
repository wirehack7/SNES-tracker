import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { renderManual } from './render';

/**
 * Fills manual.html with docs/MANUAL.md at build time (and on every request
 * in the dev server), so the repository and the site share one source. The
 * manual's images are served and built under ./docs/images/, the path they
 * also have on GitHub.
 */
export function manualPage(root: string): Plugin {
  const source = resolve(root, 'docs/MANUAL.md');
  const images = resolve(root, 'docs/images');
  let isBuild = false;
  const imageFiles = () => (existsSync(images) ? readdirSync(images).filter((f) => /\.(png|jpe?g|gif|svg|webp)$/i.test(f)) : []);
  return {
    name: 'snes-tracker-manual',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    configureServer(server) {
      server.watcher.add(source);
      server.watcher.on('change', (file) => {
        if (resolve(file) === source) server.ws.send({ type: 'full-reload' });
      });
      // The dev server has no public/docs: serve the repository's images instead.
      server.middlewares.use((req, res, next) => {
        const name = /^\/docs\/images\/([^/?#]+)/.exec(req.url ?? '')?.[1];
        if (!name || !imageFiles().includes(name)) return next();
        const ext = name.split('.').pop()!.toLowerCase();
        res.setHeader('content-type', ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
        res.end(readFileSync(resolve(images, name)));
      });
    },
    buildStart() {
      if (!isBuild) return;
      for (const name of imageFiles())
        this.emitFile({ type: 'asset', fileName: `docs/images/${name}`, source: readFileSync(resolve(images, name)) });
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.filename.endsWith('manual.html')) return html;
        const { html: body, sections } = renderManual(readFileSync(source, 'utf8'), './docs/');
        const nav = sections.map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`).join('');
        return html.replace('<!-- manual:nav -->', nav).replace('<!-- manual:body -->', body);
      },
    },
  };
}
