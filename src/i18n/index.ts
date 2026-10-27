/**
 * UI translations.
 *
 * English (`locales/en.ts`) is the base locale and defines every message key.
 * Other locales may be incomplete: a missing key falls back to English, so a new
 * string only has to be added to `en.ts` to work everywhere.
 *
 * Adding a string:  add a key to `en.ts`, use `t('my.key')` in code (or
 *                   a `data-i18n` attribute in static markup), optionally translate
 *                   it in the other locale files.
 * Adding a locale:  create `locales/<code>.ts` exporting a `Translation`, then
 *                   register it in `LOCALES` below.
 */
import { en } from './locales/en';
import { de } from './locales/de';

export type MessageKey = keyof typeof en;
/** A locale's messages; missing keys fall back to English. */
export type Translation = Partial<Record<MessageKey, string>>;
export type Params = Record<string, string | number>;

export interface LocaleInfo {
  code: string;
  /** The language's own name, shown in the language switcher. */
  name: string;
  messages: Translation;
}

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'en', name: 'English', messages: en },
  { code: 'de', name: 'Deutsch', messages: de },
];

export const DEFAULT_LOCALE = 'en';

let current: LocaleInfo = LOCALES[0];
const listeners = new Set<(code: string) => void>();

/** Replaces `{name}` placeholders with values from `params`. */
export function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Translates `key` into the current locale. */
export function t(key: MessageKey, params?: Params): string {
  return format(current.messages[key] ?? en[key] ?? key, params);
}

export const getLocale = () => current.code;

/** Picks the best supported locale for a list of BCP 47 tags (e.g. `navigator.languages`). */
export function matchLocale(tags: readonly string[]): string {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    const exact = LOCALES.find((l) => l.code.toLowerCase() === lower);
    if (exact) return exact.code;
    const base = LOCALES.find((l) => l.code.toLowerCase() === lower.split('-')[0]);
    if (base) return base.code;
  }
  return DEFAULT_LOCALE;
}

export function setLocale(code: string) {
  const next = LOCALES.find((l) => l.code === code) ?? LOCALES[0];
  if (next === current) return;
  current = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next.code;
  listeners.forEach((fn) => fn(next.code));
}

export function onLocaleChange(fn: (code: string) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Translates static markup in `root`:
 * `data-i18n` sets the text, `data-i18n-title` and `data-i18n-aria-label` set those attributes.
 */
export function translateDom(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as MessageKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle as MessageKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel as MessageKey));
  });
}
