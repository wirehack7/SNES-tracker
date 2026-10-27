// Picks test cases from the SingleStepTests SPC700 suite (https://github.com/SingleStepTests/spc700,
// MIT licence) for tests/spc/spc700-vectors.json.gz: per opcode the first N cases, without the bus log
// (its length is the cycle count).
//
//   node scripts/spc700-vectors.mjs <path to spc700/v1> [cases per opcode]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [dir, count = '24'] = process.argv.slice(2);
if (!dir) throw new Error('usage: node scripts/spc700-vectors.mjs <spc700/v1> [cases]');
const out = {};
for (let op = 0; op < 256; op++) {
  const name = op.toString(16).padStart(2, '0');
  const cases = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
  out[name] = cases.slice(0, Number(count)).map(({ initial, final, cycles }) => ({ initial, final, cycles: cycles.length }));
}
const file = new URL('../tests/spc/spc700-vectors.json.gz', import.meta.url);
writeFileSync(file, gzipSync(JSON.stringify(out), { level: 9 }));
console.log(`${Object.keys(out).length} opcodes, ${count} cases each`);
