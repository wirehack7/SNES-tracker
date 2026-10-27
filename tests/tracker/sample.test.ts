import { describe, expect, it } from 'vitest';
import { BRR_BLOCK_BYTES, decodeBrr } from '../../src/dsp/brr';
import { C4, noteFrequency } from '../../src/tracker/notes';
import {
  MAX_IMPORT_SAMPLES,
  SAMPLE_COUNT,
  builtinSamples,
  decodeSample,
  fromBase64,
  resample,
  sampleBlocks,
  sampleBytes,
  sampleFromAudio,
  sampleFromPcm,
  setLoop,
  toBase64,
  toMono,
} from '../../src/tracker/sample';
import {
  CYCLE_LENGTHS,
  DRUM_KINDS,
  defaultDrum,
  defaultWaveParams,
  drumSample,
  halveSample,
  normalizeSample,
  retuneSample,
  reverseSample,
  waveCycle,
  waveSample,
} from '../../src/tracker/synth';
import { createSong, deleteSample } from '../../src/tracker/song';
import { frequency } from '../helpers';

const peak = (data: ArrayLike<number>) => {
  let p = 0;
  for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
  return p;
};

describe('samples', () => {
  it('round-trips through base64', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('counts its bytes and blocks', () => {
    const s = sampleFromPcm('x', new Array(64).fill(0), 16000);
    expect(sampleBytes(s)).toHaveLength(sampleBlocks(s) * BRR_BLOCK_BYTES);
    expect(sampleBlocks(s)).toBe(5); // four blocks plus the silent end block
  });

  it('moves the loop point to a block and keeps the audio', () => {
    const pcm = Array.from({ length: 128 }, (_, i) => Math.round(8000 * Math.sin(i / 3)));
    const one = sampleFromPcm('x', pcm, 16000);
    expect(one.loop).toBe(-1);
    const looped = setLoop(one, 2);
    expect(looped.loop).toBe(2);
    expect(decodeSample(looped)).toHaveLength(128);
    // Looping drops the silent end block, switching it off adds it again.
    expect(sampleBlocks(looped)).toBe(8);
    expect(sampleBlocks(setLoop(looped, -1))).toBe(9);
  });

  it('decodes extra passes through the loop', () => {
    const s = sampleFromPcm('x', new Array(64).fill(1000), 16000, 32);
    expect(decodeSample(s)).toHaveLength(64);
    expect(decodeSample(s, 2)).toHaveLength(64 + 2 * 32);
  });

  it('builds the built-in samples, all of them small enough to be useful', () => {
    const samples = builtinSamples();
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.length).toBeLessThanOrEqual(SAMPLE_COUNT);
    const total = samples.reduce((n, s) => n + sampleBytes(s).length, 0);
    expect(total).toBeLessThan(0x8000); // half of audio RAM
    for (const s of samples) expect(peak(decodeSample(s)), s.name).toBeGreaterThan(1000);
  });

  it('plays the built-in waveforms at the note they are written for', () => {
    for (const name of ['Square', 'Saw', 'Sine']) {
      const s = builtinSamples().find((x) => x.name === name)!;
      expect(s.loop, name).toBeGreaterThanOrEqual(0);
      const pcm = decodeSample(s, 8);
      expect(frequency(pcm, s.rate), name).toBeCloseTo(noteFrequency(C4), -1);
    }
  });

  it('deletes a sample and moves the instruments that used later ones', () => {
    const song = createSong();
    const second = song.samples[1].name;
    song.instruments[0].sample = 0;
    song.instruments[1].sample = 1;
    deleteSample(song, 0);
    expect(song.samples[0].name).toBe(second);
    expect(song.instruments[0].sample).toBe(-1);
    expect(song.instruments[1].sample).toBe(0);
  });
});

describe('importing audio', () => {
  const tone = (n: number, rate: number, hz: number) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

  it('mixes channels to mono', () => {
    const mono = toMono([Float32Array.from([1, 0, -1]), Float32Array.from([0, 0, 1])]);
    expect(Array.from(mono)).toEqual([0.5, 0, 0]);
  });

  it('resamples without changing the frequency', () => {
    const input = tone(16000, 32000, 440);
    const out = resample(input, 32000, 16000);
    expect(out.length).toBe(8000);
    expect(frequency(out, 16000)).toBeCloseTo(440, -1);
  });

  it('makes a sample at the chosen rate and keeps it short enough for audio RAM', () => {
    const s = sampleFromAudio('tone', [tone(44100, 44100, 440)], 44100, 16000);
    expect(s.rate).toBe(16000);
    expect(s.name).toBe('tone');
    const pcm = decodeSample(s);
    expect(pcm.length).toBeGreaterThan(15000);
    expect(frequency(pcm, 16000)).toBeCloseTo(440, -1);
  });

  it('cuts audio that is longer than the import limit', () => {
    const long = new Float32Array(32000 * 10).fill(0.5);
    const s = sampleFromAudio('long', [long], 32000, 32000);
    expect(decodeSample(s).length).toBeLessThanOrEqual(MAX_IMPORT_SAMPLES);
  });
});

describe('the waveform synth', () => {
  it('makes one cycle without a DC offset, at the chosen level', () => {
    for (const shape of ['square', 'saw', 'triangle', 'sine'] as const) {
      const cycle = waveCycle({ ...defaultWaveParams(), shape, length: 64, volume: 0.5 });
      expect(cycle, shape).toHaveLength(64);
      expect(Math.max(...cycle.map(Math.abs)), shape).toBeCloseTo(0.5, 5);
      const mean = cycle.reduce((a, b) => a + b, 0) / cycle.length;
      expect(Math.abs(mean), shape).toBeLessThan(0.1);
    }
  });

  it('follows the duty cycle of a square wave', () => {
    const cycle = waveCycle({ ...defaultWaveParams(), shape: 'square', length: 100, duty: 25 });
    expect(cycle.filter((v) => v > 0)).toHaveLength(25);
  });

  it('adds harmonics and draws points', () => {
    const harmonics = waveCycle({ ...defaultWaveParams(), shape: 'harmonics', length: 64, harmonics: [0, 1, ...Array(14).fill(0)] });
    // Only the second harmonic: two periods in one cycle.
    expect(frequency(harmonics, 64)).toBeCloseTo(2, 1);
    const drawn = waveCycle({ ...defaultWaveParams(), shape: 'drawn', length: 32, points: Array.from({ length: 32 }, (_, i) => (i < 16 ? 1 : -1)) });
    expect(drawn[0]).toBeGreaterThan(0);
    expect(drawn[20]).toBeLessThan(0);
  });

  it('tunes a single cycle so C-4 plays C-4, for every cycle length', () => {
    for (const length of CYCLE_LENGTHS) {
      const s = waveSample('w', { ...defaultWaveParams(), shape: 'sine', length });
      expect(s.loop, `length ${length}`).toBe(0);
      expect(s.rate, `length ${length}`).toBeCloseTo(length * noteFrequency(C4), 0);
      expect(frequency(decodeSample(s, 8), s.rate), `length ${length}`).toBeCloseTo(noteFrequency(C4), -1);
    }
  });
});

describe('the drum synth', () => {
  it('makes every kind as a one-shot that starts loud and dies away', () => {
    for (const kind of DRUM_KINDS) {
      const s = drumSample(kind, defaultDrum(kind));
      expect(s.loop, kind).toBe(-1);
      const pcm = decodeSample(s);
      expect(peak(pcm), kind).toBeGreaterThan(20000);
      const tail = pcm.subarray(Math.floor(pcm.length * 0.9));
      expect(peak(tail), kind).toBeLessThan(peak(pcm.subarray(0, 200)));
    }
  });

  it('makes the same sample from the same parameters', () => {
    const a = drumSample('kick', defaultDrum('kick'));
    const b = drumSample('kick', defaultDrum('kick'));
    expect(a.brr).toBe(b.brr);
  });

  it('starts at zero, so a note does not click', () => {
    for (const kind of DRUM_KINDS) expect(Math.abs(decodeSample(drumSample(kind, defaultDrum(kind)))[0]), kind).toBeLessThan(5000);
  });
});

describe('sample operations', () => {
  const quiet = sampleFromPcm('q', Array.from({ length: 256 }, (_, i) => Math.round(3000 * Math.sin(i / 5))), 16000, 64);

  it('normalizes to near full scale and keeps the loop', () => {
    const loud = normalizeSample(quiet);
    expect(peak(decodeSample(loud))).toBeGreaterThan(30000);
    expect(loud.loop).toBe(quiet.loop);
    expect(loud.rate).toBe(quiet.rate);
  });

  it('reverses the audio and drops the loop', () => {
    const back = reverseSample(quiet);
    expect(back.loop).toBe(-1);
    const a = decodeSample(quiet);
    const b = decodeSample(back);
    expect(b[0]).toBeCloseTo(a[a.length - 1], -2);
  });

  it('halves the rate, the memory and the loop point', () => {
    const half = halveSample(quiet);
    expect(half.rate).toBe(quiet.rate / 2);
    expect(sampleBytes(half).length).toBeLessThan(sampleBytes(quiet).length * 0.6);
    expect(half.loop).toBe(quiet.loop / 2);
  });

  it('retunes by semitones without touching the audio', () => {
    const up = retuneSample(quiet, 12);
    expect(up.rate).toBe(Math.round(quiet.rate / 2));
    expect(up.brr).toBe(quiet.brr);
    expect(retuneSample(quiet, -12).rate).toBe(quiet.rate * 2);
  });
});

it('decodes what it encodes, whatever the loop', () => {
  const pcm = Array.from({ length: 160 }, (_, i) => Math.round(10000 * Math.sin(i / 4)));
  for (const loop of [-1, 0, 32, 144]) {
    const s = sampleFromPcm('x', pcm, 32000, loop);
    const back = decodeBrr(sampleBytes(s), { loopBlock: Math.max(0, s.loop) });
    expect(back.length, `loop ${loop}`).toBe(160);
  }
});
