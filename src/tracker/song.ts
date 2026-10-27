import { NOTE_COUNT } from './notes';
import { SAMPLE_COUNT, Sample, builtinSamples, fromBase64 } from './sample';

/** Empty field marker for note, instrument, volume and effect. */
export const EMPTY = -1;
/** Note value that releases the note (shown as "==="). */
export const NOTE_OFF = -2;

export const CHANNEL_COUNT = 8;
export const DEFAULT_ROWS = 64;
export const MAX_ROWS = 256;
export const INSTRUMENT_COUNT = 32;
export const MAX_VOLUME = 0x7f;
export const MIN_BPM = 32;
export const MAX_BPM = 255;

export interface Cell {
  /** 0..95, EMPTY or NOTE_OFF */
  note: number;
  /** 0..31 (shown as 01..20), or EMPTY */
  instrument: number;
  /** 0..127, or EMPTY */
  volume: number;
  /** 0..15, or EMPTY */
  effect: number;
  /** 0..255 */
  param: number;
}

export interface Pattern {
  /** rows[row][channel] */
  rows: Cell[][];
}

export interface Adsr {
  /** 0..15: 4.1 s .. 0 ms */
  attack: number;
  /** 0..7: 1.2 s .. 37 ms */
  decay: number;
  /** 0..7: level (n+1)/8 */
  sustain: number;
  /** 0..31: fade after the sustain level is reached (SR); 0 = hold, 31 = fastest */
  sustainRate: number;
}

export interface Instrument {
  name: string;
  /** Sample index, -1 = none. */
  sample: number;
  /** 0..127 */
  volume: number;
  /** 0 (left) .. 128 (centre) .. 255 (right) */
  pan: number;
  /** Semitones, -48..48 */
  transpose: number;
  /** 1/128 semitone, -128..127 */
  finetune: number;
  /** Envelope: the hardware ADSR, or a fixed GAIN register value. */
  envelope: 'adsr' | 'gain';
  adsr: Adsr;
  /** GAIN register (direct level 0x00-0x7F, or a slope mode 0x80-0xFF). */
  gain: number;
  /** Note off: 0 = key off (fast hardware release), 1..31 = exponential GAIN fade at that rate. */
  release: number;
  /** Voice goes through the echo unit. */
  echo: boolean;
  /** Plays the DSP's noise generator instead of the sample (the note sets the noise clock). */
  noise: boolean;
  /** Pitch modulated by the voice to the left (not on channel 1). */
  pitchMod: boolean;
}

export interface Echo {
  /** EDL: 0..15 × 16 ms (each step takes 2 KiB of audio RAM) */
  delay: number;
  /** -128..127 */
  feedback: number;
  /** -128..127 */
  volumeL: number;
  volumeR: number;
  /** Eight FIR filter coefficients, -128..127 */
  fir: number[];
}

export interface Song {
  version: 1;
  title: string;
  author: string;
  /** Ticks per minute / 2.5, as in FastTracker (125 → 50 ticks per second). */
  bpm: number;
  /** Ticks per row */
  speed: number;
  patterns: Pattern[];
  order: number[];
  instruments: Instrument[];
  samples: Sample[];
  /** Main volume, 0..127 (both sides). */
  volume: number;
  echo: Echo;
}

export const FIR_PRESETS: Record<string, number[]> = {
  flat: [127, 0, 0, 0, 0, 0, 0, 0],
  lowpass: [0x0c, 0x21, 0x2b, 0x2b, 0x13, 0xfe, 0xf3, 0xf9].map((v) => (v << 24) >> 24),
  soft: [0x58, 0xbf, 0xdb, 0xf0, 0xfe, 0x07, 0x0c, 0x0c].map((v) => (v << 24) >> 24),
  highpass: [0x34, 0x33, 0x00, 0xd9, 0xe5, 0x01, 0xfc, 0xeb].map((v) => (v << 24) >> 24),
};

export function emptyCell(): Cell {
  return { note: EMPTY, instrument: EMPTY, volume: EMPTY, effect: EMPTY, param: 0 };
}

export function isEmptyCell(c: Cell) {
  return c.note === EMPTY && c.instrument === EMPTY && c.volume === EMPTY && c.effect === EMPTY;
}

export function emptyPattern(rows = DEFAULT_ROWS): Pattern {
  return { rows: Array.from({ length: rows }, () => Array.from({ length: CHANNEL_COUNT }, emptyCell)) };
}

export function clonePattern(p: Pattern): Pattern {
  return { rows: p.rows.map((r) => r.map((c) => ({ ...c }))) };
}

export function defaultAdsr(): Adsr {
  return { attack: 15, decay: 7, sustain: 7, sustainRate: 0 };
}

export function defaultInstrument(i: number, sample = -1, name = `Instrument ${(i + 1).toString(16).toUpperCase().padStart(2, '0')}`): Instrument {
  return {
    name,
    sample,
    volume: 100,
    pan: 128,
    transpose: 0,
    finetune: 0,
    envelope: 'adsr',
    adsr: defaultAdsr(),
    gain: 0x7f,
    release: 0,
    echo: false,
    noise: false,
    pitchMod: false,
  };
}

/** Instruments for the built-in samples, with envelopes that suit them. */
function builtinInstruments(samples: Sample[]): Instrument[] {
  const by = (name: string) => samples.findIndex((s) => s.name === name);
  const ins = (name: string, patch: Partial<Instrument>, adsr?: Partial<Adsr>): Instrument => {
    const base = defaultInstrument(0, by(name), name);
    return { ...base, ...patch, adsr: { ...base.adsr, ...adsr } };
  };
  const list = [
    ins('Square', { volume: 80 }, { decay: 3, sustain: 5, sustainRate: 12 }),
    ins('Pulse 25%', { volume: 80 }, { decay: 4, sustain: 4, sustainRate: 10 }),
    ins('Pulse 12.5%', { volume: 80 }, { decay: 4, sustain: 4, sustainRate: 10 }),
    ins('Saw', { volume: 80, echo: true }, { attack: 14, decay: 2, sustain: 5, sustainRate: 9 }),
    ins('Triangle', { volume: 110 }, { decay: 5, sustain: 6, sustainRate: 6 }),
    ins('Sine', { volume: 100, echo: true }, { attack: 12, decay: 6, sustain: 6, sustainRate: 0 }),
    ins('Organ', { volume: 90, echo: true }, { attack: 15, decay: 7, sustain: 7, sustainRate: 0 }),
    ins('Bass', { volume: 120, transpose: -12 }, { attack: 15, decay: 4, sustain: 5, sustainRate: 14 }),
    ins('Strings', { volume: 85, echo: true, release: 18 }, { attack: 10, decay: 6, sustain: 6, sustainRate: 0 }),
    ins('Piano', { volume: 110, echo: true }, { attack: 15, decay: 7, sustain: 7, sustainRate: 0 }),
    ins('Kick', { volume: 127 }, {}),
    ins('Snare', { volume: 110, echo: true }, {}),
    ins('Hi-hat', { volume: 70, pan: 150 }, {}),
    ins('Crash', { volume: 70, echo: true, pan: 110 }, {}),
    { ...defaultInstrument(0, by('Square'), 'Noise'), noise: true, volume: 60, adsr: { attack: 15, decay: 5, sustain: 0, sustainRate: 18 } },
  ];
  return Array.from({ length: INSTRUMENT_COUNT }, (_, i) => list[i] ?? defaultInstrument(i));
}

export function defaultEcho(): Echo {
  return { delay: 4, feedback: 64, volumeL: 40, volumeR: 40, fir: [...FIR_PRESETS.lowpass] };
}

export function createSong(): Song {
  const samples = builtinSamples();
  return {
    version: 1,
    title: 'Untitled',
    author: '',
    bpm: 125,
    speed: 6,
    patterns: [emptyPattern()],
    order: [0],
    instruments: builtinInstruments(samples),
    samples,
    volume: 96,
    echo: defaultEcho(),
  };
}

/** Remove a sample; instruments that used it lose it, later ones move down. */
export function deleteSample(song: Song, index: number) {
  song.samples.splice(index, 1);
  for (const ins of song.instruments) {
    if (ins.sample === index) ins.sample = -1;
    else if (ins.sample > index) ins.sample--;
  }
}

const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);

/** Validate and normalise a parsed song file. Throws on unusable input. */
export function parseSong(json: unknown): Song {
  if (!json || typeof json !== 'object') throw new Error('Not a valid song file');
  const raw = json as Partial<Song>;
  if (!Array.isArray(raw.patterns) || !Array.isArray(raw.order)) throw new Error('Song file has no patterns');
  const base = createSong();
  const cell = (c: Partial<Cell> | undefined): Cell => ({
    note: c?.note === NOTE_OFF ? NOTE_OFF : clampInt(c?.note, EMPTY, NOTE_COUNT - 1, EMPTY),
    instrument: clampInt(c?.instrument, EMPTY, INSTRUMENT_COUNT - 1, EMPTY),
    volume: clampInt(c?.volume, EMPTY, MAX_VOLUME, EMPTY),
    effect: clampInt(c?.effect, EMPTY, 15, EMPTY),
    param: clampInt(c?.param, 0, 255, 0),
  });
  const patterns = raw.patterns.map((p) => ({
    rows: (Array.isArray(p?.rows) && p.rows.length ? p.rows : emptyPattern().rows)
      .slice(0, MAX_ROWS)
      .map((r) => Array.from({ length: CHANNEL_COUNT }, (_, ch) => cell(Array.isArray(r) ? r[ch] : undefined))),
  }));
  if (!patterns.length) patterns.push(emptyPattern());
  const order = raw.order.map((o) => clampInt(o, 0, patterns.length - 1, 0));
  const rawSamples = Array.isArray(raw.samples) ? raw.samples : base.samples;
  const samples: Sample[] = rawSamples.slice(0, SAMPLE_COUNT).map((x, i) => {
    const brr = typeof x?.brr === 'string' && fromBase64(x.brr).length ? x.brr : base.samples[0].brr;
    return {
      name: str(x?.name, `Sample ${i + 1}`),
      brr,
      loop: clampInt(x?.loop, -1, 0xffff, -1),
      rate: clampInt(x?.rate, 1, 128000, 32000),
    };
  });
  const sampleIndex = (v: unknown) => clampInt(v, -1, samples.length - 1, -1);
  const instruments = Array.from({ length: INSTRUMENT_COUNT }, (_, i): Instrument => {
    const d = defaultInstrument(i);
    const x = (Array.isArray(raw.instruments) ? raw.instruments[i] : undefined) as Partial<Instrument> | undefined;
    if (!x || typeof x !== 'object') return Array.isArray(raw.instruments) ? d : base.instruments[i];
    const a = (x.adsr ?? {}) as Partial<Adsr>;
    return {
      name: str(x.name, d.name),
      sample: sampleIndex(x.sample),
      volume: clampInt(x.volume, 0, 127, d.volume),
      pan: clampInt(x.pan, 0, 255, d.pan),
      transpose: clampInt(x.transpose, -48, 48, 0),
      finetune: clampInt(x.finetune, -128, 127, 0),
      envelope: x.envelope === 'gain' ? 'gain' : 'adsr',
      adsr: {
        attack: clampInt(a.attack, 0, 15, 15),
        decay: clampInt(a.decay, 0, 7, 7),
        sustain: clampInt(a.sustain, 0, 7, 7),
        sustainRate: clampInt(a.sustainRate, 0, 31, 0),
      },
      gain: clampInt(x.gain, 0, 255, 0x7f),
      release: clampInt(x.release, 0, 31, 0),
      echo: !!x.echo,
      noise: !!x.noise,
      pitchMod: !!x.pitchMod,
    };
  });
  const e = (raw.echo ?? {}) as Partial<Echo>;
  const de = defaultEcho();
  return {
    version: 1,
    title: str(raw.title, base.title),
    author: str(raw.author, ''),
    bpm: clampInt(raw.bpm, MIN_BPM, MAX_BPM, 125),
    speed: clampInt(raw.speed, 1, 31, 6),
    patterns,
    order: order.length ? order : [0],
    instruments,
    samples,
    volume: clampInt(raw.volume, 0, 127, 96),
    echo: {
      delay: clampInt(e.delay, 0, 15, de.delay),
      feedback: clampInt(e.feedback, -128, 127, de.feedback),
      volumeL: clampInt(e.volumeL, -128, 127, de.volumeL),
      volumeR: clampInt(e.volumeR, -128, 127, de.volumeR),
      fir: Array.from({ length: 8 }, (_, i) => clampInt(Array.isArray(e.fir) ? e.fir[i] : undefined, -128, 127, de.fir[i])),
    },
  };
}
