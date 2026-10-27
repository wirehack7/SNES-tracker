import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/audio/engine';
import { Dsp, FLG, KON, MVOLL } from '../../src/dsp/dsp';
import { buildSpc, spcFile } from '../../src/export/spc';
import { captureStream } from '../../src/export/stream';
import { Apu, CYCLES_PER_SAMPLE, IPL_ROM } from '../../src/spc/apu';
import { demoSong } from '../../src/tracker/demo';
import { tickUnits } from '../../src/tracker/player';
import { songWith } from '../helpers';

/** An SPC with a program at $0200, the given RAM bytes and DSP registers. */
function program(code: number[], ram: Record<number, number> = {}, regs: Record<number, number> = {}) {
  const image = new Uint8Array(0x10000);
  image.set(code, 0x200);
  for (const [a, v] of Object.entries(ram)) image[Number(a)] = v;
  const dsp = new Uint8Array(128);
  for (const [a, v] of Object.entries(regs)) dsp[Number(a)] = v;
  return spcFile(image, dsp, 0x200, { title: 'test', author: '', seconds: 1 });
}

function apuWith(spc: Uint8Array) {
  const apu = new Apu(new Dsp());
  apu.load(spc);
  return apu;
}

describe('APU', () => {
  it('boots from the IPL ROM and signals ready on the ports ($AA, $BB)', () => {
    const apu = new Apu(new Dsp());
    apu.reset();
    expect(apu.cpu.pc).toBe(0xffc0);
    expect(apu.read(0xffc0)).toBe(IPL_ROM[0]);
    apu.runCpu(20000); // clearing the zero page takes a while
    expect(Array.from(apu.outPorts.subarray(0, 2))).toEqual([0xaa, 0xbb]);
    // It waits for the SNES CPU to write $CC to port 0.
    const pc = apu.cpu.pc;
    expect(pc).toBeGreaterThanOrEqual(0xffc0);
  });

  it('restores CPU, timers, ports and DSP registers from an SPC file', () => {
    const spc = program([0x00], { 0xf1: 0x83, 0xf2: 0x4c, 0xf4: 0x12, 0xf7: 0x34, 0xfa: 0x10, 0xfd: 0x05 }, { [MVOLL]: 0x7f, [KON]: 0xff });
    spc[0x27] = 1;
    spc[0x28] = 2;
    spc[0x29] = 3;
    spc[0x2a] = 0x81;
    spc[0x2b] = 0xcf;
    const apu = apuWith(spc);
    expect([apu.cpu.pc, apu.cpu.a, apu.cpu.x, apu.cpu.y, apu.cpu.psw, apu.cpu.sp]).toEqual([0x200, 1, 2, 3, 0x81, 0xcf]);
    expect(apu.timers.map((t) => t.enabled)).toEqual([true, true, false]);
    expect(apu.timers[0].target).toBe(0x10);
    expect(apu.iplEnabled).toBe(true);
    expect(apu.read(0xf2)).toBe(0x4c);
    expect([apu.read(0xf4), apu.read(0xf7)]).toEqual([0x12, 0x34]);
    expect(apu.read(0xfd)).toBe(5);
    expect(apu.read(0xfd)).toBe(0); // reading clears the counter
    expect(apu.dsp.regs[MVOLL]).toBe(0x7f);
    expect(apu.dsp.regs[KON]).toBe(0); // already acted on in the snapshot
  });

  it('counts timer 0 at 8 kHz and timer 2 at 64 kHz through their dividers', () => {
    // mov $FA,#2 / mov $FC,#4 / mov $F1,#$05 / bra $
    const apu = apuWith(program([0x8f, 0x02, 0xfa, 0x8f, 0x04, 0xfc, 0x8f, 0x05, 0xf1, 0x2f, 0xfe]));
    apu.runCpu(15); // the setup
    apu.runCpu(128 * 2 * 3);
    expect(apu.read(0xfd)).toBe(3); // 3 × (2 periods of 128 cycles)
    expect(apu.read(0xff)).toBe(Math.floor((128 * 2 * 3) / 16 / 4));
    expect(apu.read(0xfe)).toBe(0); // timer 1 is off
  });

  it('wraps the 4-bit timer counter and restarts a timer that is switched on', () => {
    const apu = apuWith(program([0x2f, 0xfe], { 0xf1: 0x01, 0xfa: 1 }));
    apu.runCpu(128 * 17);
    expect(apu.timers[0].counter).toBe(1); // 17 & 15
    apu.write(0xf1, 0x00);
    apu.write(0xf1, 0x01);
    expect(apu.timers[0].counter).toBe(0);
  });

  it('reaches the DSP through $F2/$F3, with $80-$FF read-only', () => {
    const apu = apuWith(program([0x00]));
    apu.write(0xf2, MVOLL);
    apu.write(0xf3, 0x55);
    expect(apu.dsp.regs[MVOLL]).toBe(0x55);
    expect(apu.read(0xf3)).toBe(0x55);
    apu.write(0xf2, 0x80 | MVOLL);
    expect(apu.read(0xf3)).toBe(0x55); // mirror
    apu.write(0xf3, 0x11);
    expect(apu.dsp.regs[MVOLL]).toBe(0x55);
  });

  it('clears the input ports and switches the boot ROM with the control register', () => {
    const apu = apuWith(program([0x00], { 0xf4: 1, 0xf5: 2, 0xf6: 3, 0xf7: 4, 0xffc0: 0x99 }));
    apu.write(0xf1, 0x10);
    expect(Array.from(apu.inPorts)).toEqual([0, 0, 3, 4]);
    apu.write(0xf1, 0x20);
    expect(Array.from(apu.inPorts)).toEqual([0, 0, 0, 0]);
    expect(apu.iplEnabled).toBe(false);
    expect(apu.read(0xffc0)).toBe(0x99); // the RAM under the ROM
    apu.write(0xf1, 0x80);
    expect(apu.read(0xffc0)).toBe(IPL_ROM[0]);
    // Writes to $F4-$F7 go to the SNES side.
    apu.write(0xf5, 0x77);
    expect(apu.outPorts[1]).toBe(0x77);
    expect(apu.read(0xf5)).toBe(0);
  });

  it('keeps $F8/$F9 as RAM and reads the write-only registers as 0', () => {
    const apu = apuWith(program([0x00], { 0xf8: 0x12, 0xf1: 0x01, 0xfa: 0x40 }));
    expect(apu.read(0xf8)).toBe(0x12);
    for (const r of [0xf0, 0xf1, 0xfa, 0xfb, 0xfc]) expect(apu.read(r)).toBe(0);
  });

  it('skips the cycles a driver waits for a timer, and it counts the same ticks', () => {
    // loop: mov a,$FD+n / beq loop / inc $10 / bra loop
    for (const [n, target] of [[0, 3], [2, 40]]) {
      const code = [0xe4, 0xfd + n, 0xf0, 0xfc, 0xab, 0x10, 0x2f, 0xf8];
      const ticks = (skipIdle: boolean) => {
        const apu = apuWith(program(code, { 0xf1: 1 << n, [0xfa + n]: target }));
        apu.skipIdle = skipIdle;
        let steps = 0;
        const step = apu.cpu.step.bind(apu.cpu);
        apu.cpu.step = () => (steps++, step());
        apu.runCpu(64000);
        return { count: apu.ram[0x10], steps };
      };
      const plain = ticks(false);
      const fast = ticks(true);
      expect(Math.abs(plain.count - 64000 / ((n === 2 ? 16 : 128) * target)), `timer ${n}`).toBeLessThanOrEqual(1);
      expect(Math.abs(fast.count - plain.count)).toBeLessThanOrEqual(1);
      expect(fast.steps).toBeLessThan(plain.steps / 4);
    }
  });

  it('halts on SLEEP and STOP, and time goes on', () => {
    const apu = apuWith(program([0xef]));
    apu.run(10);
    expect(apu.cpu.halted).toBe(true);
    expect(apu.cpu.pc).toBe(0x201);
    expect(apu.cpu.run(100)).toBeGreaterThanOrEqual(100);
  });

  it('runs 32 CPU cycles per DSP sample', () => {
    const apu = apuWith(program([0x2f, 0xfe]));
    apu.run(1000);
    expect(apu.cpu.cycles).toBeGreaterThanOrEqual(1000 * CYCLES_PER_SAMPLE);
    expect(apu.cpu.cycles).toBeLessThan(1000 * CYCLES_PER_SAMPLE + 8);
    expect(apu.dsp.outCount).toBe(1000);
  });
});

describe('SPC playback', () => {
  it('plays the exported driver: the captured writes, in order, tick by tick', () => {
    const song = songWith([
      { row: 0, ch: 0, note: 48, instrument: 0 },
      { row: 1, ch: 1, note: 55, instrument: 1 },
      { row: 4, ch: 0, note: 60, instrument: 2 },
    ]);
    const captured = captureStream(song);
    const ticks = 12;
    const apu = apuWith(buildSpc(song).data);
    const writes: { sample: number; reg: number; value: number }[] = [];
    const write = apu.dsp.write.bind(apu.dsp);
    let sample = 0;
    apu.dsp.write = (reg, value) => {
      writes.push({ sample, reg, value });
      write(reg, value);
    };
    const units = tickUnits(song.bpm);
    for (; sample < (ticks + 1) * units * 4; sample++) apu.run(1);
    const expected = [...captured.loopState, ...captured.ticks.slice(0, ticks).flatMap((t) => t.writes)];
    expect(writes.slice(0, expected.length).map((w) => [w.reg, w.value])).toEqual(expected);
    // The driver takes the DSP out of reset.
    expect(apu.dsp.regs[FLG] & 0x80).toBe(0);
  });

  it('sounds like the tracker: held voices match it sample for sample', () => {
    const song = demoSong();
    const apu = new Apu(new Dsp({ captureVoices: true }));
    apu.load(buildSpc(song).data);
    const n = 32000 * 2;
    apu.run(n);
    const engine = new Engine(song, 32000, true);
    engine.play();
    engine.renderNative(n);
    // The driver needs a few samples to write the start state; find that offset on the strings (voices 2-4).
    const a = apu.dsp.voiceOut;
    const b = engine.dsp.voiceOut;
    const error = (lag: number, v: number) => {
      let d = 0;
      for (let i = 2000; i < 40000; i++) d += Math.abs(a[(i + lag) * 8 + v] - b[i * 8 + v]);
      return d;
    };
    let lag = 0;
    for (let l = 0; l < 400; l++) if (error(l, 1) < error(lag, 1)) lag = l;
    expect(lag).toBeGreaterThan(0);
    for (const v of [1, 2, 3]) expect(error(lag, v), `voice ${v + 1}`).toBe(0);
    let peak = 0;
    for (let i = 0; i < n * 2; i++) peak = Math.max(peak, Math.abs(apu.dsp.out[i]));
    expect(peak).toBeGreaterThan(8000);
  });
});

describe('engine', () => {
  it('plays an SPC instead of the song and goes back to the song', () => {
    const song = demoSong();
    const engine = new Engine(song);
    engine.playSpc(buildSpc(song).data);
    expect(engine.playingSpc).toBe(true);
    engine.setSong(song);
    const spc = engine.renderNative(8000);
    expect(spc.some((v) => v !== 0)).toBe(true);
    engine.play();
    expect(engine.playingSpc).toBe(false);
    engine.playSpc(buildSpc(song).data);
    engine.stop();
    expect(engine.playingSpc).toBe(false);
    // The song plays again from its own samples.
    engine.play();
    expect(engine.renderNative(8000).some((v) => v !== 0)).toBe(true);
  });
});
