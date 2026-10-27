import { describe, expect, it } from 'vitest';
import { VOICE_COUNT } from '../../src/dsp/dsp';
import { scopeTrace } from '../../src/ui/scope';

/** Interleaved 8-voice buffer with `fn(i)` on voice `ch` and silence elsewhere. */
function buffer(frames: number, ch: number, fn: (i: number) => number): Float32Array {
  const data = new Float32Array(frames * VOICE_COUNT);
  for (let i = 0; i < frames; i++) data[i * VOICE_COUNT + ch] = fn(i);
  return data;
}

describe('voice scopes', () => {
  it('draws a silent voice as a flat line', () => {
    const trace = scopeTrace(buffer(600, 0, () => 0), 600, 3);
    expect(trace).toHaveLength(512);
    expect(Math.max(...trace.map(Math.abs))).toBe(0);
  });

  it('scales a quiet voice up so it stays visible', () => {
    const trace = scopeTrace(buffer(512, 1, (i) => (i % 32 < 16 ? 0.2 : -0.2)), 512, 1);
    expect(Math.max(...trace)).toBeCloseTo(0.6);
    expect(Math.min(...trace)).toBeCloseTo(-0.6);
  });

  it('shows the newest samples and clamps to the scope height', () => {
    const trace = scopeTrace(buffer(1000, 2, (i) => (i < 488 ? 0 : i % 2 ? 4 : -4)), 1000, 2);
    expect(trace).toHaveLength(512);
    expect(Math.max(...trace)).toBe(1);
    expect(Math.min(...trace)).toBe(-1);
  });

  it('reads each voice from its own slot', () => {
    for (const ch of [0, 4, VOICE_COUNT - 1]) {
      const trace = scopeTrace(buffer(64, ch, () => 0.1), 64, ch);
      expect(Math.min(...trace), `voice ${ch}`).toBeCloseTo(0.3);
      expect(Math.max(...scopeTrace(buffer(64, ch, () => 0.1), 64, (ch + 1) % VOICE_COUNT))).toBe(0);
    }
  });

  it('copes with an empty buffer', () => {
    expect(scopeTrace(new Float32Array(0), 0, 0)).toHaveLength(0);
  });
});
