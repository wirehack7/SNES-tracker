import {
  DIR,
  EDL,
  EFB,
  EON,
  ESA,
  EVOLL,
  EVOLR,
  FIR,
  FLG,
  FLG_ECHO_OFF,
  KOFF,
  KON,
  MVOLL,
  MVOLR,
  NON,
  PMON,
  V_ADSR1,
  V_ADSR2,
  V_GAIN,
  V_PITCHH,
  V_PITCHL,
  V_SRCN,
  V_VOLL,
  V_VOLR,
} from '../dsp/dsp';
import { AramLayout, DIR_PAGE, SILENT_SRCN, layoutAram } from './aram';
import { C4, MAX_PITCH, NOTE_COUNT, noiseClockFor, pitchFor } from './notes';
import { CHANNEL_COUNT, Cell, EMPTY, Instrument, MAX_VOLUME, NOTE_OFF, Song } from './song';

/** Anything that accepts DSP register writes (the emulator, a logger, ...). */
export interface RegisterWriter {
  write(addr: number, value: number): void;
}

/** Effect numbers (first hex digit of the effect column). */
export const FX = {
  ARPEGGIO: 0x0,
  SLIDE_UP: 0x1,
  SLIDE_DOWN: 0x2,
  PORTAMENTO: 0x3,
  VIBRATO: 0x4,
  VOICE_FLAGS: 0x5,
  NOISE_CLOCK: 0x6,
  NOTE_DELAY: 0x7,
  PANNING: 0x8,
  ECHO_VOLUME: 0x9,
  VOLUME_SLIDE: 0xa,
  POSITION_JUMP: 0xb,
  ECHO_FEEDBACK: 0xc,
  PATTERN_BREAK: 0xd,
  NOTE_CUT: 0xe,
  SET_SPEED: 0xf,
} as const;

/** Sub-commands of 5xy (x), switched off with y = 0 and on with any other y. */
export const VOICE_FLAG = { ECHO: 0, PITCH_MOD: 1, NOISE: 2, SURROUND: 3 } as const;

/** DSP samples per timer period: the SPC700's timer 0 runs at 8 kHz, the DSP at 32 kHz. */
export const SAMPLES_PER_UNIT = 4;

/** Timer periods (125 µs) per tick at a tempo: 2.5 s / bpm per tick, as in FastTracker. */
export function tickUnits(bpm: number): number {
  return Math.round(20000 / bpm);
}

interface ChannelState {
  note: number;
  /** Current pitch in semitones with slides, without arpeggio and vibrato. */
  semi: number;
  instrument: number;
  /** Channel volume 0..127 (scales the instrument's volume). */
  volume: number;
  pan: number;
  echo: boolean;
  pitchMod: boolean;
  noise: boolean;
  surround: boolean;
  /** A note is playing (keyed on and not cut). */
  active: boolean;
  /** Key on at the end of this tick. */
  keyOn: boolean;
  effect: number;
  param: number;
  arpeggio: number;
  portaTarget: number;
  portaSpeed: number;
  vibSpeed: number;
  vibDepth: number;
  vibPhase: number;
  cutTick: number;
  delayed: Cell | null;
  delayTick: number;
}

function initialChannel(): ChannelState {
  return {
    note: EMPTY,
    semi: 0,
    instrument: 0,
    volume: MAX_VOLUME,
    pan: 128,
    echo: false,
    pitchMod: false,
    noise: false,
    surround: false,
    active: false,
    keyOn: false,
    effect: EMPTY,
    param: 0,
    arpeggio: 0,
    portaTarget: -1,
    portaSpeed: 0,
    vibSpeed: 0,
    vibDepth: 0,
    vibPhase: 0,
    cutTick: -1,
    delayed: null,
    delayTick: -1,
  };
}

const s8 = (v: number) => (v << 24) >> 24;
const u8 = (v: number) => v & 0xff;

/** ADSR1, ADSR2 and GAIN register values of an instrument. */
export function envelopeRegs(ins: Instrument): [number, number, number] {
  if (ins.envelope === 'gain') return [0, (ins.adsr.sustain << 5) | ins.adsr.sustainRate, ins.gain & 0xff];
  const a = ins.adsr;
  return [0x80 | ((a.decay & 7) << 4) | (a.attack & 15), ((a.sustain & 7) << 5) | (a.sustainRate & 31), ins.gain & 0xff];
}

/** Left and right voice volume for a volume (0..127) and pan (0..255, 128 centre). */
export function panVolumes(volume: number, pan: number): [number, number] {
  const l = Math.round((volume * Math.min(128, 255 - pan)) / 128);
  const r = Math.round((volume * Math.min(128, pan)) / 128);
  return [Math.min(127, l), Math.min(127, r)];
}

/**
 * Tick based song player. Every call to `tick()` corresponds to one timer
 * tick of a sound driver on the SPC700 and makes the DSP register writes that
 * driver would make. Writes of unchanged values are skipped (except KON), so
 * the register stream of the SPC export stays small.
 */
export class Player {
  order = 0;
  row = 0;
  tickInRow = 0;
  speed: number;
  bpm: number;
  playing = false;
  /** How often the song has looped (a row was reached a second time). */
  loops = 0;
  onRow?: (order: number, row: number) => void;
  /** Rows of a single pattern to loop (pattern play mode). */
  loopPattern = false;

  private channels: ChannelState[] = [];
  private visited = new Set<number>();
  private jumpOrder = -1;
  private breakRow = -1;
  private shadow = new Int16Array(128).fill(-1);
  private koff = 0;
  private noiseClock = 0;
  private echoVolume: [number, number];
  private echoFeedback: number;
  private layout: AramLayout;

  constructor(public song: Song) {
    this.speed = song.speed;
    this.bpm = song.bpm;
    this.layout = layoutAram(song);
    this.echoVolume = [song.echo.volumeL, song.echo.volumeR];
    this.echoFeedback = song.echo.feedback;
    this.reset();
  }

  /** Timer periods per tick at the current tempo. */
  get units() {
    return tickUnits(this.bpm);
  }

  private reset() {
    this.channels = Array.from({ length: CHANNEL_COUNT }, initialChannel);
    this.visited.clear();
    this.loops = 0;
    this.jumpOrder = -1;
    this.breakRow = -1;
    this.speed = this.song.speed;
    this.bpm = this.song.bpm;
    this.noiseClock = 0;
    this.echoVolume = [this.song.echo.volumeL, this.song.echo.volumeR];
    this.echoFeedback = this.song.echo.feedback;
  }

  private set(out: RegisterWriter, reg: number, value: number) {
    value &= 0xff;
    if (this.shadow[reg] === value) return;
    this.shadow[reg] = value;
    out.write(reg, value);
  }

  /** The register values the player has written (-1: never written). */
  registers(): Int16Array {
    return this.shadow.slice();
  }

  /** The echo unit may write its buffer only when it does not overlap the samples. */
  get echoWritable() {
    return this.layout.free >= 0;
  }

  /**
   * Sets every global register and silences all voices. Echo buffer writes
   * stay off while the echo registers change.
   */
  init(out: RegisterWriter) {
    this.shadow.fill(-1);
    const song = this.song;
    this.set(out, FLG, FLG_ECHO_OFF);
    this.koff = 0xff;
    this.set(out, KOFF, 0xff);
    this.set(out, MVOLL, song.volume);
    this.set(out, MVOLR, song.volume);
    this.set(out, DIR, DIR_PAGE);
    this.set(out, ESA, this.layout.esa);
    this.set(out, EDL, song.echo.delay);
    song.echo.fir.forEach((c, i) => this.set(out, FIR + i * 0x10, u8(c)));
    this.set(out, EFB, u8(this.echoFeedback));
    this.set(out, EVOLL, u8(this.echoVolume[0]));
    this.set(out, EVOLR, u8(this.echoVolume[1]));
    this.set(out, EON, 0);
    this.set(out, NON, 0);
    this.set(out, PMON, 0);
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const b = ch << 4;
      this.set(out, b + V_VOLL, 0);
      this.set(out, b + V_VOLR, 0);
    }
    this.writeFlags(out);
  }

  /** Main volume and echo settings from the song (after an edit). */
  applyGlobals(out: RegisterWriter) {
    const song = this.song;
    this.echoVolume = [song.echo.volumeL, song.echo.volumeR];
    this.echoFeedback = song.echo.feedback;
    this.set(out, MVOLL, song.volume);
    this.set(out, MVOLR, song.volume);
    song.echo.fir.forEach((c, i) => this.set(out, FIR + i * 0x10, u8(c)));
    this.set(out, EVOLL, u8(this.echoVolume[0]));
    this.set(out, EVOLR, u8(this.echoVolume[1]));
    this.set(out, EFB, u8(this.echoFeedback));
  }

  start(out: RegisterWriter, order = 0, row = 0) {
    this.reset();
    this.order = Math.max(0, Math.min(this.song.order.length - 1, order));
    this.row = Math.max(0, Math.min(this.pattern.rows.length - 1, row));
    this.tickInRow = 0;
    this.playing = true;
    this.init(out);
  }

  stop(out: RegisterWriter) {
    this.playing = false;
    for (const st of this.channels) {
      st.active = false;
      st.keyOn = false;
      st.cutTick = -1;
      st.delayed = null;
    }
    this.koff = 0xff;
    this.set(out, KOFF, 0xff);
  }

  get pattern() {
    return this.song.patterns[this.song.order[this.order]] ?? this.song.patterns[0];
  }

  tick(out: RegisterWriter) {
    if (!this.playing) {
      // Keep previewed notes' per-tick effects (e.g. note cut) alive.
      for (let ch = 0; ch < CHANNEL_COUNT; ch++) this.update(out, ch, 1);
      this.flush(out);
      return;
    }
    if (this.tickInRow === 0) this.startRow(out);
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const st = this.channels[ch];
      if (st.delayed && this.tickInRow === st.delayTick) {
        this.applyCell(out, ch, st.delayed);
        st.delayed = null;
      }
      this.update(out, ch, this.tickInRow);
    }
    this.flush(out);
    if (++this.tickInRow >= this.speed) {
      this.tickInRow = 0;
      this.advance();
    }
  }

  private startRow(out: RegisterWriter) {
    const key = (this.order << 8) | this.row;
    if (this.visited.has(key)) {
      this.loops++;
      this.visited.clear();
    }
    this.visited.add(key);
    this.onRow?.(this.order, this.row);
    const cells = this.pattern.rows[this.row];
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const cell = cells[ch];
      const st = this.channels[ch];
      st.delayed = null;
      if (cell.effect === FX.NOTE_DELAY && cell.param > 0) {
        st.delayed = cell;
        st.delayTick = cell.param;
        continue;
      }
      this.applyCell(out, ch, cell);
    }
  }

  private advance() {
    const rows = this.pattern.rows.length;
    if (this.jumpOrder >= 0 || this.breakRow >= 0) {
      if (!this.loopPattern) {
        this.order = this.jumpOrder >= 0 ? this.jumpOrder : this.order + 1;
        if (this.order >= this.song.order.length) this.order = 0;
      }
      this.row = Math.max(0, this.breakRow);
      if (this.row >= this.pattern.rows.length) this.row = 0;
      this.jumpOrder = this.breakRow = -1;
      return;
    }
    if (++this.row >= rows) {
      this.row = 0;
      if (!this.loopPattern && ++this.order >= this.song.order.length) this.order = 0;
    }
  }

  /** Instrument used for sample previews (instrument index -1). */
  private previewInstrument: Instrument | null = null;

  private instrumentOf(st: ChannelState): Instrument {
    if (st.instrument < 0 && this.previewInstrument) return this.previewInstrument;
    return this.song.instruments[st.instrument] ?? this.song.instruments[0];
  }

  /** The instrument plays something: a sample, or the noise generator. */
  private audible(ins: Instrument) {
    return ins.noise || (ins.sample >= 0 && ins.sample < this.song.samples.length);
  }

  private loadInstrument(ch: number, index: number) {
    const st = this.channels[ch];
    st.instrument = index;
    const ins = this.instrumentOf(st);
    st.volume = MAX_VOLUME;
    st.pan = ins.pan;
    st.echo = ins.echo;
    st.noise = ins.noise;
    st.pitchMod = ins.pitchMod && ch > 0;
    st.surround = false;
  }

  /** Apply a row's cell to a channel (note, instrument, volume, effect). */
  private applyCell(out: RegisterWriter, ch: number, cell: Cell) {
    const st = this.channels[ch];
    st.effect = cell.effect;
    st.param = cell.param;
    st.cutTick = -1;

    if (cell.instrument !== EMPTY) this.loadInstrument(ch, cell.instrument);

    if (cell.note === NOTE_OFF) {
      this.release(out, ch);
    } else if (cell.note !== EMPTY) {
      if (cell.effect === FX.PORTAMENTO && st.active) {
        st.portaTarget = cell.note;
        st.note = cell.note;
      } else {
        if (cell.instrument === EMPTY) this.loadInstrument(ch, st.instrument);
        this.noteOn(ch, cell.note);
      }
    }

    if (cell.volume !== EMPTY) st.volume = cell.volume;

    const p = cell.param;
    switch (cell.effect) {
      case FX.ARPEGGIO:
        st.arpeggio = p;
        break;
      case FX.PORTAMENTO:
        if (p) st.portaSpeed = p;
        break;
      case FX.VIBRATO:
        if (p >> 4) st.vibSpeed = p >> 4;
        if (p & 15) st.vibDepth = p & 15;
        break;
      case FX.VOICE_FLAGS: {
        const on = (p & 15) !== 0;
        if (p >> 4 === VOICE_FLAG.ECHO) st.echo = on;
        else if (p >> 4 === VOICE_FLAG.PITCH_MOD) st.pitchMod = on && ch > 0;
        else if (p >> 4 === VOICE_FLAG.NOISE) st.noise = on;
        else if (p >> 4 === VOICE_FLAG.SURROUND) st.surround = on;
        break;
      }
      case FX.NOISE_CLOCK:
        this.noiseClock = p & 0x1f;
        break;
      case FX.PANNING:
        st.pan = p;
        break;
      case FX.ECHO_VOLUME:
        this.echoVolume = [s8(p), s8(p)];
        break;
      case FX.POSITION_JUMP:
        if (this.playing) this.jumpOrder = p;
        break;
      case FX.ECHO_FEEDBACK:
        this.echoFeedback = s8(p);
        break;
      case FX.PATTERN_BREAK:
        if (this.playing) this.breakRow = p;
        break;
      case FX.NOTE_CUT:
        st.cutTick = p;
        break;
      case FX.SET_SPEED:
        if (p >= 0x20) this.bpm = p;
        else if (p > 0) this.speed = p;
        break;
    }
    if (cell.effect !== FX.ARPEGGIO) st.arpeggio = 0;
  }

  private noteOn(ch: number, note: number) {
    const st = this.channels[ch];
    const ins = this.instrumentOf(st);
    st.note = note;
    st.semi = note;
    st.vibPhase = 0;
    st.portaTarget = -1;
    if (!this.audible(ins)) {
      st.active = false;
      return;
    }
    if (st.noise) this.noiseClock = noiseClockFor(note);
    st.keyOn = true;
    st.active = true;
  }

  /** Note off: the hardware's key off, or the instrument's GAIN fade. */
  private release(out: RegisterWriter, ch: number) {
    const st = this.channels[ch];
    const ins = this.instrumentOf(st);
    st.keyOn = false;
    if (ins.release > 0 && st.active) {
      const b = ch << 4;
      this.set(out, b + V_ADSR1, 0);
      this.set(out, b + V_GAIN, 0xa0 | (ins.release & 31));
      return;
    }
    st.active = false;
    this.koff |= 1 << ch;
  }

  private cut(ch: number) {
    const st = this.channels[ch];
    st.active = false;
    st.keyOn = false;
    this.koff |= 1 << ch;
  }

  /** Per-tick processing: effects, then the voice's register writes. */
  private update(out: RegisterWriter, ch: number, tick: number) {
    const st = this.channels[ch];
    if (st.cutTick >= 0 && tick === st.cutTick) {
      this.cut(ch);
      st.cutTick = -1;
    }
    if (st.note < 0) return;

    if (tick > 0) {
      if (st.effect === FX.SLIDE_UP) st.semi = Math.min(NOTE_COUNT + 24, st.semi + st.param / 16);
      else if (st.effect === FX.SLIDE_DOWN) st.semi = Math.max(-24, st.semi - st.param / 16);
      else if (st.effect === FX.PORTAMENTO && st.portaTarget >= 0) {
        const d = st.portaTarget - st.semi;
        st.semi += Math.sign(d) * Math.min(Math.abs(d), st.portaSpeed / 16);
        if (st.semi === st.portaTarget) st.portaTarget = -1;
      }
      if (st.effect === FX.VOLUME_SLIDE)
        st.volume = Math.max(0, Math.min(MAX_VOLUME, st.volume + (st.param >> 4) - (st.param & 15)));
    }

    let semi = st.semi;
    if (st.arpeggio) semi += [0, st.arpeggio >> 4, st.arpeggio & 15][tick % 3];
    if (st.effect === FX.VIBRATO && st.vibDepth) {
      if (tick > 0) st.vibPhase = (st.vibPhase + st.vibSpeed) & 63;
      semi += (Math.sin((st.vibPhase / 64) * Math.PI * 2) * st.vibDepth) / 16;
    }
    this.writeVoice(out, ch, semi);
  }

  private writeVoice(out: RegisterWriter, ch: number, semi: number) {
    const st = this.channels[ch];
    const ins = this.instrumentOf(st);
    const b = ch << 4;
    const sample = this.song.samples[ins.sample];
    const srcn = sample ? ins.sample : SILENT_SRCN;
    const pitch = sample ? pitchFor(semi + ins.transpose + ins.finetune / 128, sample.rate) : 0x1000;
    if (st.keyOn) {
      // A new note: sample and envelope are rewritten, whatever the shadow says.
      for (const r of [V_SRCN, V_ADSR1, V_ADSR2, V_GAIN]) this.shadow[b + r] = -1;
      this.set(out, b + V_SRCN, srcn);
      const [a1, a2, g] = envelopeRegs(ins);
      this.set(out, b + V_ADSR1, a1);
      this.set(out, b + V_ADSR2, a2);
      this.set(out, b + V_GAIN, g);
    }
    const [l, r] = panVolumes(Math.round((ins.volume * st.volume) / MAX_VOLUME), st.pan);
    this.set(out, b + V_VOLL, l);
    this.set(out, b + V_VOLR, st.surround ? -r : r);
    const p = Math.min(MAX_PITCH, pitch);
    this.set(out, b + V_PITCHL, p & 0xff);
    this.set(out, b + V_PITCHH, p >> 8);
  }

  private writeFlags(out: RegisterWriter) {
    this.set(out, FLG, (this.noiseClock & 0x1f) | (this.echoWritable ? 0 : FLG_ECHO_OFF));
  }

  /** End of a tick: global registers, voice flags, key off and key on. */
  private flush(out: RegisterWriter) {
    let eon = 0;
    let non = 0;
    let pmon = 0;
    let kon = 0;
    this.channels.forEach((st, ch) => {
      if (st.echo) eon |= 1 << ch;
      if (st.noise) non |= 1 << ch;
      if (st.pitchMod) pmon |= 1 << ch;
      if (st.keyOn) {
        kon |= 1 << ch;
        st.keyOn = false;
      }
    });
    this.set(out, EVOLL, u8(this.echoVolume[0]));
    this.set(out, EVOLR, u8(this.echoVolume[1]));
    this.set(out, EFB, u8(this.echoFeedback));
    this.writeFlags(out);
    this.set(out, EON, eon);
    this.set(out, NON, non);
    this.set(out, PMON, pmon);
    this.koff &= ~kon;
    this.set(out, KOFF, this.koff);
    if (kon) {
      out.write(KON, kon);
      this.shadow[KON] = kon;
    }
  }

  /** Play a single note immediately (note entry / jamming). */
  preview(out: RegisterWriter, ch: number, note: number, instrument: number) {
    const st = this.channels[ch];
    if (!this.playing) {
      st.effect = EMPTY;
      st.arpeggio = 0;
      st.cutTick = -1;
    }
    this.loadInstrument(ch, instrument);
    this.noteOn(ch, note);
    this.writeVoice(out, ch, st.semi);
    this.flush(out);
  }

  /** Play a sample on its own at full volume (sample list preview). */
  previewSample(out: RegisterWriter, ch: number, sample: number, note = C4) {
    const ins = this.song.instruments[0];
    this.previewInstrument = {
      ...ins,
      name: '',
      sample,
      volume: 110,
      pan: 128,
      transpose: 0,
      finetune: 0,
      envelope: 'adsr',
      adsr: { attack: 15, decay: 7, sustain: 7, sustainRate: 0 },
      release: 0,
      echo: false,
      noise: false,
      pitchMod: false,
    };
    const st = this.channels[ch];
    st.effect = EMPTY;
    st.arpeggio = 0;
    st.cutTick = -1;
    this.loadInstrument(ch, -1);
    this.noteOn(ch, note);
    this.writeVoice(out, ch, st.semi);
    this.flush(out);
  }

  /** Stop a previewed note. */
  releasePreview(out: RegisterWriter, ch: number) {
    this.release(out, ch);
    this.flush(out);
  }

  /** The song was edited: keep the position but pick up the new data. */
  setSong(song: Song) {
    this.song = song;
    this.layout = layoutAram(song);
    if (this.order >= song.order.length) this.order = 0;
    if (this.row >= this.pattern.rows.length) this.row = 0;
  }
}
