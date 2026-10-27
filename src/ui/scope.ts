/** Oscilloscope traces for the channel header. */
import { VOICE_COUNT } from '../dsp/dsp';

/**
 * The last `max` samples of one voice from the interleaved scope buffer
 * (VOICE_COUNT values per frame), scaled up by `gain` and clamped to -1..1.
 */
export function scopeTrace(data: Float32Array, frames: number, ch: number, max = 512, gain = 3): Float32Array {
  const n = Math.min(frames, max);
  const start = frames - n;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, data[(start + i) * VOICE_COUNT + ch] * gain));
  return out;
}
