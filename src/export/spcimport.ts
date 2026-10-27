/**
 * SPC import. An SPC file is a snapshot of audio RAM and the DSP registers
 * with whatever sound driver the game used, so its music cannot be turned
 * back into patterns in general. Two things can be recovered:
 *
 * - SPC files from this tracker carry the song itself in a chunk after the
 *   SPC data (see `SONG_CHUNK`), and load back exactly.
 * - From any other SPC the samples are taken out of the sample directory
 *   (DIR) as BRR data, with the envelopes and echo the voices were using.
 */
import { BRR_BLOCK_BYTES, BRR_BLOCK_SAMPLES, BRR_END, BRR_LOOP, decodeBrr } from '../dsp/brr';
import { DIR, EDL, EFB, EVOLL, EVOLR, FIR, V_ADSR1, V_ADSR2, V_GAIN, V_SRCN, VOICE_COUNT } from '../dsp/dsp';
import { noteFrequency } from '../tracker/notes';
import { SAMPLE_COUNT, Sample, setLoop, toBase64 } from '../tracker/sample';
import { INSTRUMENT_COUNT, Instrument, Song, createSong, defaultInstrument, emptyPattern, parseSong } from '../tracker/song';

/** Magic of the chunk with the song JSON, at $10200 where extended ID666 ("xid6") would be; players skip it. */
export const SONG_CHUNK = 'STRK';
export const SPC_SIZE = 0x10200;
const SPC_MAGIC = 'SNES-SPC700 Sound File Data';

/** Longest sample taken from a directory entry: 32 KiB of BRR. */
const MAX_SAMPLE_BYTES = 0x8000;
/** The directory scan stops after this many unusable entries in a row. */
const MAX_GAP = 8;

/** The song chunk: magic, the JSON's length (32-bit little endian), the JSON as UTF-8. */
export function songChunk(song: Song): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(song));
  const out = new Uint8Array(8 + json.length);
  out.set(new TextEncoder().encode(SONG_CHUNK));
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  return out;
}

export interface SpcImport {
  song: Song;
  /** The song came back whole from the tracker's own chunk. */
  embedded: boolean;
  /** Samples taken from the sample directory (0 when embedded). */
  samples: number;
}

const latin1 = (data: Uint8Array, o: number, len: number) =>
  String.fromCharCode(...data.subarray(o, o + len))
    .replace(/\0.*$/s, '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();

export function isSpc(data: Uint8Array): boolean {
  return data.length >= 0x10180 && latin1(data, 0, SPC_MAGIC.length) === SPC_MAGIC;
}

/** Title and artist from the ID666 tag, text or binary format. */
export function spcTags(data: Uint8Array): { title: string; game: string; artist: string } {
  if (data[0x23] !== 26) return { title: '', game: '', artist: '' };
  // The text format has the fade length (digits) at $B0 and the artist from $B1; the binary one the artist from $B0.
  const b = data[0xb0];
  const binary = b >= 0x20 && b < 0x7f && !(b >= 0x30 && b <= 0x39);
  return { title: latin1(data, 0x2e, 32), game: latin1(data, 0x4e, 32), artist: latin1(data, binary ? 0xb0 : 0xb1, 32) };
}

function embeddedSong(data: Uint8Array): Song | null {
  if (data.length < SPC_SIZE + 8 || latin1(data, SPC_SIZE, 4) !== SONG_CHUNK) return null;
  const len = new DataView(data.buffer, data.byteOffset + SPC_SIZE + 4, 4).getUint32(0, true);
  if (SPC_SIZE + 8 + len > data.length) return null;
  try {
    return parseSong(JSON.parse(new TextDecoder().decode(data.subarray(SPC_SIZE + 8, SPC_SIZE + 8 + len))));
  } catch {
    return null;
  }
}

export interface DirSample {
  /** Directory entry (SRCN). */
  srcn: number;
  sample: Sample;
}

/**
 * The BRR data a directory entry points at, up to its end block, or null
 * when the entry does not look like a sample (out of RAM, invalid shift,
 * no end flag in reach, silent).
 */
function dirSample(ram: Uint8Array, start: number, loop: number, srcn: number): Sample | null {
  if (start < 0x100 || start === 0xffff) return null;
  let o = start;
  for (;;) {
    if (o + BRR_BLOCK_BYTES > ram.length || o - start >= MAX_SAMPLE_BYTES) return null;
    // Shifts above 12 are invalid on the DSP; no real sample uses them.
    if (ram[o] >> 4 > 12) return null;
    const end = ram[o] & BRR_END;
    o += BRR_BLOCK_BYTES;
    if (end) break;
  }
  const bytes = ram.slice(start, o);
  const blocks = bytes.length / BRR_BLOCK_BYTES;
  const loops = (bytes[bytes.length - BRR_BLOCK_BYTES] & BRR_LOOP) !== 0;
  const loopBlock = (loop - start) / BRR_BLOCK_BYTES;
  const pcm = decodeBrr(bytes);
  if (!pcm.some((v) => Math.abs(v) > 64)) return null;
  const name = `SRCN ${srcn.toString(16).toUpperCase().padStart(2, '0')}`;
  const sample: Sample = { name, brr: toBase64(bytes), loop: -1, rate: 32000 };
  if (!loops || !Number.isInteger(loopBlock) || loopBlock < 0 || loopBlock >= blocks) return setLoop(sample, -1);
  sample.loop = loopBlock;
  // A short loop is taken as one cycle of a waveform, tuned to C-4; anything else plays at 32 kHz on C-4.
  const cycle = (blocks - loopBlock) * BRR_BLOCK_SAMPLES;
  if (cycle <= 64) sample.rate = Math.round(cycle * noteFrequency(48));
  return sample;
}

/** The samples in the sample directory, at most `SAMPLE_COUNT`, each BRR block range once. */
export function directorySamples(ram: Uint8Array, dirPage: number): DirSample[] {
  const dir = dirPage << 8;
  const out: DirSample[] = [];
  const seen = new Set<string>();
  let gap = 0;
  for (let srcn = 0; srcn < 256 && out.length < SAMPLE_COUNT && gap < MAX_GAP; srcn++) {
    const e = (dir + srcn * 4) & 0xffff;
    const start = ram[e] | (ram[(e + 1) & 0xffff] << 8);
    const loop = ram[(e + 2) & 0xffff] | (ram[(e + 3) & 0xffff] << 8);
    // An entry inside the directory itself is past its end.
    const sample = start >= dir && start < dir + (srcn + 1) * 4 ? null : dirSample(ram, start, loop, srcn);
    const key = `${start}:${sample?.loop}`;
    if (!sample || seen.has(key)) {
      gap++;
      continue;
    }
    gap = 0;
    seen.add(key);
    out.push({ srcn, sample });
  }
  return out;
}

const s8 = (v: number) => (v << 24) >> 24;

/** An instrument for a sample, with the envelope of a voice that plays it. */
function voiceInstrument(i: number, sample: number, name: string, regs: Uint8Array | null): Instrument {
  const ins = defaultInstrument(i, sample, name);
  if (!regs) return ins;
  const [adsr1, adsr2, gain] = [regs[V_ADSR1], regs[V_ADSR2], regs[V_GAIN]];
  if (adsr1 & 0x80) {
    ins.adsr = { attack: adsr1 & 15, decay: (adsr1 >> 4) & 7, sustain: adsr2 >> 5, sustainRate: adsr2 & 31 };
  } else {
    ins.envelope = 'gain';
    ins.gain = gain;
  }
  return ins;
}

/** A song with the samples of a foreign SPC: one instrument per sample, the echo setup, no notes. */
export function songFromSpc(data: Uint8Array, fallbackTitle = 'SPC'): SpcImport {
  const ram = data.subarray(0x100, 0x10100);
  const dsp = data.subarray(0x10100, 0x10180);
  const found = directorySamples(ram, dsp[DIR]);
  if (!found.length) throw new Error('No samples found in the SPC file');
  const tags = spcTags(data);
  const song = createSong();
  song.title = tags.title || tags.game || fallbackTitle;
  song.author = tags.artist;
  song.patterns = [emptyPattern()];
  song.order = [0];
  song.samples = found.map((f) => f.sample);
  const voiceOf = (srcn: number) => {
    for (let v = 0; v < VOICE_COUNT; v++) if (dsp[v * 0x10 + V_SRCN] === srcn) return dsp.subarray(v * 0x10, v * 0x10 + 0x10);
    return null;
  };
  song.instruments = Array.from({ length: INSTRUMENT_COUNT }, (_, i) =>
    i < found.length ? voiceInstrument(i, i, found[i].sample.name, voiceOf(found[i].srcn)) : defaultInstrument(i),
  );
  song.echo = {
    delay: dsp[EDL] & 15,
    feedback: s8(dsp[EFB]),
    volumeL: s8(dsp[EVOLL]),
    volumeR: s8(dsp[EVOLR]),
    fir: Array.from({ length: 8 }, (_, i) => s8(dsp[FIR + i * 0x10])),
  };
  return { song, embedded: false, samples: found.length };
}

/** Reads an SPC file: the tracker's own song when it carries one, otherwise the samples. Throws on other files. */
export function readSpc(data: Uint8Array, fallbackTitle?: string): SpcImport {
  if (!isSpc(data)) throw new Error('Not an SPC file');
  const song = embeddedSong(data);
  if (song) return { song, embedded: true, samples: 0 };
  return songFromSpc(data, fallbackTitle);
}
