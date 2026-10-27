/**
 * Sample creation: single-cycle waveforms (shapes, harmonics or drawn by
 * hand) and synthesized drums, encoded to BRR. Also the sample operations
 * that need the audio itself (normalise, reverse, halve the rate).
 */
import { noteFrequency } from './notes';
import { Sample, decodeSample, sampleFromPcm } from './sample';

export const C4_HZ = noteFrequency(48);
const TAU = Math.PI * 2;

export type WaveShape = 'square' | 'saw' | 'triangle' | 'sine' | 'harmonics' | 'drawn';
export const WAVE_SHAPES: readonly WaveShape[] = ['square', 'saw', 'triangle', 'sine', 'harmonics', 'drawn'];
/** Cycle lengths: longer cycles tune finer at low notes, shorter ones reach higher notes. */
export const CYCLE_LENGTHS = [16, 32, 64, 128, 256] as const;

export interface WaveParams {
  shape: WaveShape;
  /** Samples per cycle (a multiple of 16, one BRR block). */
  length: number;
  /** Square: high part of the cycle, 1..99 %. */
  duty: number;
  /** Harmonics: amplitude 0..1 of harmonics 1..16. */
  harmonics: number[];
  /** Drawn: points, -1..1, stretched over the cycle. */
  points: number[];
  /** Peak level 0..1 */
  volume: number;
}

export function defaultWaveParams(): WaveParams {
  return {
    shape: 'square',
    length: 32,
    duty: 50,
    harmonics: [1, 0.5, 0.33, 0.25, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    points: Array.from({ length: 32 }, (_, i) => Math.sin((i / 32) * TAU)),
    volume: 0.75,
  };
}

/** One cycle of the waveform, -1..1. */
export function waveCycle(p: WaveParams): number[] {
  const n = p.length;
  const raw = Array.from({ length: n }, (_, i) => {
    const ph = i / n;
    switch (p.shape) {
      case 'square':
        return ph < p.duty / 100 ? 1 : -1;
      case 'saw':
        return 1 - 2 * ph;
      case 'triangle':
        return ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
      case 'sine':
        return Math.sin(TAU * ph);
      case 'harmonics':
        return p.harmonics.reduce((s, a, h) => s + a * Math.sin(TAU * (h + 1) * ph), 0);
      case 'drawn': {
        const pts = p.points.length ? p.points : [0];
        return pts[Math.min(pts.length - 1, Math.floor(ph * pts.length))];
      }
    }
  });
  // Remove DC (drawn shapes, odd duty cycles) and scale to the peak.
  const mean = raw.reduce((a, b) => a + b, 0) / n;
  const centred = p.shape === 'square' || p.shape === 'drawn' ? raw.map((v) => v - mean) : raw;
  const peak = Math.max(1e-9, ...centred.map(Math.abs));
  return centred.map((v) => (v / peak) * p.volume);
}

/** A looped single-cycle sample, tuned so C-4 plays at C-4. */
export function waveSample(name: string, p: WaveParams): Sample {
  const length = Math.max(16, Math.round(p.length / 16) * 16);
  const cycle = waveCycle({ ...p, length });
  return sampleFromPcm(name, cycle.map((v) => Math.round(v * 32767)), length * C4_HZ, 0);
}

export type DrumKind = 'kick' | 'snare' | 'hihat' | 'tom' | 'clap' | 'cymbal';
export const DRUM_KINDS: readonly DrumKind[] = ['kick', 'snare', 'hihat', 'tom', 'clap', 'cymbal'];

export interface DrumParams {
  kind: DrumKind;
  /** Base pitch in Hz (kick, tom, snare body). */
  pitch: number;
  /** Decay time in seconds. */
  decay: number;
  /** 0..1 noise in the mix. */
  noise: number;
  /** Rate of the sample in Hz (lower = smaller and grittier). */
  rate: number;
}

export function defaultDrum(kind: DrumKind): DrumParams {
  const d: Record<DrumKind, Omit<DrumParams, 'kind'>> = {
    kick: { pitch: 50, decay: 0.35, noise: 0.05, rate: 16000 },
    snare: { pitch: 190, decay: 0.22, noise: 0.7, rate: 16000 },
    hihat: { pitch: 8000, decay: 0.07, noise: 1, rate: 32000 },
    tom: { pitch: 110, decay: 0.4, noise: 0.1, rate: 16000 },
    clap: { pitch: 1200, decay: 0.2, noise: 1, rate: 16000 },
    cymbal: { pitch: 6000, decay: 1.2, noise: 1, rate: 32000 },
  };
  return { kind, ...d[kind] };
}

/** A deterministic noise source, so the same parameters always make the same sample. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

/** Synthesized drum, a one-shot sample that plays at its own rate on C-4. */
export function drumSample(name: string, p: DrumParams): Sample {
  const rate = p.rate;
  const seconds = Math.min(2.5, p.decay * 4 + 0.02);
  const n = Math.round(rate * seconds);
  const noise = rng(0x5eed + p.kind.length);
  const k = 1 / Math.max(0.005, p.decay);
  let hp = 0;
  let lastNoise = 0;
  let phase = 0;
  const pcm: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.exp(-t * k * 2.3);
    const nz = noise();
    let v = 0;
    switch (p.kind) {
      case 'kick':
      case 'tom': {
        const sweep = p.kind === 'kick' ? 3 : 0.8;
        const f = p.pitch * (1 + sweep * Math.exp(-t * 35));
        phase += (TAU * f) / rate;
        v = Math.sin(phase) * env * (1 - p.noise) + nz * p.noise * Math.exp(-t * 60);
        break;
      }
      case 'snare': {
        phase += (TAU * p.pitch) / rate;
        v = Math.sin(phase) * Math.exp(-t * k * 4) * (1 - p.noise) + nz * env * p.noise;
        break;
      }
      case 'hihat':
      case 'cymbal': {
        // High-passed noise plus a few inharmonic square partials for the metallic ring.
        hp = nz - lastNoise;
        lastNoise = nz;
        let metal = 0;
        for (const r of [1, 1.342, 1.2312, 1.6532, 1.9523, 2.1523]) metal += Math.sign(Math.sin(TAU * p.pitch * 0.12 * r * t));
        v = (hp * p.noise + (metal / 6) * (1 - p.noise) * 0.5) * env;
        break;
      }
      case 'clap': {
        // Three quick bursts, then the tail.
        const burst = t < 0.03 ? Math.exp(-((t % 0.01) * 400)) : Math.exp(-(t - 0.03) * k * 2.3);
        hp = nz - lastNoise * 0.6;
        lastNoise = nz;
        v = hp * burst;
        break;
      }
    }
    pcm.push(v);
  }
  const peak = Math.max(1e-9, ...pcm.map(Math.abs));
  // A short fade-in avoids a click when the attack is not at zero.
  return sampleFromPcm(
    name,
    pcm.map((v, i) => Math.round((v / peak) * 0.92 * Math.min(1, i / 8) * 32767)),
    rate,
  );
}

// ------------------------------------------------------- sample operations

/** The decoded audio of a sample and where its loop starts (in samples). */
function audioOf(s: Sample): { pcm: number[]; loopStart: number } {
  return { pcm: Array.from(decodeSample(s)), loopStart: s.loop >= 0 ? s.loop * 16 : -1 };
}

/** Scale to just under full scale. */
export function normalizeSample(s: Sample): Sample {
  const { pcm, loopStart } = audioOf(s);
  const peak = Math.max(1, ...pcm.map(Math.abs));
  const g = 32000 / peak;
  return { ...sampleFromPcm(s.name, pcm.map((v) => v * g), s.rate, loopStart), rate: s.rate };
}

/** Play backwards (the loop is dropped). */
export function reverseSample(s: Sample): Sample {
  const { pcm } = audioOf(s);
  return sampleFromPcm(s.name, pcm.reverse(), s.rate);
}

/** Half the rate: half the memory, less treble. The tuning stays. */
export function halveSample(s: Sample): Sample {
  const { pcm, loopStart } = audioOf(s);
  const out: number[] = [];
  for (let i = 0; i + 1 < pcm.length; i += 2) out.push((pcm[i] + pcm[i + 1]) / 2);
  const loop = loopStart >= 0 ? Math.floor(loopStart / 32) * 16 : -1;
  return sampleFromPcm(s.name, out, s.rate / 2, loop);
}

/** Raise (positive) or lower the sample's tuning by semitones. */
export function retuneSample(s: Sample, semitones: number): Sample {
  return { ...s, rate: Math.max(1, Math.min(128000, Math.round(s.rate * Math.pow(2, -semitones / 12)))) };
}
