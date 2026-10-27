/**
 * Renders the app icons (public/icon-*.png) from public/icon.svg in headless Chromium:
 *
 *   node scripts/icons.mjs
 *
 * The maskable icon puts the artwork inside the 80 % safe zone on a full-bleed background.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../public/', import.meta.url).pathname;
const svg = readFileSync(`${root}icon.svg`, 'utf8');
const browser = await chromium.launch();
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const inner = maskable ? size * 0.8 : size;
  const art = maskable ? svg.replace(/<rect width="512" height="512" rx="112"/, '<rect width="512" height="512" rx="0"') : svg;
  await page.setContent(
    `<body style="margin:0;background:${maskable ? '#3c3480' : 'transparent'};display:grid;place-items:center;height:100vh">` +
      `<div style="width:${inner}px;height:${inner}px">${art.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`,
  );
  await page.screenshot({ path: `${root}${name}`, omitBackground: !maskable });
  await page.close();
}
await browser.close();
