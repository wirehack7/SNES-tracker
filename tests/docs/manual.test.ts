import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../../src/i18n/locales/en';
import { renderManual, slug } from '../../src/manual/render';
import { FX } from '../../src/tracker/player';

const root = resolve(import.meta.dirname, '../..');
const manual = readFileSync(resolve(root, 'docs/MANUAL.md'), 'utf8');

/** Rows of the markdown table that follows `## <heading>` (first cells only). */
function firstCells(heading: string): string[] {
  const start = manual.indexOf(`\n## ${heading}\n`);
  expect(start, `section "${heading}"`).toBeGreaterThan(0);
  const end = manual.indexOf('\n## ', start + 1);
  return manual
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| ---'))
    .map((l) => l.split('|')[1].trim());
}

describe('manual', () => {
  it('documents every effect the player implements', () => {
    const documented = firstCells('Effects');
    for (const [name, code] of Object.entries(FX)) {
      const digit = code.toString(16).toUpperCase();
      expect(
        documented.some((c) => c.startsWith('`' + digit)),
        `effect ${digit} (${name})`,
      ).toBe(true);
    }
  });

  const labels = (prefix: RegExp, exclude: RegExp = /Title$|title$|hint$|Hint$|confirm|Error$|Ready$|^export\.(rendering|size|loops|preparing|unsupported|ready|spcReady)$/) =>
    Object.entries(en)
      .filter(([k]) => prefix.test(k) && !exclude.test(k))
      .map(([, v]) => v);

  it('names every button of the FILE tab', () => {
    const buttons = labels(/^(file\.(new|store|saveAs|demo|open|save|backup)|export\.\w+)$/);
    expect(buttons.length).toBeGreaterThan(8);
    for (const label of buttons) expect(manual, label).toContain(label);
  });

  it('names every toolbar button', () => {
    for (const label of [en['piano.toggle'], 'MIDI']) expect(manual, label).toContain(`**${label}**`);
  });

  it('names every tab and mobile view', () => {
    const tabs = labels(/^(tab|nav)\.\w+$/, /^nav\.views$/);
    expect(tabs.length).toBeGreaterThan(5);
    for (const tab of tabs) expect(manual, tab).toContain(tab);
  });

  it('only links to sections that exist', () => {
    const { html } = renderManual(manual);
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    ids.add('contents');
    const anchors = [...manual.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(10);
    for (const a of anchors) expect(ids.has(a), `#${a}`).toBe(true);
  });

  it('only shows images that are in the repository', () => {
    for (const [, src] of manual.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      expect(existsSync(resolve(root, 'docs', src)), src).toBe(true);
    }
  });

  it('builds the site navigation from the level 2 headings', () => {
    const { html, sections } = renderManual(manual, './docs/');
    expect(sections[0]).toEqual({ id: 'quick-start', title: 'Quick start' });
    expect(sections.some((s) => s.id === 'contents')).toBe(false);
    expect(html).not.toContain('id="contents"');
    expect(html).toContain('src="./docs/images/');
    expect(html).toContain('<div class="table-wrap"><table>');
  });

  it('creates GitHub compatible anchors', () => {
    expect(slug('Song structure: order list and patterns')).toBe('song-structure-order-list-and-patterns');
    expect(slug('The sound hardware')).toBe('the-sound-hardware');
    expect(slug('Making samples')).toBe('making-samples');
  });
});
