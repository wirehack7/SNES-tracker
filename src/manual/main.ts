import '../theme.css';
import './manual.css';

// Same storage key as the tracker, so both pages share the theme.
const THEME_KEY = 'snes-tracker.theme';

function loadTheme(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

const themeBtn = document.getElementById('m-theme')!;
function applyTheme(theme: string | null) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const [icon, label] = theme === 'dark' ? ['☾', 'DARK'] : theme === 'light' ? ['☀', 'LIGHT'] : ['◐', 'AUTO'];
  themeBtn.innerHTML = `${icon}<span class="m-long"> ${label}</span>`;
  themeBtn.setAttribute('aria-label', `Theme: ${label.toLowerCase()}`);
}
applyTheme(loadTheme());
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme ?? 'auto';
  const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage unavailable (private mode) */
  }
  applyTheme(next);
});

// Contents drawer on small screens.
const nav = document.getElementById('m-nav')!;
const menu = document.getElementById('m-menu')!;
const setOpen = (open: boolean) => {
  nav.classList.toggle('open', open);
  menu.setAttribute('aria-expanded', String(open));
};
menu.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
nav.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('a')) setOpen(false);
});

// Highlight the section being read.
const links = new Map([...nav.querySelectorAll<HTMLAnchorElement>('a')].map((a) => [a.hash.slice(1), a]));
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.removeAttribute('aria-current'));
      links.get(e.target.id)?.setAttribute('aria-current', 'true');
    }
  },
  { rootMargin: '0px 0px -75% 0px' },
);
document.querySelectorAll('.m-doc h2[id]').forEach((h) => observer.observe(h));
