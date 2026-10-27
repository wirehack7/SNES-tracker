// Renders the screenshots in docs/images/ from the built site: npm run build && node scripts/manual-images.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { serveDist } from './serve-dist.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const images = fileURLToPath(new URL('../docs/images/', import.meta.url));

const shots = [
  { file: 'layout-desktop.png', viewport: { width: 1400, height: 900 } },
  { file: 'samples.png', viewport: { width: 1400, height: 900 }, tab: 'smpl' },
  { file: 'layout-phone.png', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
];

const { base, server } = await serveDist(root);
const browser = await chromium.launch();
for (const { file, tab, ...options } of shots) {
  // No service worker, so no "saved for offline use" toast in the picture.
  const context = await browser.newContext({ locale: 'en-US', colorScheme: 'light', serviceWorkers: 'block', ...options });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#pattern .prow');
  if (tab) await page.locator(`[data-tab="${tab}"]`).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: images + file });
  await context.close();
  console.log(`wrote docs/images/${file}`);
}
await browser.close();
server.close();
