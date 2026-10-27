/**
 * Audio RAM layout of a song, shared by the tracker's playback and the SPC
 * export, so both play from the same addresses:
 *
 *   $0000-$01FF  zero page and stack of the SPC700
 *   $0200-$03FF  sound driver (SPC export)
 *   $0400-$04FF  sample directory (DIR = $04): start and loop address per sample
 *   $0500-       a silent looping block, then the samples' BRR data
 *   ...          song data (SPC export)
 *   ESA-$FFFF    echo buffer, EDL × 2 KiB at the top (one page when EDL is 0)
 */
import { BRR_BLOCK_BYTES, BRR_END, BRR_LOOP } from '../dsp/brr';
import { Song } from './song';
import { SAMPLE_COUNT, sampleBytes } from './sample';

export const DRIVER_ADDR = 0x0200;
export const DIR_ADDR = 0x0400;
export const DIR_PAGE = DIR_ADDR >> 8;
export const SAMPLES_ADDR = 0x0500;
/** DIR entry of the silent sample (used by instruments without a sample, and by noise voices). */
export const SILENT_SRCN = SAMPLE_COUNT;

export interface AramLayout {
  /** DIR and BRR data, to be copied to `SAMPLES_ADDR - 0x100` (= DIR_ADDR). */
  image: Uint8Array;
  /** First free byte after the samples. */
  end: number;
  /** Echo buffer start page (ESA register). */
  esa: number;
  /** First byte of the echo buffer. */
  echoStart: number;
  /** Bytes between the samples and the echo buffer (negative: they overlap). */
  free: number;
  /** Start address of each sample. */
  starts: number[];
}

/** Echo buffer start for an EDL value: EDL × 2 KiB below the top, one page when EDL is 0. */
export function echoStart(delay: number): number {
  return delay ? 0x10000 - delay * 0x800 : 0xff00;
}

export function layoutAram(song: Song): AramLayout {
  const parts: Uint8Array[] = [];
  const dir = new Uint8Array(0x100);
  let addr = SAMPLES_ADDR;
  const entry = (srcn: number, start: number, loop: number) => {
    dir[srcn * 4] = start & 0xff;
    dir[srcn * 4 + 1] = start >> 8;
    dir[srcn * 4 + 2] = loop & 0xff;
    dir[srcn * 4 + 3] = loop >> 8;
  };
  // Silent looping block: also the fallback for every unused directory entry.
  const silent = new Uint8Array(BRR_BLOCK_BYTES);
  silent[0] = BRR_END | BRR_LOOP;
  parts.push(silent);
  const silentAddr = addr;
  addr += BRR_BLOCK_BYTES;
  for (let i = 0; i < 64; i++) entry(i, silentAddr, silentAddr);
  const starts: number[] = [];
  song.samples.forEach((s, i) => {
    const data = sampleBytes(s);
    if (!data.length || i >= SAMPLE_COUNT) {
      starts.push(silentAddr);
      return;
    }
    const loop = s.loop >= 0 ? addr + Math.min(s.loop, data.length / BRR_BLOCK_BYTES - 1) * BRR_BLOCK_BYTES : addr;
    entry(i, addr, loop);
    starts.push(addr);
    parts.push(data);
    addr += data.length;
  });
  const image = new Uint8Array(Math.max(0, addr - DIR_ADDR));
  image.set(dir.subarray(0, Math.min(0x100, image.length)));
  let o = SAMPLES_ADDR - DIR_ADDR;
  for (const p of parts) {
    if (o + p.length > image.length) break;
    image.set(p, o);
    o += p.length;
  }
  const start = echoStart(song.echo.delay);
  return { image, end: addr, esa: start >> 8, echoStart: start, free: start - addr, starts };
}

/** Writes the layout into audio RAM; the echo buffer is cleared. */
export function loadAram(ram: Uint8Array, layout: AramLayout) {
  const fit = layout.image.subarray(0, Math.max(0, Math.min(layout.image.length, 0x10000 - DIR_ADDR)));
  ram.set(fit, DIR_ADDR);
  ram.fill(0, Math.max(layout.end, layout.echoStart), 0x10000);
}
