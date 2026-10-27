/**
 * Notes from any SPC file. The file's own driver runs on the emulated APU
 * while the DSP register writes are watched: every key-on becomes a note
 * with the sample, pitch, volume and envelope the voice had, every key-off
 * a note off, and volume changes in between go to the volume column. The
 * notes are then put on the row grid that fits their timing best.
 *
 * This is a transcription, not a decompilation: what the driver does
 * between notes (pitch slides, vibrato, tempo changes, its own loop points)
 * comes out only as far as rows, notes and volumes can say it.
 */
import {
  COUNTER_RATES, DIR, DSP_RATE, Dsp, ENDX, EON, FLG, KOFF, KON, MVOLL, NON, VOICE_COUNT, V_ADSR1, V_ADSR2, V_ENVX, V_GAIN, V_OUTX, V_PITCHH, V_PITCHL, V_SRCN,
  V_VOLL, V_VOLR,
} from '../dsp/dsp';
import { SpcImport, echoOf, embeddedSong, entrySample, isSpc, setEnvelope, songFromSpc, spcSeconds, spcTags } from '../export/spcimport';
import { C4, NOTE_COUNT } from '../tracker/notes';
import { FX, tickUnits } from '../tracker/player';
import { SAMPLE_COUNT, Sample } from '../tracker/sample';
import {
  CHANNEL_COUNT, EMPTY, INSTRUMENT_COUNT, Instrument, MAX_BPM, MAX_VOLUME, MIN_BPM, NOTE_OFF, Pattern, Song, createSong, defaultInstrument, emptyPattern,
} from '../tracker/song';
import { Apu, CYCLES_PER_SAMPLE } from './apu';

/** Samples between a key-on and reading the voice's registers (the DSP itself takes 5 to start the voice). */
const KON_DELAY = 16;
/** Volume registers are looked at this often (samples). */
const VOLUME_STEP = 128;
/** Longest transcription when the ID666 tag gives no length (seconds). */
export const DEFAULT_SECONDS = 120;
export const MAX_SECONDS = 600;
/** Rows of the grid: at least 15.6 ms, at most 500 ms. */
const MIN_ROW = 500;
const MAX_ROW = 16000;
/**
 * How far notes may sit from their row on average, in samples (3 ms):
 * drivers tick at a few hundred Hz, so their notes jitter by a tick or so.
 */
const MAX_JITTER = 96;
const MAX_PATTERNS = 256;

export interface SpcNote {
  /** DSP sample (32 kHz) of the key-on. */
  time: number;
  voice: number;
  srcn: number;
  pitch: number;
  volL: number;
  volR: number;
  adsr1: number;
  adsr2: number;
  gain: number;
  echo: boolean;
  noise: boolean;
  /** Noise clock (FLG bits 0-4) at the key-on. */
  noiseClock: number;
}

export interface SpcOff {
  time: number;
  voice: number;
}

export interface SpcVolume {
  time: number;
  voice: number;
  volL: number;
  volR: number;
}

export interface SpcCapture {
  notes: SpcNote[];
  offs: SpcOff[];
  volumes: SpcVolume[];
  /** Samples run. */
  length: number;
  /** DSP registers at the end. */
  regs: Uint8Array;
}

export interface CaptureOptions {
  seconds?: number;
  /** Called with 0..1 now and then; the capture yields to the event loop at the same time. */
  onProgress?: (done: number) => void;
}

/** Samples run at a time when the DSP is left out (the CPU alone, 512 cycles). */
const STEP = KON_DELAY;

/** Registers the DSP writes back: a driver that reads them needs the DSP running. */
const isDspOutput = (reg: number) => (reg & 0x0f) === V_ENVX || (reg & 0x0f) === V_OUTX || reg === ENDX;

/**
 * Runs the SPC's driver for `seconds` and records what it plays. Only the
 * SPC700 runs, which is several times faster, unless the driver reads what
 * the DSP writes back (envelope, output, end flags): then the capture starts
 * again with the DSP.
 */
export async function captureSpc(data: Uint8Array, opts: CaptureOptions = {}): Promise<SpcCapture> {
  return (await capture(data, opts, false)) ?? (await capture(data, opts, true))!;
}

async function capture(data: Uint8Array, opts: CaptureOptions, withDsp: boolean): Promise<SpcCapture | null> {
  const dsp = new Dsp();
  const apu = new Apu(dsp);
  apu.load(data);
  const total = Math.round(Math.min(MAX_SECONDS, opts.seconds ?? DEFAULT_SECONDS) * DSP_RATE);
  const notes: SpcNote[] = [];
  const offs: SpcOff[] = [];
  const volumes: SpcVolume[] = [];
  const pending: { voice: number; time: number }[] = [];
  let volDirty = 0;
  let time = 0;
  let needsDsp = false;
  apu.onDspWrite = (reg, value) => {
    if (reg === KON) {
      for (let v = 0; v < VOICE_COUNT; v++) if ((value >> v) & 1) pending.push({ voice: v, time });
    } else if (reg === KOFF) {
      for (let v = 0; v < VOICE_COUNT; v++) if ((value >> v) & 1) offs.push({ voice: v, time });
    } else if ((reg & 0x0f) === V_VOLL || (reg & 0x0f) === V_VOLR) {
      volDirty |= 1 << (reg >> 4);
    }
  };
  if (!withDsp) {
    apu.onDspRead = (reg) => (needsDsp ||= isDspOutput(reg));
    apu.skipIdle = true;
  }
  const regs = dsp.regs;
  const step = withDsp ? 1 : STEP;
  const yieldEvery = withDsp ? DSP_RATE : DSP_RATE * 8;
  for (; time < total; time += step) {
    if (withDsp) {
      apu.run(1);
      if (dsp.outCount >= 4096) dsp.consume(dsp.outCount);
    } else {
      apu.runCpu(step * CYCLES_PER_SAMPLE);
      if (needsDsp) return null;
    }
    while (pending.length && pending[0].time + KON_DELAY <= time) {
      const { voice, time: t } = pending.shift()!;
      const b = voice << 4;
      notes.push({
        time: t,
        voice,
        srcn: regs[b + V_SRCN],
        pitch: (regs[b + V_PITCHL] | (regs[b + V_PITCHH] << 8)) & 0x3fff,
        volL: regs[b + V_VOLL],
        volR: regs[b + V_VOLR],
        adsr1: regs[b + V_ADSR1],
        adsr2: regs[b + V_ADSR2],
        gain: regs[b + V_GAIN],
        echo: ((regs[EON] >> voice) & 1) !== 0,
        noise: ((regs[NON] >> voice) & 1) !== 0,
        noiseClock: regs[FLG] & 0x1f,
      });
    }
    if (volDirty && time % VOLUME_STEP === 0) {
      for (let v = 0; v < VOICE_COUNT; v++)
        if ((volDirty >> v) & 1) volumes.push({ time, voice: v, volL: regs[(v << 4) + V_VOLL], volR: regs[(v << 4) + V_VOLR] });
      volDirty = 0;
    }
    if (time % yieldEvery === yieldEvery - step) {
      opts.onProgress?.(time / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  opts.onProgress?.(1);
  return { notes, offs, volumes, length: total, regs: regs.slice() };
}

export interface Grid {
  /** Samples per row. */
  row: number;
  /** Time of row 0. */
  phase: number;
  /** Mean distance of the events from their row, in rows (0..0.5). */
  error: number;
}

function gridError(times: number[], row: number): { phase: number; error: number } {
  let sx = 0;
  let sy = 0;
  for (const t of times) {
    const a = (2 * Math.PI * t) / row;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const phase = ((Math.atan2(sy, sx) / (2 * Math.PI)) * row + row) % row;
  let error = 0;
  for (const t of times) {
    const d = (t - phase) / row;
    error += Math.abs(d - Math.round(d));
  }
  return { phase, error: error / times.length };
}

/**
 * The longest row length that puts every event within a few milliseconds of
 * a row, so the pattern is as readable as the timing allows.
 */
export function fitGrid(eventTimes: number[]): Grid {
  const times = [...eventTimes].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 32);
  if (times.length < 4) return { row: 4000, phase: times[0] ?? 0, error: 0 };
  const first = times[0];
  const rel = times.map((t) => t - first);
  // Coarse pass, then the candidates refined from the longest row down.
  // Steps of 0.2 %: a row length off by that much drifts a fifth of a row over 100 rows, still within the fit.
  const coarse: { row: number; error: number }[] = [];
  for (let row = MIN_ROW; row <= MAX_ROW; row *= 1.002) coarse.push({ row, error: gridError(rel, row).error });
  // The best fit within 3 % of a row length (a loose tolerance lets a slightly wrong length pass), then to 1/8 sample.
  const refine = (row: number) => {
    let fine = { row, ...gridError(rel, row) };
    for (let r = Math.max(MIN_ROW, Math.round(row * 0.97)); r <= row * 1.03; r += Math.max(1, Math.round(row / 2000))) {
      const g = gridError(rel, r);
      if (g.error * r < fine.error * fine.row - 1e-9) fine = { row: r, ...g };
    }
    const coarseRow = fine.row;
    for (let r = coarseRow - 1; r <= coarseRow + 1; r += 0.125) {
      const g = gridError(rel, r);
      if (g.error * r < fine.error * fine.row - 1e-9) fine = { row: r, ...g };
    }
    return fine;
  };
  let fine: { row: number; phase: number; error: number } | null = null;
  const candidates = coarse.filter((c) => c.error * c.row <= 2 * MAX_JITTER && c.error < 0.3).reverse();
  for (const c of candidates) {
    const f = refine(c.row);
    if (f.error * f.row <= MAX_JITTER && f.error < 0.25) {
      fine = f;
      break;
    }
  }
  if (!fine) fine = refine(coarse.reduce((a, b) => (b.error < a.error ? b : a)).row);
  const row = fine.row;
  // Row 0 is the row of the first event.
  let phase = first + fine.phase;
  phase -= Math.round((phase - first) / row) * row;
  return { row, phase, error: fine.error };
}

/** Seconds of notes each row length is measured on. */
const WINDOW = 20 * DSP_RATE;

/**
 * Row length of a whole song: fitted on stretches of 20 seconds, since a
 * driver's timing drifts against any fixed grid over minutes (and jumps
 * where the song loops). The shortest good fit wins, so every stretch has
 * its notes on rows.
 */
export function rowLength(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  const rows: number[] = [];
  for (let start = 0, i = 0; i < sorted.length; start += WINDOW) {
    const part: number[] = [];
    while (i < sorted.length && sorted[i] < start + WINDOW) part.push(sorted[i++]);
    if (part.length < 16) continue;
    const g = fitGrid(part);
    if (g.error * g.row <= MAX_JITTER) rows.push(g.row);
  }
  return rows.length ? Math.min(...rows) : fitGrid(sorted).row;
}

/**
 * Row length of a capture: from the notes, or finer when the key-offs
 * between them also sit on a grid (notes only on even rows would otherwise
 * give rows twice as long and move the key-offs).
 */
export function captureRow(capture: SpcCapture): number {
  const notes = capture.notes.map((n) => n.time);
  const row = rowLength(notes);
  // Key-offs of sounding voices that are not just before a new note on the same voice.
  const onsets: number[][] = Array.from({ length: VOICE_COUNT }, () => []);
  for (const n of capture.notes) onsets[n.voice].push(n.time);
  const next = Array(VOICE_COUNT).fill(0);
  const offs: number[] = [];
  for (const o of [...capture.offs].sort((a, b) => a.time - b.time)) {
    const list = onsets[o.voice];
    while (next[o.voice] < list.length && list[next[o.voice]] < o.time) next[o.voice]++;
    const t = list[next[o.voice]];
    if (t === undefined || t - o.time >= 256) offs.push(o.time);
  }
  if (!offs.length || row / 2 < MIN_ROW) return row;
  const all = [...notes, ...offs];
  const finer = rowLength(all);
  const ratio = row / finer;
  const g = gridError(all, finer);
  return ratio > 1.5 && Math.abs(ratio - Math.round(ratio)) < 0.02 && g.error * finer <= MAX_JITTER ? finer : row;
}

/**
 * Row of any time: counted from the latest note before it, so the grid
 * follows the driver's timing instead of drifting away from it. The first
 * note is on row 0.
 */
export function rowIndexer(noteTimes: number[], row: number): (time: number) => number {
  const times = [...new Set(noteTimes)].sort((a, b) => a - b);
  const rows: number[] = [];
  times.forEach((t, i) => rows.push(i ? rows[i - 1] + Math.round((t - times[i - 1]) / row) : 0));
  return (time) => {
    if (!times.length) return Math.round(time / row);
    let lo = 0;
    let hi = times.length - 1;
    if (time < times[0]) return Math.round((time - times[0]) / row);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return rows[lo] + Math.round((time - times[lo]) / row);
  };
}

/** Speed and BPM whose rows come closest to `row` samples. */
export function tempoFor(row: number): { speed: number; bpm: number } {
  let best = { speed: 6, bpm: 125, error: Infinity };
  for (let speed = 1; speed <= 31; speed++) {
    for (const bpm of [Math.floor((80000 * speed) / row), Math.ceil((80000 * speed) / row)]) {
      if (bpm < MIN_BPM || bpm > MAX_BPM) continue;
      const error = Math.abs(speed * tickUnits(bpm) * 4 - row) / row + Math.abs(speed - 6) * 1e-4;
      if (error < best.error) best = { speed, bpm, error };
    }
  }
  return { speed: best.speed, bpm: best.bpm };
}

/** Volume (0..127) and pan (0..255) from a voice's volume registers. */
export function volumePan(volL: number, volR: number): { volume: number; pan: number } {
  const l = Math.min(127, Math.abs((volL << 24) >> 24));
  const r = Math.min(127, Math.abs((volR << 24) >> 24));
  const volume = Math.max(l, r);
  if (!volume) return { volume: 0, pan: 128 };
  const pan = l >= r ? Math.round((128 * r) / l) : 255 - Math.round((128 * l) / r);
  return { volume, pan: Math.max(0, Math.min(255, pan)) };
}

/** The note whose noise clock is the given one (inverse of noiseClockFor). */
function noiseNote(clock: number): number {
  const hz = DSP_RATE / COUNTER_RATES[Math.max(1, clock)] / 8;
  return Math.max(0, Math.min(NOTE_COUNT - 1, Math.round(57 + 12 * Math.log2(hz / 440))));
}

interface Voice {
  key: string;
  srcn: number;
  noise: boolean;
  first: SpcNote;
  count: number;
}

/** The song of a capture: samples, one instrument per sample (and noise), and the notes on rows. */
export function songFromCapture(capture: SpcCapture, ram: Uint8Array, row = captureRow(capture)): {
  song: Song;
  notes: number;
} {
  const regs = capture.regs;
  const dirPage = regs[DIR];
  // Instruments: the most used sample/noise pairs that have a usable sample.
  const kinds = new Map<string, Voice>();
  const sampleOf = new Map<number, Sample | null>();
  for (const n of capture.notes) {
    if (!sampleOf.has(n.srcn)) sampleOf.set(n.srcn, entrySample(ram, dirPage, n.srcn));
    if (!n.noise && !sampleOf.get(n.srcn)) continue;
    const key = `${n.srcn}${n.noise ? 'n' : ''}`;
    const k = kinds.get(key);
    if (k) k.count++;
    else kinds.set(key, { key, srcn: n.srcn, noise: n.noise, first: n, count: 1 });
  }
  const used = [...kinds.values()].sort((a, b) => b.count - a.count || a.first.time - b.first.time).slice(0, INSTRUMENT_COUNT);
  used.sort((a, b) => a.first.time - b.first.time);
  const samples: Sample[] = [];
  const sampleIndex = new Map<number, number>();
  for (const u of used) {
    const s = sampleOf.get(u.srcn);
    if (s && !sampleIndex.has(u.srcn) && samples.length < SAMPLE_COUNT) {
      sampleIndex.set(u.srcn, samples.length);
      samples.push(s);
    }
  }
  const insIndex = new Map(used.map((u, i) => [u.key, i]));

  // Tuning: the semitone of each note; per instrument the common fraction goes into finetune.
  const semis = new Map<string, number[]>();
  const semiOf = (n: SpcNote) => {
    const s = samples[sampleIndex.get(n.srcn) ?? -1];
    if (n.noise) return noiseNote(n.noiseClock);
    if (!s || !n.pitch) return NaN;
    return C4 + 12 * Math.log2((n.pitch * DSP_RATE) / (0x1000 * s.rate));
  };
  for (const n of capture.notes) {
    const key = `${n.srcn}${n.noise ? 'n' : ''}`;
    if (!insIndex.has(key)) continue;
    const v = semiOf(n);
    if (Number.isFinite(v)) semis.set(key, [...(semis.get(key) ?? []), v]);
  }
  const instruments: Instrument[] = Array.from({ length: INSTRUMENT_COUNT }, (_, i) => defaultInstrument(i));
  const tuning = new Map<string, { fine: number; transpose: number }>();
  used.forEach((u, i) => {
    const name = `SRCN ${u.srcn.toString(16).toUpperCase().padStart(2, '0')}${u.noise ? ' noise' : ''}`;
    const ins = defaultInstrument(i, u.noise ? (sampleIndex.get(u.srcn) ?? -1) : sampleIndex.get(u.srcn)!, name);
    setEnvelope(ins, u.first.adsr1, u.first.adsr2, u.first.gain);
    ins.volume = MAX_VOLUME;
    ins.echo = u.first.echo;
    ins.noise = u.noise;
    const list = semis.get(u.key) ?? [];
    const fracs = list.map((s) => s - Math.round(s)).sort((a, b) => a - b);
    const fine = u.noise ? 0 : Math.max(-128, Math.min(127, Math.round((fracs[fracs.length >> 1] ?? 0) * 128)));
    const notes = list.map((s) => Math.round(s - fine / 128));
    const lo = Math.min(...notes);
    const hi = Math.max(...notes);
    let transpose = 0;
    if (hi > NOTE_COUNT - 1) transpose = Math.ceil((hi - (NOTE_COUNT - 1)) / 12) * 12;
    else if (lo < 0) transpose = -Math.ceil(-lo / 12) * 12;
    ins.finetune = fine;
    ins.transpose = Math.max(-48, Math.min(48, transpose));
    tuning.set(u.key, { fine, transpose: ins.transpose });
    instruments[i] = ins;
  });

  // Events in time order onto the rows.
  const rowOf = rowIndexer(capture.notes.map((n) => n.time), row);
  const rows = Math.min(MAX_PATTERNS * 64, Math.max(1, rowOf(capture.length) + 1));
  const patterns: Pattern[] = Array.from({ length: Math.ceil(rows / 64) }, () => emptyPattern(64));
  const cellAt = (time: number, voice: number) => {
    const r = rowOf(time);
    if (r < 0 || r >= rows) return null;
    return patterns[r >> 6].rows[r & 63][voice];
  };
  type Ev = { time: number; order: number; apply: () => void };
  const events: Ev[] = [];
  const sounding: boolean[] = Array(CHANNEL_COUNT).fill(false);
  const lastVolume: number[] = Array(CHANNEL_COUNT).fill(-1);
  let placed = 0;
  for (const n of capture.notes) {
    events.push({
      time: n.time,
      order: 1,
      apply: () => {
        const key = `${n.srcn}${n.noise ? 'n' : ''}`;
        const ins = insIndex.get(key);
        const cell = cellAt(n.time, n.voice);
        const semi = semiOf(n);
        if (ins === undefined || !cell || !Number.isFinite(semi)) return;
        const { fine, transpose } = tuning.get(key)!;
        const { volume, pan } = volumePan(n.volL, n.volR);
        cell.note = Math.max(0, Math.min(NOTE_COUNT - 1, Math.round(semi - fine / 128) - transpose));
        cell.instrument = ins;
        cell.volume = volume;
        if (pan !== 128) {
          cell.effect = FX.PANNING;
          cell.param = pan;
        } else if (cell.effect === FX.PANNING) {
          cell.effect = EMPTY;
          cell.param = 0;
        }
        placed++;
        sounding[n.voice] = true;
        lastVolume[n.voice] = volume;
      },
    });
  }
  for (const o of capture.offs) {
    events.push({
      time: o.time,
      order: 0,
      apply: () => {
        if (!sounding[o.voice]) return;
        sounding[o.voice] = false;
        const cell = cellAt(o.time, o.voice);
        // A note in the same row wins over its own key-off.
        if (cell && cell.note === EMPTY) cell.note = NOTE_OFF;
      },
    });
  }
  for (const v of capture.volumes) {
    events.push({
      time: v.time,
      order: 2,
      apply: () => {
        if (!sounding[v.voice]) return;
        const { volume } = volumePan(v.volL, v.volR);
        if (Math.abs(volume - lastVolume[v.voice]) < 4) return;
        const cell = cellAt(v.time, v.voice);
        if (!cell || cell.note !== EMPTY) return;
        cell.volume = volume;
        lastVolume[v.voice] = volume;
      },
    });
  }
  events.sort((a, b) => a.time - b.time || a.order - b.order);
  for (const e of events) e.apply();

  const song = createSong();
  const { speed, bpm } = tempoFor(row);
  song.bpm = bpm;
  song.speed = speed;
  song.samples = samples;
  song.instruments = instruments;
  song.patterns = patterns;
  song.order = patterns.map((_, i) => i);
  song.echo = echoOf(regs);
  const mvol = Math.abs((regs[MVOLL] << 24) >> 24);
  song.volume = Math.min(127, mvol || 96);
  return { song, notes: placed };
}

/**
 * Reads any SPC file: the tracker's own song when it carries one, otherwise
 * the notes its driver plays (for the length in its ID666 tag) with the
 * samples they use. A file whose driver plays nothing gives its samples only.
 */
export async function importSpc(data: Uint8Array, fallbackTitle = 'SPC', opts: CaptureOptions = {}): Promise<SpcImport & { notes: number }> {
  if (!isSpc(data)) throw new Error('Not an SPC file');
  const own = embeddedSong(data);
  if (own) return { song: own, embedded: true, samples: 0, notes: 0 };
  const seconds = Math.min(MAX_SECONDS, opts.seconds ?? (spcSeconds(data) || DEFAULT_SECONDS));
  const capture = await captureSpc(data, { ...opts, seconds });
  const ram = data.subarray(0x100, 0x10100);
  const { song, notes } = songFromCapture(capture, ram);
  if (!notes || !song.samples.length) {
    const fallback = songFromSpc(data, fallbackTitle);
    return { ...fallback, notes: 0 };
  }
  const tags = spcTags(data);
  song.title = tags.title || tags.game || fallbackTitle;
  song.author = tags.artist;
  return { song, embedded: false, samples: song.samples.length, notes };
}

