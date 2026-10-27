import { t } from '../i18n';
import { HEIGHT, IntroText, WIDTH, renderFrame } from './intro';

const REPO_URL = 'https://github.com/wirehack7/SNES-tracker';

let dialog: HTMLDialogElement | null = null;

/** Opens the About dialog; built on first use, translated each time it opens. */
export function openAbout() {
  if (!dialog) dialog = buildDialog();
  dialog.querySelector('#about-close')!.setAttribute('aria-label', t('about.close'));
  dialog.querySelector('#about-body')!.innerHTML = body();
  dialog.showModal();
  startIntro(dialog.querySelector<HTMLCanvasElement>('#about-screen')!);
}

let stopIntro: (() => void) | null = null;

/** Runs the title demo on the dialog's canvas until the dialog closes; one still frame with reduced motion. */
function startIntro(canvas: HTMLCanvasElement) {
  stopIntro?.();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(WIDTH, HEIGHT);
  const pixels = new Uint32Array(image.data.buffer);
  const text: IntroText = {
    title: 'SNES TRACKER',
    subtitle: 'SPC700  +  S-DSP',
    scroller: t('about.scroller', { version: __APP_VERSION__ }),
    still: t('about.still'),
  };
  const draw = (seconds: number, still: boolean) => {
    renderFrame(pixels, seconds, text, { still });
    ctx.putImageData(image, 0, 0);
    canvas.dataset.frame = String(Number(canvas.dataset.frame ?? 0) + 1);
  };
  let frame = 0;
  let start = performance.now();
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const tick = (now: number) => {
    draw((now - start) / 1000, false);
    frame = requestAnimationFrame(tick);
  };
  const run = () => {
    cancelAnimationFrame(frame);
    if (motion.matches) draw(0, true);
    else {
      start = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  motion.addEventListener('change', run);
  // Tapping the screen plays the mosaic fade-in again.
  canvas.onclick = run;
  run();
  stopIntro = () => {
    cancelAnimationFrame(frame);
    motion.removeEventListener('change', run);
    stopIntro = null;
  };
}

function body() {
  const author = '<a href="https://github.com/wirehack7" target="_blank" rel="noopener">wirehack7</a>';
  return `
    <canvas class="about-screen" id="about-screen" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="${t('about.screen')}"></canvas>
    <h2 id="about-title">SNES TRACKER</h2>
    <p class="about-version" id="about-version">${t('about.version', { version: __APP_VERSION__ })}</p>
    <p>${t('about.text')}</p>
    <p>${t('about.credits', { author })}</p>
    <div class="btn-row">
      <a class="btn" id="about-repo" href="${REPO_URL}" target="_blank" rel="noopener">${t('about.repo')}</a>
      <a class="btn" id="about-manual" href="./manual.html" target="_blank" rel="noopener">${t('about.manual')}</a>
    </div>`;
}

function buildDialog(): HTMLDialogElement {
  const el = document.createElement('dialog');
  el.className = 'about';
  el.id = 'about';
  el.setAttribute('aria-labelledby', 'about-title');
  el.innerHTML = `
    <form method="dialog" class="about-close"><button class="btn" id="about-close" value="close">✕</button></form>
    <div id="about-body"></div>`;
  el.addEventListener('close', () => stopIntro?.());
  // A click on the backdrop closes the dialog.
  el.addEventListener('click', (e) => {
    if (e.target === el) el.close();
  });
  document.body.append(el);
  return el;
}
