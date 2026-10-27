// Renders scripts/social-preview.html to public/social-preview.png (1280x640).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const src = new URL('./social-preview.html', import.meta.url);
const out = fileURLToPath(new URL('../public/social-preview.png', import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.goto(src.href);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
