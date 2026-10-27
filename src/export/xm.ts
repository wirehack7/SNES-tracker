/**
 * FastTracker 2 XM export (linear frequencies, 8 channels).
 *
 * Every instrument with a sample becomes an XM instrument: the BRR sample is
 * decoded to 16 bits (with its loop), tuned with relative note and finetune,
 * and the ADSR/GAIN envelope is measured on the emulated DSP and written as
 * a volume envelope. Effects with the same meaning in XM are translated; the
 * SNES-only ones (echo, noise, pitch modulation, surround) are listed as
 * warnings after the export.
 */
import { COUNTER_RATES, DIR, Dsp, FLG, KOFF, KON, V_ADSR1, V_ADSR2, V_ENVX, V_GAIN, V_SRCN, V_VOLL } from '../dsp/dsp';
import { FX, SAMPLES_PER_UNIT, envelopeRegs, tickUnits } from '../tracker/player';
import { decodeSample } from '../tracker/sample';
import { CHANNEL_COUNT, EMPTY, Instrument, MAX_VOLUME, NOTE_OFF, Song } from '../tracker/song';

export const XM_KEY_OFF = 97;
/** XM plays its note 49 (C-4) at 8363 Hz with relative note 0 and finetune 0. */
const XM_C4_RATE = 8363;

/** Things the format cannot represent, counted for the export report. */
export class Warnings {
  readonly counts = new Map<string, number>();
  add(what: string, n = 1) {
    this.counts.set(what, (this.counts.get(what) ?? 0) + n);
  }
  list(): string[] {
    return [...this.counts].map(([w, n]) => `${w} (${n}×)`);
  }
}

/** Relative note and finetune that play C-4 at `rate` Hz shifted by `semitones`. */
export function xmTuning(rate: number, semitones = 0): { relativeNote: number; finetune: number } {
  const semis = 12 * Math.log2(rate / XM_C4_RATE) + semitones;
  let relativeNote = Math.floor(semis);
  let finetune = Math.round((semis - relativeNote) * 128);
  if (finetune > 127) {
    relativeNote++;
    finetune -= 128;
  }
  return { relativeNote: Math.max(-96, Math.min(95, relativeNote)), finetune };
}

export interface EnvelopePoint {
  tick: number;
  value: number;
}

/**
 * The instrument's envelope while the key is held, measured on the DSP once
 * per tick at `bpm` (ENVX, 0..127), for up to `maxTicks` ticks.
 */
export function measureEnvelope(ins: Instrument, bpm: number, maxTicks = 300): number[] {
  const dsp = new Dsp();
  // A silent looping block at $1000 keeps the voice running.
  dsp.ram[0x1000] = 0x03;
  dsp.ram.set([0x00, 0x10, 0x00, 0x10], 0x0200);
  dsp.write(FLG, 0x20);
  dsp.write(DIR, 0x02);
  dsp.write(KOFF, 0);
  const [a1, a2, g] = envelopeRegs(ins);
  dsp.write(V_SRCN, 0);
  dsp.write(V_ADSR1, a1);
  dsp.write(V_ADSR2, a2);
  dsp.write(V_GAIN, g);
  dsp.write(V_VOLL, 0);
  dsp.write(KON, 1);
  const perTick = tickUnits(bpm) * SAMPLES_PER_UNIT;
  const values: number[] = [];
  for (let t = 0; t < maxTicks; t++) {
    dsp.run(perTick);
    dsp.consume(perTick);
    values.push(dsp.read(V_ENVX));
  }
  return values;
}

/**
 * At most `max` points that follow the curve: the ends, then the points with
 * the largest error against a straight line, added one at a time.
 */
export function simplify(curve: number[], max = 12): EnvelopePoint[] {
  const idx = [0, curve.length - 1];
  while (idx.length < max) {
    let worst = -1;
    let worstErr = 1;
    for (let k = 0; k + 1 < idx.length; k++) {
      const a = idx[k];
      const b = idx[k + 1];
      for (let i = a + 1; i < b; i++) {
        const lin = curve[a] + ((curve[b] - curve[a]) * (i - a)) / (b - a);
        const err = Math.abs(curve[i] - lin);
        if (err > worstErr) {
          worstErr = err;
          worst = i;
        }
      }
    }
    if (worst < 0) break;
    idx.push(worst);
    idx.sort((x, y) => x - y);
  }
  return idx.map((i) => ({ tick: i, value: Math.round((curve[i] * 64) / 127) }));
}

/** XM fadeout (volume units of 1/65536 per tick) that matches the instrument's release. */
export function fadeout(ins: Instrument, bpm: number): number {
  const perTick = tickUnits(bpm) * SAMPLES_PER_UNIT;
  // Key off: -8 per sample from full (2047): about 256 samples. GAIN fade: about 1100 steps to near silence.
  const samples = ins.release > 0 ? 1100 * COUNTER_RATES[ins.release & 31] : 256;
  const ticks = Math.max(1, samples / perTick);
  return Math.min(0xfff, Math.round(32768 / ticks));
}

class Writer {
  private bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >> 8);
  }
  u32(v: number) {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }
  text(s: string, length: number) {
    for (let i = 0; i < length; i++) this.u8(i < s.length ? s.charCodeAt(i) & 0x7f : 0);
  }
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.u8(b[i]);
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0);
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

const xmVolume = (v: number) => Math.round((v * 64) / MAX_VOLUME);

/** Translate one effect; null when XM has nothing like it. */
export function translateEffect(effect: number, param: number, warn: Warnings): [number, number] | null {
  switch (effect) {
    case FX.ARPEGGIO:
    case FX.SLIDE_UP:
    case FX.SLIDE_DOWN:
    case FX.PORTAMENTO:
    case FX.PANNING:
    case FX.POSITION_JUMP:
    case FX.SET_SPEED:
      // Same units: slides are 1/16 semitone per tick in both.
      return [effect, param];
    case FX.VIBRATO:
      // XM's depth unit is twice ours.
      return [4, (param & 0xf0) | (param & 15 ? Math.max(1, Math.round((param & 15) / 2)) : 0)];
    case FX.VOLUME_SLIDE: {
      const half = (n: number) => (n ? Math.max(1, Math.round(n / 2)) : 0);
      return [0xa, (half(param >> 4) << 4) | half(param & 15)];
    }
    case FX.PATTERN_BREAK:
      // XM's row number is decimal.
      return [0xd, ((Math.floor(param / 10) % 10) << 4) | param % 10];
    case FX.NOTE_DELAY:
      if (param > 15) warn.add('note delays over F ticks');
      return [0xe, 0xd0 | Math.min(15, param)];
    case FX.NOTE_CUT:
      if (param > 15) warn.add('note cuts over F ticks');
      return [0xe, 0xc0 | Math.min(15, param)];
    case FX.VOICE_FLAGS: {
      const what = ['echo switches', 'pitch modulation', 'noise', 'surround'][param >> 4] ?? 'voice flags';
      warn.add(what);
      return null;
    }
    case FX.NOISE_CLOCK:
      warn.add('noise clock');
      return null;
    case FX.ECHO_VOLUME:
    case FX.ECHO_FEEDBACK:
      warn.add('echo changes');
      return null;
  }
  return null;
}

export function encodeXm(song: Song): { data: Uint8Array; warnings: string[] } {
  const warn = new Warnings();
  const w = new Writer();
  // Instruments 1..n as in the tracker, up to the last one with a sample.
  let count = 0;
  song.instruments.forEach((ins, i) => {
    if (ins.sample >= 0 && ins.sample < song.samples.length) count = i + 1;
  });
  count = Math.max(1, count);

  w.text('Extended Module: ', 17);
  w.text(song.title, 20);
  w.u8(0x1a);
  w.text('SNES Tracker', 20);
  w.u16(0x0104);
  w.u32(276);
  w.u16(song.order.length);
  w.u16(0); // restart position
  w.u16(CHANNEL_COUNT);
  w.u16(song.patterns.length);
  w.u16(count);
  w.u16(1); // linear frequency table
  w.u16(Math.min(31, song.speed));
  w.u16(song.bpm);
  for (let i = 0; i < 256; i++) w.u8(song.order[i] ?? 0);

  for (const pat of song.patterns) {
    const data: number[] = [];
    for (const row of pat.rows) {
      for (const c of row) {
        const note = c.note === NOTE_OFF ? XM_KEY_OFF : c.note === EMPTY ? 0 : c.note + 1;
        const instrument = c.instrument === EMPTY ? 0 : c.instrument + 1;
        const volume = c.volume === EMPTY ? 0 : 0x10 + xmVolume(c.volume);
        const fx = c.effect === EMPTY ? null : translateEffect(c.effect, c.param, warn);
        const fields = [note, instrument, volume, fx?.[0] ?? 0, fx?.[1] ?? 0];
        let mask = 0;
        fields.forEach((f, i) => f && (mask |= 1 << i));
        if (mask === 0x1f) data.push(...fields);
        else {
          data.push(0x80 | mask);
          for (const f of fields) if (f) data.push(f);
        }
      }
    }
    w.u32(9);
    w.u8(0);
    w.u16(pat.rows.length);
    w.u16(data.length);
    w.raw(data);
  }

  for (let i = 0; i < count; i++) {
    const ins = song.instruments[i];
    const sample = song.samples[ins.sample];
    if (!sample) {
      w.u32(29);
      w.text(ins.name, 22);
      w.u8(0);
      w.u16(0);
      continue;
    }
    if (ins.noise) warn.add('noise instruments');
    if (ins.pitchMod) warn.add('pitch modulation');
    if (ins.echo && (song.echo.volumeL || song.echo.volumeR)) warn.add('echo');
    const pcm = decodeSample(sample);
    const looped = sample.loop >= 0;
    const loopStart = looped ? Math.min(pcm.length, sample.loop * 16) : 0;
    const curve = measureEnvelope(ins, song.bpm);
    const flat = curve.every((v) => v === curve[0]);
    const env = flat ? [] : simplify(curve);
    // An envelope that ends above zero holds there while the key is down.
    const sustain = env.length && env[env.length - 1].value > 0;
    const { relativeNote, finetune } = xmTuning(sample.rate, ins.transpose + ins.finetune / 128);
    const volume = Math.round((xmVolume(ins.volume) * (flat ? curve[0] : 127)) / 127);

    w.u32(263);
    w.text(ins.name, 22);
    w.u8(0);
    w.u16(1);
    w.u32(40);
    w.zeros(96); // every note plays sample 0
    for (let p = 0; p < 12; p++) {
      w.u16(env[p]?.tick ?? 0);
      w.u16(env[p]?.value ?? 0);
    }
    w.zeros(48); // panning envelope
    w.u8(env.length);
    w.u8(0);
    w.u8(sustain ? env.length - 1 : 0); // volume sustain point
    w.zeros(2); // loop start, loop end
    w.zeros(3); // panning sustain, loop start, loop end
    w.u8(env.length ? 1 | (sustain ? 2 : 0) : 0);
    w.u8(0);
    w.zeros(4); // auto-vibrato
    w.u16(fadeout(ins, song.bpm));
    w.zeros(22);

    w.u32(pcm.length * 2);
    w.u32(loopStart * 2);
    w.u32(looped ? (pcm.length - loopStart) * 2 : 0);
    w.u8(Math.min(64, Math.max(0, volume)));
    w.u8(finetune);
    w.u8((looped ? 1 : 0) | 0x10); // 16-bit
    w.u8(ins.pan);
    w.u8(relativeNote);
    w.u8(0);
    w.text(sample.name, 22);
    let prev = 0;
    for (const s of pcm) {
      w.u16(s - prev);
      prev = s;
    }
  }
  return { data: w.done(), warnings: warn.list() };
}
