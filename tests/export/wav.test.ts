import { describe, expect, it } from 'vitest';
import { DSP_RATE } from '../../src/dsp/dsp';
import { Engine } from '../../src/audio/engine';
import { C4, noteFrequency } from '../../src/tracker/notes';
import { createSong, parseSong } from '../../src/tracker/song';
import { encodeWav, renderSong, renderStems } from '../../src/export/wav';
import { demoSong } from '../../src/tracker/demo';
import { frequency, renderLeft, songWith } from '../helpers';

const str = (data: Uint8Array, o: number, n: number) => new TextDecoder('latin1').decode(data.subarray(o, o + n));
const u32 = (data: Uint8Array, o: number) => data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24);
const peak = (d: ArrayLike<number>) => {
  let p = 0;
  for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
  return p;
};

describe('WAV', () => {
  it('writes a 16-bit stereo RIFF file', () => {
    const left = Float32Array.from([0, 0.5, -0.5, 1]);
    const right = Float32Array.from([0, -0.5, 0.5, -1]);
    const wav = encodeWav(left, right, 32000);
    expect(str(wav, 0, 4)).toBe('RIFF');
    expect(str(wav, 8, 4)).toBe('WAVE');
    expect(str(wav, 12, 4)).toBe('fmt ');
    expect(wav[20]).toBe(1); // PCM
    expect(wav[22]).toBe(2); // stereo
    expect(u32(wav, 24)).toBe(32000);
    expect(wav[34]).toBe(16);
    expect(str(wav, 36, 4)).toBe('data');
    expect(u32(wav, 40)).toBe(4 * 2 * 2);
    expect(wav).toHaveLength(44 + 16);
    const view = new DataView(wav.buffer, wav.byteOffset);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(16384); // left 0.5
    expect(view.getInt16(56, true)).toBe(32767); // left 1.0
    expect(view.getInt16(58, true)).toBe(-32767); // right -1.0
  });
});

describe('rendering', () => {
  it('renders a song to stereo audio of about the right length', async () => {
    const song = songWith([{ row: 0, ch: 0, note: C4, instrument: 5 }]);
    song.patterns[0].rows.length = 8;
    const { left, right, sampleRate } = await renderSong(song, { tail: 0.2 });
    expect(sampleRate).toBe(DSP_RATE);
    expect(left.length).toBe(right.length);
    // Eight rows of six ticks at 125 BPM, plus the tail.
    const seconds = (8 * song.speed * 2.5) / song.bpm + 0.2;
    expect(left.length / sampleRate).toBeCloseTo(seconds, 1);
    expect(peak(left)).toBeGreaterThan(0.01);
  });

  it('plays the song twice when asked for two loops', async () => {
    const song = songWith([{ row: 0, ch: 0, note: C4, instrument: 5 }]);
    song.patterns[0].rows.length = 8;
    const one = await renderSong(song, { tail: 0 });
    const two = await renderSong(song, { tail: 0, loops: 2 });
    expect(two.left.length / one.left.length).toBeCloseTo(2, 1);
  });

  it('renders at another sample rate without changing the pitch', async () => {
    const song = songWith([{ row: 0, ch: 0, note: C4 + 12, instrument: 5 }]);
    const { left, sampleRate } = await renderSong(song, { tail: 0, maxSeconds: 1 });
    const at44k = await renderSong(song, { tail: 0, maxSeconds: 1, sampleRate: 44100 });
    expect(at44k.sampleRate).toBe(44100);
    expect(frequency(left.subarray(4000), sampleRate)).toBeCloseTo(noteFrequency(C4 + 12), -1);
    expect(frequency(at44k.left.subarray(6000), 44100)).toBeCloseTo(noteFrequency(C4 + 12), -1);
  });

  it('stops after maxSeconds', async () => {
    const { left, sampleRate } = await renderSong(demoSong(), { tail: 0, maxSeconds: 2 });
    expect(left.length / sampleRate).toBeLessThanOrEqual(2.05);
  });

  it('reports its progress', async () => {
    const seen: number[] = [];
    await renderSong(demoSong(), { tail: 0, maxSeconds: 8, onProgress: (s) => seen.push(s) });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.at(-1)!).toBeGreaterThan(0);
  });

  it('renders one stem per voice, and the stems add up to the mix', async () => {
    const song = songWith([
      { row: 0, ch: 0, note: C4, instrument: 5 },
      { row: 0, ch: 3, note: C4 + 7, instrument: 5 },
    ]);
    // Quiet enough that the main mix never clips: then the stems really add up.
    song.instruments[5].volume = 0x30;
    song.patterns[0].rows.length = 4;
    const stems = await renderStems(song, { tail: 0 });
    expect(stems).toHaveLength(8);
    expect(peak(stems[0].left)).toBeGreaterThan(0.01);
    expect(peak(stems[3].left)).toBeGreaterThan(0.01);
    expect(peak(stems[1].left)).toBe(0);
    const mix = await renderSong(song, { tail: 0 });
    const n = Math.min(mix.left.length, ...stems.map((s) => s.left.length));
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const sum = stems.reduce((a, s) => a + s.left[i], 0);
      worst = Math.max(worst, Math.abs(sum - mix.left[i]));
    }
    expect(worst).toBeLessThan(0.02);
  });
});

describe('the audio engine', () => {
  it('keeps the pitch when it resamples to another rate', () => {
    const song = songWith([{ row: 0, ch: 0, note: C4, instrument: 5 }]);
    const native = new Engine(song);
    native.play();
    expect(frequency(renderLeft(native, 16000).slice(4000), DSP_RATE)).toBeCloseTo(noteFrequency(C4), -1);

    const engine = new Engine(song, 48000);
    engine.play();
    const left = new Float32Array(24000);
    const right = new Float32Array(24000);
    engine.render(left, right, 24000);
    expect(frequency(left.subarray(6000), 48000)).toBeCloseTo(noteFrequency(C4), -1);
  });

  it('renders silence before play and stops on stop', () => {
    const engine = new Engine(songWith([{ row: 0, ch: 0, note: C4, instrument: 5 }]));
    expect(peak(renderLeft(engine, 2000))).toBe(0);
    engine.play();
    expect(peak(renderLeft(engine, 4000))).toBeGreaterThan(0);
    engine.stop();
    renderLeft(engine, 4000); // the voices fade out
    expect(peak(renderLeft(engine, 4000))).toBe(0);
  });
});

describe('the song format', () => {
  it('reads back what it wrote', () => {
    const song = demoSong();
    const back = parseSong(JSON.parse(JSON.stringify(song)));
    expect(back.title).toBe('Demo');
    expect(back.patterns).toHaveLength(song.patterns.length);
    expect(back.order).toEqual(song.order);
    expect(back.samples.map((s) => s.name)).toEqual(song.samples.map((s) => s.name));
    expect(back.patterns[0].rows[0][1]).toEqual(song.patterns[0].rows[0][1]);
  });

  it('fills in what a file is missing instead of throwing', () => {
    const bare = parseSong({ version: 1, title: 'Bare', patterns: [], order: [] });
    expect(bare.patterns.length).toBeGreaterThan(0);
    expect(bare.order.length).toBeGreaterThan(0);
    expect(bare.instruments).toHaveLength(createSong().instruments.length);
    expect(bare.bpm).toBeGreaterThan(0);
    expect(bare.echo.fir).toHaveLength(8);
  });

  it('refuses something that is not a song', () => {
    expect(() => parseSong(null)).toThrow();
    expect(() => parseSong(42)).toThrow();
  });
});
