import { t } from '../i18n';

const REPO_URL = 'https://github.com/wirehack7/SNES-tracker';

let dialog: HTMLDialogElement | null = null;

/** Opens the About dialog; built on first use, translated each time it opens. */
export function openAbout() {
  if (!dialog) dialog = buildDialog();
  dialog.querySelector('#about-close')!.setAttribute('aria-label', t('about.close'));
  dialog.querySelector('#about-body')!.innerHTML = body();
  dialog.showModal();
}

function body() {
  const author = '<a href="https://github.com/wirehack7" target="_blank" rel="noopener">wirehack7</a>';
  return `
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
  // A click on the backdrop closes the dialog.
  el.addEventListener('click', (e) => {
    if (e.target === el) el.close();
  });
  document.body.append(el);
  return el;
}
