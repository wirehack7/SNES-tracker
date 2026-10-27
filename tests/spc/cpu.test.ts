import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CYCLES, Spc700 } from '../../src/spc/cpu';

/**
 * Every opcode against cases from the SingleStepTests SPC700 suite
 * (https://github.com/SingleStepTests/spc700, MIT licence): registers, flags,
 * memory and cycles after one instruction from a random state. The cases are
 * picked by scripts/spc700-vectors.mjs.
 */
interface State {
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  psw: number;
  ram: [number, number][];
}
interface Case {
  initial: State;
  final: State;
  cycles: number;
}

const vectors: Record<string, Case[]> = JSON.parse(
  gunzipSync(readFileSync(new URL('./spc700-vectors.json.gz', import.meta.url))).toString('utf8'),
);

function run(c: Case) {
  const ram = new Uint8Array(0x10000);
  for (const [addr, v] of c.initial.ram) ram[addr] = v;
  const cpu = new Spc700({ read: (a) => ram[a], write: (a, v) => (ram[a] = v) });
  Object.assign(cpu, { pc: c.initial.pc, a: c.initial.a, x: c.initial.x, y: c.initial.y, sp: c.initial.sp });
  cpu.psw = c.initial.psw;
  const cycles = cpu.step();
  return {
    state: { pc: cpu.pc, a: cpu.a, x: cpu.x, y: cpu.y, sp: cpu.sp, psw: cpu.psw, ram: c.final.ram.map(([a]) => [a, ram[a]]) },
    cycles,
  };
}

const hex = (op: number) => op.toString(16).padStart(2, '0');

describe('SPC700 opcode coverage', () => {
  it('has reference cases for all 256 opcodes', () => {
    expect(Object.keys(vectors)).toHaveLength(256);
    for (let op = 0; op < 256; op++) expect(vectors[hex(op)].length).toBeGreaterThan(0);
  });

  for (let op = 0; op < 256; op++) {
    const name = hex(op).toUpperCase();
    // SLEEP and STOP halt the CPU: state and PC are checked, the cycles of the wait are not.
    const halts = op === 0xef || op === 0xff;
    it(`$${name}: registers, flags, memory and cycles match the reference`, () => {
      for (const c of vectors[hex(op)]) {
        const { state, cycles } = run(c);
        const { pc, a, x, y, sp, psw, ram } = c.final;
        expect(state, `$${name} from ${JSON.stringify(c.initial)}`).toEqual({ pc, a, x, y, sp, psw, ram });
        if (!halts) expect(cycles, `$${name} cycles`).toBe(c.cycles);
      }
    });
  }

  it('takes two more cycles only for a taken branch', () => {
    for (const op of [0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0, 0x03, 0x13, 0x2e, 0xde, 0x6e, 0xfe]) {
      const counts = new Set(vectors[hex(op)].map((c) => c.cycles - CYCLES[op]));
      for (const extra of counts) expect([0, 2]).toContain(extra);
    }
  });
});
