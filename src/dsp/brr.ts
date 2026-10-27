/**
 * BRR (bit rate reduction), the S-DSP's sample format: blocks of 9 bytes, a
 * header (shift, filter, loop and end flags) and 16 four-bit samples. The
 * decoder is bit exact with the DSP's; the encoder tries every filter and
 * shift for each block against that decoder and keeps the closest result.
 */

export const BRR_BLOCK_BYTES = 9;
export const BRR_BLOCK_SAMPLES = 16;
export const BRR_END = 0x01;
export const BRR_LOOP = 0x02;

const clamp16 = (v: number) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const s16 = (v: number) => (v << 16) >> 16;

/** The filter part of a prediction (added to the scaled nibble), exactly as the DSP computes it. */
function predict(filter: number, p1: number, p2raw: number): number {
  const p2 = p2raw >> 1;
  switch (filter) {
    case 1:
      return (p1 >> 1) + (-p1 >> 5);
    case 2:
      return p1 - p2 + (p2 >> 4) + ((p1 * -3) >> 6);
    case 3:
      return p1 - p2 + ((p1 * -13) >> 7) + ((p2 * 3) >> 4);
    default:
      return 0;
  }
}

/** One decoded sample: the 16-bit value the DSP keeps in its buffer. */
function decodeNibble(nibble: number, shift: number, filter: number, p1: number, p2: number): number {
  let s = (nibble << 28) >> 28;
  s = (s << shift) >> 1;
  if (shift >= 0xd) s = s < 0 ? -2048 : 0;
  s += predict(filter, p1, p2);
  return s16(clamp16(s) * 2);
}

export interface DecodeOptions {
  /** Follow the loop this many times (the loop start comes from `loopBlock`). */
  loops?: number;
  /** Block the loop jumps to (normally from the sample directory). */
  loopBlock?: number;
}

/**
 * Decode BRR data to 16-bit samples. Decoding stops at the end flag (a block
 * with only the end flag is not played by the DSP and is left out).
 */
export function decodeBrr(data: Uint8Array, opts: DecodeOptions = {}): Int16Array {
  const out: number[] = [];
  let p1 = 0;
  let p2 = 0;
  let loops = opts.loops ?? 0;
  const blocks = Math.floor(data.length / BRR_BLOCK_BYTES);
  for (let b = 0; b < blocks; b++) {
    const o = b * BRR_BLOCK_BYTES;
    const header = data[o];
    if ((header & 3) === BRR_END) break;
    const shift = header >> 4;
    const filter = (header >> 2) & 3;
    for (let i = 0; i < 8; i++) {
      const byte = data[o + 1 + i];
      for (const nibble of [byte >> 4, byte & 15]) {
        const s = decodeNibble(nibble, shift, filter, p1, p2);
        out.push(s);
        p2 = p1;
        p1 = s;
      }
    }
    if (header & BRR_END) {
      if (loops-- <= 0) break;
      b = (opts.loopBlock ?? 0) - 1;
    }
  }
  return Int16Array.from(out);
}

export interface EncodeOptions {
  /** Block index the sample loops back to, or -1 for a one-shot sample. */
  loopBlock?: number;
}

/**
 * Encode 16-bit samples (length padded to whole blocks with silence) to BRR.
 * The first block and the loop block use filter 0, so they decode the same
 * whatever played before. A one-shot sample gets a silent end block, as the
 * DSP mutes a voice as soon as it starts decoding a block with the end flag.
 */
export function encodeBrr(pcm: ArrayLike<number>, opts: EncodeOptions = {}): Uint8Array {
  const loopBlock = opts.loopBlock ?? -1;
  const blocks = Math.max(1, Math.ceil(pcm.length / BRR_BLOCK_SAMPLES));
  const total = loopBlock >= 0 ? blocks : blocks + 1;
  const out = new Uint8Array(total * BRR_BLOCK_BYTES);
  let p1 = 0;
  let p2 = 0;
  const target = new Int32Array(BRR_BLOCK_SAMPLES);
  const nibbles = new Uint8Array(BRR_BLOCK_SAMPLES);
  const best = new Uint8Array(BRR_BLOCK_SAMPLES);
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < BRR_BLOCK_SAMPLES; i++) {
      const x = pcm[b * BRR_BLOCK_SAMPLES + i] ?? 0;
      // The DSP keeps 15 significant bits.
      target[i] = Math.max(-32768, Math.min(32766, Math.round(x))) & ~1;
    }
    const filters = b === 0 || b === loopBlock ? [0] : [0, 1, 2, 3];
    let bestErr = Infinity;
    let bestHeader = 0;
    let bestP1 = 0;
    let bestP2 = 0;
    for (const filter of filters) {
      for (let shift = 0; shift <= 12; shift++) {
        let q1 = p1;
        let q2 = p2;
        let err = 0;
        for (let i = 0; i < BRR_BLOCK_SAMPLES && err < bestErr; i++) {
          const want = target[i];
          const pred = predict(filter, q1, q2);
          // Nibble that gets closest: s * 2^shift / 2 + pred ≈ want / 2
          const scale = shift === 0 ? 0.5 : 1 << (shift - 1);
          let n = Math.round((want / 2 - pred) / scale);
          n = Math.max(-8, Math.min(7, n));
          // Rounding can overshoot into the clamp or the wrap; check the neighbours too.
          let chosen = n;
          let chosenVal = decodeNibble(n & 15, shift, filter, q1, q2);
          let chosenErr = Math.abs(chosenVal - want);
          for (const m of [n - 1, n + 1]) {
            if (m < -8 || m > 7) continue;
            const v = decodeNibble(m & 15, shift, filter, q1, q2);
            const e = Math.abs(v - want);
            if (e < chosenErr) {
              chosen = m;
              chosenVal = v;
              chosenErr = e;
            }
          }
          nibbles[i] = chosen & 15;
          err += chosenErr * chosenErr;
          q2 = q1;
          q1 = chosenVal;
        }
        if (err < bestErr) {
          bestErr = err;
          bestHeader = (shift << 4) | (filter << 2);
          bestP1 = q1;
          bestP2 = q2;
          best.set(nibbles);
        }
      }
    }
    const o = b * BRR_BLOCK_BYTES;
    let header = bestHeader;
    if (b === blocks - 1 && loopBlock >= 0) header |= BRR_END | BRR_LOOP;
    out[o] = header;
    for (let i = 0; i < 8; i++) out[o + 1 + i] = (best[i * 2] << 4) | best[i * 2 + 1];
    p1 = bestP1;
    p2 = bestP2;
  }
  if (loopBlock < 0) out[blocks * BRR_BLOCK_BYTES] = BRR_END;
  return out;
}

/** Number of blocks in BRR data. */
export const brrBlocks = (data: Uint8Array) => Math.floor(data.length / BRR_BLOCK_BYTES);
