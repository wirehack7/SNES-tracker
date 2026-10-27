import { describe, expect, it } from 'vitest';
import { C4 } from '../../src/tracker/notes';
import { FX, VOICE_FLAG } from '../../src/tracker/player';
import { CHANNEL_COUNT, EMPTY, NOTE_OFF, createSong, defaultInstrument } from '../../src/tracker/song';
import { decodeSample } from '../../src/tracker/sample';
import { Warnings, XM_KEY_OFF, encodeXm, fadeout, measureEnvelope, simplify, translateEffect, xmTuning } from '../../src/export/xm';
import { demoSong } from '../../src/tracker/demo';
import { songWith } from '../helpers';

const str = (data: Uint8Array, offset: number, length: number) =>
  new TextDecoder('latin1').decode(data.subarray(offset, offset + length)).replace(/\0+$/, '');
const u16 = (data: Uint8Array, o: number) => data[o] | (data[o + 1] << 8);
const u32 = (data: Uint8Array, o: number) => u16(data, o) | (u16(data, o + 2) << 16);

describe('XM tuning', () => {
  it('plays 8363 Hz samples with no shift at all', () => {
    expect(xmTuning(8363)).toEqual({ relativeNote: 0, finetune: 0 });
  });

  it('turns a sample rate into relative note and finetune', () => {
    expect(xmTuning(16726)).toEqual({ relativeNote: 12, finetune: 0 });
    expect(xmTuning(4181.5)).toEqual({ relativeNote: -12, finetune: 0 });
    const { relativeNote, finetune } = xmTuning(16000);
    expect(relativeNote).toBe(11);
    expect(finetune).toBeGreaterThan(0);
    expect(finetune).toBeLessThanOrEqual(127);
  });

  it('shifts by the instrument transpose and stays in range', () => {
    expect(xmTuning(8363, 5).relativeNote).toBe(5);
    expect(xmTuning(8363, 400).relativeNote).toBe(95);
    expect(xmTuning(8363, -400).relativeNote).toBe(-96);
  });
});

describe('envelopes', () => {
  it('measures an ADSR envelope rising and falling on the DSP', () => {
    const ins = defaultInstrument(0, 0);
    ins.envelope = 'adsr';
    ins.adsr = { attack: 8, decay: 4, sustain: 3, sustainRate: 16 };
    const curve = measureEnvelope(ins, 125, 60);
    expect(curve).toHaveLength(60);
    expect(curve[0]).toBeLessThan(curve[5]);
    expect(Math.max(...curve)).toBeGreaterThan(100);
    expect(curve.at(-1)).toBeLessThan(Math.max(...curve));
  });

  it('measures a flat GAIN level as a flat curve', () => {
    const ins = defaultInstrument(0, 0);
    ins.envelope = 'gain';
    ins.gain = 0x60;
    const curve = measureEnvelope(ins, 125, 20);
    expect(new Set(curve).size).toBe(1);
    expect(curve[0]).toBe(0x60);
  });

  it('simplifies a curve to at most twelve points that still follow it', () => {
    const curve = Array.from({ length: 200 }, (_, i) => Math.round(127 * Math.exp(-i / 40)));
    const points = simplify(curve, 12);
    expect(points.length).toBeLessThanOrEqual(12);
    expect(points[0].tick).toBe(0);
    expect(points.at(-1)!.tick).toBe(199);
    // The points are in order and scaled to the XM range of 0..64.
    for (let i = 1; i < points.length; i++) expect(points[i].tick).toBeGreaterThan(points[i - 1].tick);
    for (const p of points) expect(p.value).toBeLessThanOrEqual(64);
    // Reading the curve back from the points stays close to the original.
    const at = (tick: number) => {
      const next = points.findIndex((p) => p.tick >= tick);
      const b = points[next];
      const a = points[Math.max(0, next - 1)];
      return a.tick === b.tick ? a.value : a.value + ((b.value - a.value) * (tick - a.tick)) / (b.tick - a.tick);
    };
    for (let i = 0; i < 200; i += 7) expect(Math.abs(at(i) - (curve[i] * 64) / 127)).toBeLessThan(4);
  });

  it('turns the release into a fadeout', () => {
    const slow = defaultInstrument(0, 0);
    slow.release = 20;
    const fast = defaultInstrument(0, 0);
    fast.release = 31;
    expect(fadeout(fast, 125)).toBeGreaterThan(fadeout(slow, 125));
    expect(fadeout(slow, 125)).toBeLessThanOrEqual(0xfff);
    // Without a release the key off is almost instant.
    const none = defaultInstrument(0, 0);
    none.release = 0;
    expect(fadeout(none, 125)).toBe(0xfff);
  });
});

describe('effect translation', () => {
  it('keeps the effects XM has in the same units', () => {
    const warn = new Warnings();
    expect(translateEffect(FX.ARPEGGIO, 0x47, warn)).toEqual([0, 0x47]);
    expect(translateEffect(FX.SLIDE_UP, 0x20, warn)).toEqual([1, 0x20]);
    expect(translateEffect(FX.PORTAMENTO, 0x10, warn)).toEqual([3, 0x10]);
    expect(translateEffect(FX.PANNING, 0x80, warn)).toEqual([8, 0x80]);
    expect(translateEffect(FX.POSITION_JUMP, 3, warn)).toEqual([0xb, 3]);
    expect(warn.list()).toEqual([]);
  });

  it('halves the vibrato depth and the volume slide, XM counts them twice', () => {
    const warn = new Warnings();
    expect(translateEffect(FX.VIBRATO, 0x64, warn)).toEqual([4, 0x62]);
    expect(translateEffect(FX.VOLUME_SLIDE, 0x40, warn)).toEqual([0xa, 0x20]);
  });

  it('writes the pattern break row in decimal, as XM does', () => {
    const warn = new Warnings();
    expect(translateEffect(FX.PATTERN_BREAK, 32, warn)).toEqual([0xd, 0x32]);
  });

  it('maps note delay and cut to the E commands', () => {
    const warn = new Warnings();
    expect(translateEffect(FX.NOTE_DELAY, 5, warn)).toEqual([0xe, 0xd5]);
    expect(translateEffect(FX.NOTE_CUT, 3, warn)).toEqual([0xe, 0xc3]);
    expect(translateEffect(FX.NOTE_CUT, 40, warn)).toEqual([0xe, 0xcf]);
    expect(warn.list().join()).toMatch(/note cuts/);
  });

  it('warns about the effects only the SNES has', () => {
    const warn = new Warnings();
    expect(translateEffect(FX.ECHO_VOLUME, 0x40, warn)).toBeNull();
    expect(translateEffect(FX.ECHO_FEEDBACK, 0x40, warn)).toBeNull();
    expect(translateEffect(FX.NOISE_CLOCK, 10, warn)).toBeNull();
    expect(translateEffect(FX.VOICE_FLAGS, (VOICE_FLAG.PITCH_MOD << 4) | 1, warn)).toBeNull();
    expect(warn.list()).toContain('echo changes (2×)');
    expect(warn.list()).toContain('noise clock (1×)');
    expect(warn.list()).toContain('pitch modulation (1×)');
  });
});

describe('XM file', () => {
  const { data, warnings } = encodeXm(demoSong());

  it('has the header a tracker expects', () => {
    expect(str(data, 0, 17)).toBe('Extended Module: ');
    expect(str(data, 17, 20)).toBe('Demo');
    expect(data[37]).toBe(0x1a);
    expect(str(data, 38, 20)).toBe('SNES Tracker');
    expect(u16(data, 58)).toBe(0x0104);
    expect(u32(data, 60)).toBe(276);
    expect(u16(data, 68)).toBe(CHANNEL_COUNT);
    expect(u16(data, 70)).toBe(2); // patterns
    expect(u16(data, 74)).toBe(1); // linear frequencies
    expect(u16(data, 76)).toBe(6); // speed
    expect(u16(data, 78)).toBe(120); // BPM
    expect(u16(data, 64)).toBe(2); // song length
    expect(Array.from(data.subarray(80, 82))).toEqual([0, 1]); // the order list
  });

  it('warns about what XM cannot play', () => {
    expect(warnings.some((w) => /echo/.test(w))).toBe(true);
  });

  it('writes 16-bit delta samples that decode back to the BRR audio', () => {
    const song = createSong();
    song.samples = [song.samples[5]]; // Sine
    song.instruments = [{ ...song.instruments[0], sample: 0, name: 'Sine' }];
    song.patterns[0].rows[0][0] = { note: C4, instrument: 0, volume: 0x7f, effect: EMPTY, param: 0 };
    const { data } = encodeXm(song);
    // Walk to the instrument: header, then the pattern.
    const headerSize = u32(data, 60);
    const patternHeader = 60 + headerSize;
    const patternBytes = u16(data, patternHeader + 7);
    const instrument = patternHeader + u32(data, patternHeader) + patternBytes;
    expect(u32(data, instrument)).toBe(263);
    expect(str(data, instrument + 4, 22)).toBe('Sine');
    expect(u16(data, instrument + 27)).toBe(1); // one sample
    const sampleHeader = instrument + 263;
    const pcm = decodeSample(song.samples[0]);
    expect(u32(data, sampleHeader)).toBe(pcm.length * 2);
    expect(data[sampleHeader + 14] & 0x10).toBe(0x10); // 16-bit
    expect(data[sampleHeader + 14] & 3).toBe(1); // forward loop
    // The sample data is delta encoded.
    const start = sampleHeader + 40;
    let value = 0;
    const back: number[] = [];
    for (let i = 0; i < pcm.length; i++) {
      value = (value + ((u16(data, start + i * 2) << 16) >> 16)) << 16 >> 16;
      back.push(value);
    }
    expect(back).toEqual(Array.from(pcm));
  });

  it('writes notes, instruments, volumes and note offs into the pattern', () => {
    const song = songWith([
      { row: 0, ch: 0, note: C4, instrument: 2, volume: 0x7f },
      { row: 1, ch: 0, note: NOTE_OFF },
    ]);
    const { data } = encodeXm(song);
    const patternHeader = 60 + u32(data, 60);
    const rows = data.subarray(patternHeader + 9);
    // Packed cell: a mask byte, then only the fields that are set.
    expect(rows[0]).toBe(0x80 | 1 | 2 | 4);
    expect(rows[1]).toBe(C4 + 1);
    expect(rows[2]).toBe(3); // instruments are 1-based in XM
    expect(rows[3]).toBe(0x10 + 64); // volume column: 0x10 + 0..64
    const second = 4 + (CHANNEL_COUNT - 1) * 1; // the empty cells of the other voices
    expect(rows[second]).toBe(0x81);
    expect(rows[second + 1]).toBe(XM_KEY_OFF);
  });
});
