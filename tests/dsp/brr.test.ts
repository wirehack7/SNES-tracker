import { describe, expect, it } from 'vitest';
import { BRR_BLOCK_BYTES, BRR_END, BRR_LOOP, brrBlocks, decodeBrr, encodeBrr } from '../../src/dsp/brr';
import { GAUSS } from '../../src/dsp/gauss';

/** Mean error per sample between two signals. */
const error = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

const sine = (n: number, period: number, amp = 20000) =>
  Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * i) / period)));

describe('BRR', () => {
  it('decodes a block the way the hardware does', () => {
    // Shift 12, filter 0: each nibble is the sample shifted left by 11 (and doubled).
    const data = new Uint8Array(BRR_BLOCK_BYTES * 2);
    data[0] = (12 << 4) | 0;
    data[1] = 0x10; // nibbles 1 and 0
    data[9] = (0 << 4) | BRR_END;
    const pcm = decodeBrr(data);
    expect(pcm).toHaveLength(16);
    expect(pcm[0]).toBe(((1 << 12) >> 1) * 2);
    expect(pcm[1]).toBe(0);
  });

  it('clamps shifts above 12 as the DSP does', () => {
    const data = new Uint8Array(BRR_BLOCK_BYTES * 2);
    data[0] = (13 << 4) | 0;
    data[1] = 0x80; // nibble 8 = -8
    data[9] = BRR_END;
    expect(decodeBrr(data)[0]).toBe(-4096);
  });

  it('stops at the end flag and leaves the silent end block out', () => {
    const data = new Uint8Array(BRR_BLOCK_BYTES * 3);
    data[0] = 12 << 4;
    data[BRR_BLOCK_BYTES] = 12 << 4;
    data[BRR_BLOCK_BYTES * 2] = BRR_END; // end without loop: not played
    expect(decodeBrr(data)).toHaveLength(32);
  });

  it('follows the loop as often as asked', () => {
    const pcm = encodeBrr(sine(64, 32), { loopBlock: 1 });
    const once = decodeBrr(pcm, { loopBlock: 1 });
    const twice = decodeBrr(pcm, { loopBlock: 1, loops: 1 });
    expect(once).toHaveLength(64);
    // One more pass through blocks 1..3.
    expect(twice).toHaveLength(64 + 48);
  });

  it('encodes and decodes a sine wave closely', () => {
    const pcm = sine(256, 40);
    const brr = encodeBrr(pcm);
    expect(brrBlocks(brr)).toBe(256 / 16 + 1); // plus the silent end block
    const back = decodeBrr(brr);
    expect(back).toHaveLength(256);
    // BRR keeps about 10 bits: well under 1 % of full scale.
    expect(error(back, pcm)).toBeLessThan(300);
  });

  it('marks the loop block and the end, and makes one-shots end silently', () => {
    const looped = encodeBrr(sine(64, 16), { loopBlock: 2 });
    expect(looped).toHaveLength(4 * BRR_BLOCK_BYTES);
    // Only the last block is marked: it ends the sample and loops back.
    expect(looped[0] & 3).toBe(0);
    expect(looped[3 * BRR_BLOCK_BYTES] & 3).toBe(BRR_LOOP | BRR_END);

    const shot = encodeBrr(sine(32, 16));
    expect(brrBlocks(shot)).toBe(3);
    const last = 2 * BRR_BLOCK_BYTES;
    expect(shot[last] & 3).toBe(BRR_END);
    expect(Array.from(shot.subarray(last + 1, last + 9))).toEqual(Array(8).fill(0));
  });

  it('starts the loop block with filter 0, so a loop never drifts', () => {
    const brr = encodeBrr(sine(64, 23), { loopBlock: 2 });
    expect(brr[0] & 0x0c).toBe(0); // first block
    expect(brr[2 * BRR_BLOCK_BYTES] & 0x0c).toBe(0); // loop block
  });

  it('encodes silence as silence', () => {
    const brr = encodeBrr(new Array(32).fill(0));
    expect(Array.from(decodeBrr(brr))).toEqual(new Array(32).fill(0));
  });
});

describe('Gaussian interpolation table', () => {
  it('has 512 entries that rise to its end, the centre tap', () => {
    expect(GAUSS).toHaveLength(512);
    expect(GAUSS[0]).toBe(0);
    expect(GAUSS[511]).toBe(1305);
    for (let i = 1; i < 512; i++) expect(GAUSS[i], `entry ${i}`).toBeGreaterThanOrEqual(GAUSS[i - 1]);
  });

  it('every position sums to about one (2048 in 11-bit fixed point)', () => {
    for (let p = 0; p < 256; p++) {
      const sum = GAUSS[255 - p] + GAUSS[511 - p] + GAUSS[256 + p] + GAUSS[p];
      expect(sum, `position ${p}`).toBeGreaterThanOrEqual(2047);
      expect(sum, `position ${p}`).toBeLessThanOrEqual(2049);
    }
  });
});
