import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCALES, MessageKey, format, getLocale, matchLocale, onLocaleChange, setLocale, t } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

describe('i18n', () => {
  afterEach(() => setLocale('en'));

  it('fills placeholders and leaves unknown ones alone', () => {
    expect(format('{name}: {bytes} bytes', { name: 'a.gb', bytes: 32768 })).toBe('a.gb: 32768 bytes');
    expect(format('{missing}', {})).toBe('{missing}');
  });

  it('translates and falls back to English for missing keys', () => {
    setLocale('de');
    expect(getLocale()).toBe('de');
    expect(t('song.author')).toBe('Autor');
    // German keeps the pattern column header by falling back to the base locale.
    expect(t('help.col.param')).toBe('Parameter');
    expect(t('tab.song')).toBe('SONG');
  });

  it('notifies listeners only when the locale changes', () => {
    const seen: string[] = [];
    const off = onLocaleChange((c) => seen.push(c));
    setLocale('de');
    setLocale('de');
    setLocale('xx'); // unknown codes fall back to English
    off();
    expect(seen).toEqual(['de', 'en']);
  });

  it('matches browser languages to supported locales', () => {
    expect(matchLocale(['de-AT', 'en-US'])).toBe('de');
    expect(matchLocale(['pt-BR', 'de-CH'])).toBe('de');
    expect(matchLocale(['ja-JP'])).toBe('en');
    expect(matchLocale([])).toBe('en');
  });

  it('starts with English and has unique locale codes', () => {
    expect(LOCALES[0].code).toBe('en');
    expect(new Set(LOCALES.map((l) => l.code)).size).toBe(LOCALES.length);
  });

  for (const locale of LOCALES.slice(1)) {
    it(`${locale.code}: only known keys, same placeholders as English`, () => {
      for (const [key, text] of Object.entries(locale.messages)) {
        expect(en, `unknown key ${key}`).toHaveProperty([key]);
        expect(placeholders(text!), key).toEqual(placeholders(en[key as MessageKey]));
      }
    });
  }

  it('every data-i18n key in the markup exists in the English locale', () => {
    const keys = sourceFiles('src').flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/data-i18n(?:-title|-aria-label)?="([\w.]+)"/g)].map((m) => m[1]),
    );
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expect(en, `unknown key ${key}`).toHaveProperty([key]);
  });
});
