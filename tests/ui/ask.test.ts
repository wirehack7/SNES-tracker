import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.(ts|html)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe('dialogs', () => {
  it('never uses the native alert, confirm or prompt boxes', () => {
    const files = [...sourceFiles('src'), 'index.html', 'manual.html'];
    const native = /(?<![\w.]|\.\s*)(?:window\.)?(?:alert|confirm|prompt)\s*\(/;
    const uses = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line: line.replace(/`[^`]*`|\/\/.*$|^\s*\*.*$/g, ''), at: `${file}:${i + 1}` }))
        .filter(({ line }) => native.test(line))
        .map(({ at }) => at),
    );
    expect(uses).toEqual([]);
  });
});
