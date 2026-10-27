import { describe, expect, it } from 'vitest';
import { DIR, EDL, ESA, FLG, KON, V_SRCN } from '../../src/dsp/dsp';
import { DIR_PAGE, DRIVER_ADDR, SAMPLES_ADDR, layoutAram } from '../../src/tracker/aram';
import { SAMPLES_PER_UNIT, tickUnits } from '../../src/tracker/player';
import { createSong } from '../../src/tracker/song';
import { DRIVER, ZP_LOOP, ZP_PTR, ZP_UNITS, buildSpc, spcFile } from '../../src/export/spc';
import { CMD_LOOP, CMD_TEMPO, MAX_WAIT, captureStream, encodeStream } from '../../src/export/stream';
import { demoSong } from '../../src/tracker/demo';
import { songWith } from '../helpers';
import { Spc700 } from './spc700';

const text = (data: Uint8Array, offset: number, length: number) =>
  new TextDecoder('latin1').decode(data.subarray(offset, offset + length)).replace(/\0.*$/, '');

describe('register stream', () => {
  it('starts at the loop point with the state and the tempo, and ends with the loop', () => {
    const song = songWith([{ row: 0, ch: 0, note: 48, instrument: 0 }]);
    const captured = captureStream(song);
    const { data, loopOffset, units } = encodeStream(captured);
    expect(units).toBe(tickUnits(song.bpm));
    // This song loops back to its first tick, so the stream starts at the loop point.
    expect(loopOffset).toBe(0);
    const state = captured.loopState.flat();
    expect(Array.from(data.subarray(0, state.length))).toEqual(state);
    expect(data[state.length]).toBe(CMD_TEMPO);
    expect(data[state.length + 1] | (data[state.length + 2] << 8)).toBe(units);
    expect(data.at(-1)).toBe(CMD_LOOP);
  });

  it('packs register writes as pairs and waits as one byte each', () => {
    const song = songWith([{ row: 0, ch: 0, note: 48, instrument: 0 }]);
    const { ticks } = captureStream(song);
    const { data } = encodeStream(captureStream(song));
    // Every byte is a register below $80, a wait, the tempo or the loop.
    let waits = 0;
    for (let i = 0; i < data.length; ) {
      const b = data[i];
      if (b === CMD_LOOP) break;
      if (b === CMD_TEMPO) i += 3;
      else if (b >= 0x81) {
        expect(b).toBeLessThanOrEqual(0x80 + MAX_WAIT);
        waits += b - 0x80;
        i += 1;
      } else {
        expect(b).toBeLessThan(0x80);
        i += 2;
      }
    }
    expect(waits).toBe(ticks.length);
  });

  it('captures the whole song once and remembers where it loops', () => {
    const captured = captureStream(demoSong());
    expect(captured.ticks.length).toBe(2 * 64 * 6); // two patterns, 64 rows, speed 6
    expect(captured.loopTick).toBe(0);
    // The state at the loop point is written again, without KON.
    expect(captured.loopState.length).toBeGreaterThan(10);
    expect(captured.loopState.some(([reg]) => reg === KON)).toBe(false);
  });
});

describe('SPC file', () => {
  const spc = buildSpc(demoSong(), { date: new Date(Date.UTC(2026, 0, 2)) });

  it('has the header, the ID666 tags and the right size', () => {
    expect(spc.data).toHaveLength(0x10200);
    expect(text(spc.data, 0, 33)).toBe('SNES-SPC700 Sound File Data v0.30');
    expect(spc.data[0x23]).toBe(26); // has ID666 text tags
    expect(spc.data[0x24]).toBe(30); // version minor
    expect(spc.data[0x25] | (spc.data[0x26] << 8)).toBe(DRIVER_ADDR);
    expect(text(spc.data, 0x2e, 32)).toBe('Demo');
    expect(text(spc.data, 0x6e, 16)).toBe('SNES Tracker');
    expect(text(spc.data, 0x9e, 11)).toBe('01/02/2026');
    expect(Number(text(spc.data, 0xa9, 3))).toBe(Math.ceil(spc.seconds));
  });

  it('holds the driver, the sample directory and the song', () => {
    const ram = spc.data.subarray(0x100, 0x10100);
    expect(Array.from(ram.subarray(DRIVER_ADDR, DRIVER_ADDR + DRIVER.length))).toEqual(Array.from(DRIVER));
    const layout = layoutAram(demoSong());
    expect(Array.from(ram.subarray(0x400, 0x400 + layout.image.length))).toEqual(Array.from(layout.image));
    const start = ram[ZP_PTR] | (ram[ZP_PTR + 1] << 8);
    expect(start).toBe(layout.end);
    expect(ram[ZP_UNITS] | (ram[ZP_UNITS + 1] << 8)).toBe(tickUnits(120));
    const loop = ram[ZP_LOOP] | (ram[ZP_LOOP + 1] << 8);
    expect(loop).toBeGreaterThanOrEqual(start);
    expect(loop).toBeLessThan(start + spc.streamBytes);
    expect(spc.free).toBeGreaterThan(0);
  });

  it('starts the DSP with the echo off and the buffer where the samples end', () => {
    const regs = spc.data.subarray(0x10100, 0x10180);
    expect(regs[FLG]).toBe(0xe0); // reset, mute, echo writes off: the driver turns them on
    expect(regs[EDL]).toBe(demoSong().echo.delay);
    expect(regs[ESA]).toBe(layoutAram(demoSong()).esa);
  });

  it('refuses a song that does not fit in audio RAM', () => {
    const song = createSong();
    song.echo.delay = 15; // 30 KiB of echo buffer
    const big = { name: 'big', brr: Buffer.alloc(30000, 3).toString('base64'), loop: -1, rate: 32000 };
    song.samples.push(big);
    expect(() => buildSpc(song)).toThrow(/audio RAM/);
  });
});

describe('the exported driver on an SPC700', () => {
  /** Runs the SPC image for `periods` timer 0 periods and collects its DSP writes. */
  function run(song: ReturnType<typeof createSong>, periods: number) {
    const spc = buildSpc(song);
    const cpu = new Spc700(spc.data.slice(0x100, 0x10100));
    cpu.pc = DRIVER_ADDR;
    cpu.run(periods);
    return cpu;
  }

  it('plays the captured writes in order and at the captured times', () => {
    const song = songWith([
      { row: 0, ch: 0, note: 48, instrument: 0 },
      { row: 1, ch: 1, note: 55, instrument: 1 },
      { row: 4, ch: 0, note: 60, instrument: 2 },
    ]);
    const captured = captureStream(song);
    const ticks = 12;
    const units = tickUnits(song.bpm);
    const cpu = run(song, units * ticks);

    // The same register writes, in the same order, as the player made.
    // The driver first writes the state of the loop point, then tick by tick.
    const expected = [...captured.loopState, ...captured.ticks.slice(0, ticks).flatMap((t) => t.writes)];
    expect(cpu.writes.slice(0, expected.length).map((w) => [w.register, w.value])).toEqual(expected);

    // Every tick's writes land in its own timer window (one period = 125 µs).
    let time = 0;
    let i = captured.loopState.length;
    for (const tick of captured.ticks.slice(0, ticks - 1)) {
      for (const _ of tick.writes) {
        expect(cpu.writes[i].time, `write ${i}`).toBeGreaterThanOrEqual(time - 1);
        expect(cpu.writes[i].time, `write ${i}`).toBeLessThan(time + units);
        i++;
      }
      time += units;
    }
  });

  it('sets up the sample directory and the voice it plays', () => {
    const song = songWith([{ row: 0, ch: 0, note: 48, instrument: 0 }]);
    const cpu = run(song, tickUnits(song.bpm) * 3);
    const wrote = (reg: number) => cpu.writes.find((w) => w.register === reg)?.value;
    expect(wrote(DIR)).toBe(DIR_PAGE);
    // The driver takes the DSP out of reset and unmutes it; echo writes stay off while nothing uses them.
    expect(wrote(FLG)! & 0xa0).toBe(0);
    expect(wrote(V_SRCN)).toBe(song.instruments[0].sample);
    expect(wrote(KON)).toBe(1);
    // The samples sit after the silent block the layout puts at $0500.
    expect(layoutAram(song).starts[0]).toBe(SAMPLES_ADDR + 9);
  });

  it('keeps the tempo a tempo command sets', () => {
    const song = songWith([
      { row: 0, ch: 0, note: 48, instrument: 0 },
      { row: 2, ch: 0, effect: 0xf, param: 0x50 }, // 80 BPM from row 2
    ]);
    const captured = captureStream(song);
    const fast = tickUnits(song.bpm);
    const slow = tickUnits(0x50);
    expect(captured.ticks[0].units).toBe(fast);
    expect(captured.ticks.at(-1)!.units).toBe(slow);
    const cpu = run(song, fast * 12 + slow * 6);
    // The driver takes the new tempo from the stream: after the row-2 tick the
    // waits are the slow ones, so twelve fast ticks fit into the first window.
    const kons = cpu.writes.filter((w) => w.register === KON && w.value !== 0);
    expect(kons.length).toBeGreaterThanOrEqual(1);
    expect(kons[0].time).toBeLessThan(fast);
    const ram = cpu.ram;
    expect(ram[2] | (ram[3] << 8)).toBe(slow);
  });

  it('loops back to the loop point and plays on', () => {
    const song = songWith([{ row: 0, ch: 0, note: 48, instrument: 0 }]);
    song.patterns[0].rows.length = 4;
    const units = tickUnits(song.bpm);
    const perSong = units * 4 * song.speed;
    const cpu = run(song, perSong * 2 + units * 2);
    const kons = cpu.writes.filter((w) => w.register === KON && w.value === 1);
    expect(kons.length).toBeGreaterThanOrEqual(2);
    // The second key-on comes one song length after the first (plus the few
    // hundred microseconds the driver needs to write the loop state again).
    const gap = kons[1].time - kons[0].time;
    expect(gap).toBeGreaterThanOrEqual(perSong);
    expect(gap).toBeLessThan(perSong + units);
  });
});

describe('spcFile', () => {
  it('copies the RAM image, the DSP registers and the top of RAM', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x1234] = 0x42;
    ram[0xffc3] = 0x99;
    const regs = new Uint8Array(128).fill(7);
    const data = spcFile(ram, regs, 0x0200, { title: 'T', author: 'A', seconds: 3 });
    expect(data[0x100 + 0x1234]).toBe(0x42);
    expect(data[0x10100]).toBe(7);
    expect(data[0x101c0 + 3]).toBe(0x99);
    expect(text(data, 0xb1, 32)).toBe('A');
  });

  it('leaves non-ASCII out of the tags instead of writing broken bytes', () => {
    const data = spcFile(new Uint8Array(0x10000), new Uint8Array(128), 0x200, { title: 'Grüße ☆', author: '', seconds: 1 });
    expect(text(data, 0x2e, 32)).toBe('Grue ');
  });
});

it('a tick is four DSP samples per timer period', () => {
  expect(SAMPLES_PER_UNIT).toBe(4);
  expect(tickUnits(120)).toBe(Math.round(20000 / 120));
});
