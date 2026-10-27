/**
 * Samples: BRR data as stored in the song (base64), their loop point and
 * tuning, the built-in instrument set, and conversion from recorded audio.
 */
import { BRR_BLOCK_BYTES, BRR_BLOCK_SAMPLES, BRR_END, BRR_LOOP, decodeBrr, encodeBrr } from '../dsp/brr';
import { noteFrequency } from './notes';

/** At most 63 samples: the 64th directory entry is the silent sample. */
export const SAMPLE_COUNT = 63;

export interface Sample {
  name: string;
  /** BRR data, base64. */
  brr: string;
  /** Block the sample loops back to, or -1 for a one-shot sample. */
  loop: number;
  /** Rate in Hz at which C-4 plays the sample (its recording rate, or cycle length × the frequency of C-4). */
  rate: number;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INDEX[B64.charCodeAt(i)] = i;

// Base64 by hand: the audio worklet decodes the samples, and AudioWorkletGlobalScope has no atob/btoa.
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[n >> 18] + B64[(n >> 12) & 63];
    s += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    s += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return s;
}

/** Decodes base64; anything that is not base64 gives an empty result. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]+$/, '').replace(/\s+/g, '');
  if (clean.length % 4 === 1) return new Uint8Array(0);
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) return new Uint8Array(0);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** The sample's BRR bytes, whole blocks only. */
export function sampleBytes(s: Sample): Uint8Array {
  const b = fromBase64(s.brr);
  return b.subarray(0, b.length - (b.length % BRR_BLOCK_BYTES));
}

export function sampleBlocks(s: Sample): number {
  return sampleBytes(s).length / BRR_BLOCK_BYTES;
}

/** Decoded 16-bit audio of the sample (the loop once), for drawing and tests. */
export function decodeSample(s: Sample, loops = 0): Int16Array {
  return decodeBrr(sampleBytes(s), { loops, loopBlock: Math.max(0, s.loop) });
}

const isSilentEnd = (b: Uint8Array, o: number) =>
  (b[o] & 3) === BRR_END && b.subarray(o + 1, o + BRR_BLOCK_BYTES).every((x) => x === 0);

/**
 * Turns the loop on (at `block`) or off (-1). Only the flags change: a looped
 * sample ends with an end+loop block, a one-shot sample with a silent end
 * block (added or removed as needed).
 */
export function setLoop(s: Sample, block: number): Sample {
  let b = sampleBytes(s).slice();
  let blocks = b.length / BRR_BLOCK_BYTES;
  if (!blocks) return s;
  const silentEnd = blocks > 1 && isSilentEnd(b, (blocks - 1) * BRR_BLOCK_BYTES);
  // Strip end/loop flags everywhere; they are set again below.
  for (let i = 0; i < blocks; i++) b[i * BRR_BLOCK_BYTES] &= ~(BRR_END | BRR_LOOP);
  if (block >= 0) {
    if (silentEnd) {
      b = b.slice(0, (blocks - 1) * BRR_BLOCK_BYTES);
      blocks--;
    }
    b[(blocks - 1) * BRR_BLOCK_BYTES] |= BRR_END | BRR_LOOP;
    return { ...s, brr: toBase64(b), loop: Math.max(0, Math.min(blocks - 1, block)) };
  }
  if (silentEnd) b[(blocks - 1) * BRR_BLOCK_BYTES] |= BRR_END;
  else {
    const next = new Uint8Array(b.length + BRR_BLOCK_BYTES);
    next.set(b);
    next[b.length] = BRR_END;
    b = next;
  }
  return { ...s, brr: toBase64(b), loop: -1 };
}

/** A sample from 16-bit PCM at `rate` Hz; `loopStart` (in samples) is rounded down to a block. */
export function sampleFromPcm(name: string, pcm: ArrayLike<number>, rate: number, loopStart = -1): Sample {
  const loopBlock = loopStart >= 0 ? Math.floor(loopStart / BRR_BLOCK_SAMPLES) : -1;
  return { name, brr: toBase64(encodeBrr(pcm, { loopBlock })), loop: loopBlock, rate: Math.round(rate) };
}

// ------------------------------------------------------------- built-ins

const C4_HZ = noteFrequency(48);

/** One cycle of `n` samples from a function of the phase (0..1) returning -1..1. */
function cycle(n: number, fn: (phase: number) => number, amp = 0.75): number[] {
  return Array.from({ length: n }, (_, i) => Math.round(fn(i / n) * amp * 32767));
}

function waveform(name: string, n: number, fn: (phase: number) => number, amp?: number): Sample {
  return sampleFromPcm(name, cycle(n, fn, amp), n * C4_HZ, 0);
}

/** A deterministic noise source, so the built-in drums are the same everywhere. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

function oneShot(name: string, rate: number, seconds: number, fn: (t: number, i: number) => number): Sample {
  const n = Math.round(rate * seconds);
  const pcm = Array.from({ length: n }, (_, i) => Math.round(Math.max(-1, Math.min(1, fn(i / rate, i))) * 30000));
  return sampleFromPcm(name, pcm, rate);
}

const TAU = Math.PI * 2;

/** The sample set new songs start with. */
export function builtinSamples(): Sample[] {
  const noise = rng(0x5eed);
  const hat = rng(0xbeef);
  const snare = rng(0xcafe);
  let lp = 0;
  return [
    waveform('Square', 32, (p) => (p < 0.5 ? 1 : -1), 0.6),
    waveform('Pulse 25%', 32, (p) => (p < 0.25 ? 1 : -1), 0.6),
    waveform('Pulse 12.5%', 32, (p) => (p < 0.125 ? 1 : -1), 0.6),
    waveform('Saw', 32, (p) => 1 - 2 * p, 0.7),
    waveform('Triangle', 32, (p) => (p < 0.5 ? 4 * p - 1 : 3 - 4 * p), 0.9),
    waveform('Sine', 32, (p) => Math.sin(TAU * p), 0.9),
    waveform('Organ', 64, (p) => (Math.sin(TAU * p) + 0.5 * Math.sin(TAU * 2 * p) + 0.33 * Math.sin(TAU * 4 * p)) / 1.6, 0.9),
    waveform('Bass', 64, (p) => {
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(TAU * h * p) / h / (1 + h * 0.4);
      return v;
    }, 0.95),
    // Strings: two saws a cycle apart over a 512-sample loop for a chorus beat.
    sampleFromPcm(
      'Strings',
      cycle(512, (p) => {
        let v = 0;
        for (let h = 1; h <= 10; h++) v += (Math.sin(TAU * h * 16 * p) + Math.sin(TAU * h * 17 * p)) / h;
        return v / 3.2;
      }, 0.8),
      (512 / 16.5) * C4_HZ,
      0,
    ),
    oneShot('Piano', 16000, 1.2, (t) => {
      const f = C4_HZ;
      let v = 0;
      for (let h = 1; h <= 6; h++) v += (Math.sin(TAU * f * h * t * (1 + h * 0.0008)) * Math.exp(-t * (2 + h * 1.5))) / h;
      return v * 0.8 * Math.min(1, t * 400);
    }),
    oneShot('Kick', 16000, 0.35, (t) => {
      const f = 45 + 120 * Math.exp(-t * 30);
      return Math.sin(TAU * f * t + 4 * (1 - Math.exp(-t * 30)) / 30) * Math.exp(-t * 9) * 1.1;
    }),
    oneShot('Snare', 16000, 0.3, (t) => {
      const tone = Math.sin(TAU * 185 * t) * Math.exp(-t * 25);
      return (snare() * Math.exp(-t * 14) * 0.7 + tone * 0.6) * 1.1;
    }),
    oneShot('Hi-hat', 16000, 0.12, (t) => {
      const n = hat();
      const v = n - lp;
      lp = n;
      return v * 0.6 * Math.exp(-t * 40);
    }),
    oneShot('Crash', 16000, 1.0, (t) => noise() * 0.6 * Math.exp(-t * 3.5) * Math.min(1, t * 2000)),
  ];
}

// --------------------------------------------------------------- import

/** Mix channels down to mono. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
}

/** Resample with linear interpolation after a simple box low-pass when shrinking. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input.slice();
  const ratio = from / to;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  const width = Math.max(1, Math.round(ratio));
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    let sum = 0;
    for (let k = 0; k < width; k++) {
      const p = x + k - (width - 1) / 2;
      const i0 = Math.max(0, Math.min(input.length - 1, Math.floor(p)));
      const i1 = Math.min(input.length - 1, i0 + 1);
      const f = p - Math.floor(p);
      sum += input[i0] * (1 - f) + input[i1] * f;
    }
    out[i] = sum / width;
  }
  return out;
}

/** Longest imported sample in samples (about 54 KiB of BRR; audio RAM is 64 KiB). */
export const MAX_IMPORT_SAMPLES = 96000;

/**
 * Converts decoded audio to a sample at `rate` Hz (32000, 16000 or 8000 are
 * typical): normalised to just under full scale, trimmed of trailing silence.
 */
export function sampleFromAudio(name: string, channels: Float32Array[], sourceRate: number, rate = 16000): Sample {
  const mono = resample(toMono(channels), sourceRate, rate);
  let end = mono.length;
  while (end > 1 && Math.abs(mono[end - 1]) < 1e-3) end--;
  const length = Math.min(end, MAX_IMPORT_SAMPLES);
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  const gain = peak > 0 ? 0.95 / peak : 1;
  const pcm = Array.from({ length }, (_, i) => Math.round(mono[i] * gain * 32767));
  return sampleFromPcm(name, pcm, rate);
}
