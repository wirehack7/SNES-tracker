import { describe, expect, it } from 'vitest';
import { EDL, ESA, KOFF, KON, NON, PMON, V_GAIN, V_PITCHH, V_PITCHL, V_SRCN, V_VOLL, V_VOLR } from '../../src/dsp/dsp';
import { SILENT_SRCN, echoStart, layoutAram } from '../../src/tracker/aram';
import { C4, noteFrequency, pitchFor, pitchRate } from '../../src/tracker/notes';
import { FX, Player, VOICE_FLAG, envelopeRegs, panVolumes, tickUnits } from '../../src/tracker/player';
import { EMPTY, NOTE_OFF, createSong, defaultInstrument } from '../../src/tracker/song';
import { frequency, renderLeft, songWith } from '../helpers';
import { Engine } from '../../src/audio/engine';

/** Records the register writes of a player, tick by tick. */
class Recorder {
  readonly ticks: Map<number, number>[] = [];
  private current = new Map<number, number>();
  write(addr: number, value: number) {
    this.current.set(addr, value);
  }
  next() {
    this.ticks.push(this.current);
    this.current = new Map();
  }
  /** The value register `reg` was last given, up to and including tick `tick`. */
  at(tick: number, reg: number): number | undefined {
    let v: number | undefined;
    for (let i = 0; i <= tick && i < this.ticks.length; i++) if (this.ticks[i].has(reg)) v = this.ticks[i].get(reg);
    return v;
  }
}

function play(song: ReturnType<typeof createSong>, ticks: number) {
  const rec = new Recorder();
  const player = new Player(song);
  player.start(rec);
  rec.next();
  for (let i = 0; i < ticks; i++) {
    player.tick(rec);
    rec.next();
  }
  return rec;
}

const voice = (ch: number, reg: number) => ch * 0x10 + reg;
const pitchAt = (rec: Recorder, tick: number, ch = 0) =>
  (rec.at(tick, voice(ch, V_PITCHL)) ?? 0) | ((rec.at(tick, voice(ch, V_PITCHH)) ?? 0) << 8);

describe('timing', () => {
  it('turns BPM into timer periods and samples per tick', () => {
    expect(tickUnits(120)).toBe(167);
    expect(tickUnits(150)).toBe(133);
    // A tick is 2.5 s / BPM, and a timer period is 125 µs.
    for (const bpm of [32, 100, 125, 255]) expect(tickUnits(bpm) * 0.000125).toBeCloseTo(2.5 / bpm, 3);
  });
});

describe('pitch', () => {
  it('plays a sample at its own rate on C-4', () => {
    expect(pitchFor(C4, 32000)).toBe(0x1000);
    expect(pitchFor(C4, 16000)).toBe(0x0800);
    expect(pitchFor(C4 + 12, 16000)).toBe(0x1000);
    expect(pitchFor(C4 - 12, 32000)).toBe(0x0800);
    expect(pitchRate(0x1000)).toBe(32000);
  });

  it('writes the pitch of the note the voice plays', () => {
    const song = songWith([{ row: 0, ch: 0, note: C4 + 12, instrument: 0 }]);
    song.samples[0].rate = 16000;
    const rec = play(song, 2);
    expect(pitchAt(rec, 1)).toBe(0x1000);
  });

  it('plays the written note at the right frequency', () => {
    for (const note of [C4 - 12, C4, C4 + 7]) {
      const song = songWith([{ row: 0, ch: 0, note, instrument: 5 }]); // Sine
      const engine = new Engine(song);
      engine.play();
      const samples = renderLeft(engine, 16000).slice(4000);
      expect(frequency(samples, 32000), `note ${note}`).toBeCloseTo(noteFrequency(note), -1);
    }
  });
});

describe('instrument registers', () => {
  it('turns ADSR and GAIN settings into the DSP registers', () => {
    const ins = defaultInstrument(0, 0);
    ins.envelope = 'adsr';
    ins.adsr = { attack: 10, decay: 5, sustain: 6, sustainRate: 17 };
    const [a1, a2, gain] = envelopeRegs(ins);
    expect(a1).toBe(0x80 | (5 << 4) | 10);
    expect(a2).toBe((6 << 5) | 17);
    // ADSR1 bit 7 is set, so the DSP ignores the GAIN register the tracker still writes.
    expect(gain).toBe(ins.gain);
    ins.envelope = 'gain';
    ins.gain = 0x9f;
    // GAIN mode: ADSR1 bit 7 is clear, so the DSP ignores ADSR and uses GAIN.
    expect(envelopeRegs(ins)).toEqual([0, (6 << 5) | 17, 0x9f]);
  });

  it('splits volume and pan into the two voice volumes', () => {
    expect(panVolumes(0x7f, 0x80)).toEqual([126, 127]); // centre
    const [l, r] = panVolumes(0x7f, 0);
    expect(l).toBe(0x7f);
    expect(r).toBe(0);
    const [l2, r2] = panVolumes(0x7f, 0xff);
    expect(l2).toBe(0);
    expect(r2).toBe(0x7f);
  });

  it('sets the sample, the envelope and the voice flags of the note it starts', () => {
    const song = createSong();
    song.instruments[1].sample = 1;
    song.instruments[1].noise = true;
    song.instruments[1].pitchMod = true;
    song.patterns[0].rows[0][1] = { note: C4, instrument: 1, volume: EMPTY, effect: EMPTY, param: 0 };
    const rec = play(song, 2);
    expect(rec.at(1, voice(1, V_SRCN))).toBe(1);
    expect(rec.at(1, NON)! & 2).toBe(2);
    expect(rec.at(1, PMON)! & 2).toBe(2);
    expect(rec.at(1, KON)).toBe(2);
  });

  it('starts no voice for an instrument without a sample', () => {
    const song = createSong();
    song.instruments[0].sample = -1;
    song.patterns[0].rows[0][0] = { note: C4, instrument: 0, volume: EMPTY, effect: EMPTY, param: 0 };
    const rec = play(song, 2);
    expect(rec.at(1, KON) ?? 0).toBe(0);
    // The layout still gives every unused directory entry the silent block.
    expect(SILENT_SRCN).toBe(63);
  });

  it('releases with KOFF, or with a GAIN fade when the instrument has a release', () => {
    const song = songWith([
      { row: 0, ch: 0, note: C4, instrument: 0 },
      { row: 1, ch: 0, note: NOTE_OFF },
    ]);
    // KOFF is a mask of every voice that is not playing; the note off adds voice 0 to it.
    song.instruments[0].release = 0;
    const off = play(song, song.speed + 2);
    expect(off.at(1, KOFF)! & 1).toBe(0);
    expect(off.at(song.speed + 1, KOFF)! & 1).toBe(1);

    song.instruments[0].release = 20;
    const rec = play(song, song.speed + 2);
    expect(rec.at(song.speed + 1, voice(0, V_GAIN))).toBe(0xa0 | 20);
    expect(rec.at(song.speed + 1, KOFF)! & 1).toBe(0);
  });
});

describe('effects', () => {
  const withEffect = (effect: number, param: number, ticks = 8, note = C4) =>
    play(
      songWith([
        { row: 0, ch: 0, note, instrument: 0 },
        { row: 1, ch: 0, effect, param },
      ]),
      ticks,
    );

  it('0xy arpeggio steps through the two offsets', () => {
    const song = songWith([{ row: 0, ch: 0, note: C4, instrument: 0, effect: FX.ARPEGGIO, param: 0x47 }]);
    const rec = play(song, 4);
    const base = pitchAt(rec, 1);
    expect(pitchAt(rec, 2) / base).toBeCloseTo(2 ** (4 / 12), 2);
    expect(pitchAt(rec, 3) / base).toBeCloseTo(2 ** (7 / 12), 2);
    expect(pitchAt(rec, 4)).toBe(base);
  });

  it('1xx and 2xx slide the pitch up and down', () => {
    const up = withEffect(FX.SLIDE_UP, 0x20, 10);
    expect(pitchAt(up, 9)).toBeGreaterThan(pitchAt(up, 6));
    const down = withEffect(FX.SLIDE_DOWN, 0x20, 10);
    expect(pitchAt(down, 9)).toBeLessThan(pitchAt(down, 6));
  });

  it('3xx slides towards the new note and stops there', () => {
    const song = songWith([
      { row: 0, ch: 0, note: C4, instrument: 0 },
      { row: 1, ch: 0, note: C4 + 12, instrument: 0, effect: FX.PORTAMENTO, param: 0x40 },
    ]);
    const rec = play(song, 60);
    const target = pitchFor(C4 + 12, song.samples[0].rate);
    expect(pitchAt(rec, 8)).toBeLessThan(target);
    expect(pitchAt(rec, 59)).toBe(target);
  });

  it('4xy vibrato swings around the note', () => {
    const rec = withEffect(FX.VIBRATO, 0x8f, 24);
    const pitches = Array.from({ length: 20 }, (_, i) => pitchAt(rec, i + 4));
    expect(Math.max(...pitches)).toBeGreaterThan(Math.min(...pitches));
  });

  it('5xy switches the voice flags', () => {
    const rec = withEffect(FX.VOICE_FLAGS, (VOICE_FLAG.NOISE << 4) | 1, 8);
    expect(rec.at(7, NON)! & 1).toBe(1);
    const off = withEffect(FX.VOICE_FLAGS, (VOICE_FLAG.NOISE << 4) | 0, 8);
    expect(off.at(7, NON)! & 1).toBe(0);
  });

  it('7xx delays the note and Exx cuts it', () => {
    const delayed = play(songWith([{ row: 0, ch: 0, note: C4, instrument: 0, effect: FX.NOTE_DELAY, param: 3 }]), 6);
    expect(delayed.at(2, KON) ?? 0).toBe(0);
    expect(delayed.at(4, KON)).toBe(1);

    const cut = play(songWith([{ row: 0, ch: 0, note: C4, instrument: 0, effect: FX.NOTE_CUT, param: 2 }]), 6);
    expect(cut.at(2, KOFF)! & 1).toBe(0);
    expect(cut.at(4, KOFF)! & 1).toBe(1);
  });

  it('8xx pans and Axy slides the volume', () => {
    const panned = withEffect(FX.PANNING, 0xff, 8);
    expect(panned.at(7, voice(0, V_VOLL))).toBe(0);
    expect(panned.at(7, voice(0, V_VOLR))).toBeGreaterThan(0);

    const down = withEffect(FX.VOLUME_SLIDE, 0x04, 12);
    expect(down.at(11, voice(0, V_VOLL))!).toBeLessThan(down.at(2, voice(0, V_VOLL))!);
  });

  it('9xx and Cxx change the echo while the song plays', () => {
    const song = songWith([
      { row: 0, ch: 0, note: C4, instrument: 0, effect: FX.ECHO_VOLUME, param: 0x40 },
      { row: 1, ch: 0, effect: FX.ECHO_FEEDBACK, param: 0x20 },
    ]);
    const rec = play(song, 12);
    expect(rec.at(11, 0x2c)).toBe(0x40); // EVOLL
    expect(rec.at(11, 0x3c)).toBe(0x40); // EVOLR
    expect(rec.at(11, 0x0d)).toBe(0x20); // EFB
  });

  it('Bxx jumps and Dxx breaks to another row', () => {
    const song = createSong();
    song.patterns.push(structuredClone(song.patterns[0]));
    song.order = [0, 1];
    song.patterns[0].rows[0][0] = { note: EMPTY, instrument: EMPTY, volume: EMPTY, effect: FX.PATTERN_BREAK, param: 8 };
    const player = new Player(song);
    const out = { write: () => {} };
    player.start(out);
    for (let i = 0; i < song.speed; i++) player.tick(out);
    expect(player.order).toBe(1);
    expect(player.row).toBe(8);

    song.patterns[1].rows[8][0] = { note: EMPTY, instrument: EMPTY, volume: EMPTY, effect: FX.POSITION_JUMP, param: 0 };
    for (let i = 0; i < song.speed; i++) player.tick(out);
    expect(player.order).toBe(0);
    expect(player.row).toBe(0);
  });

  it('Fxx sets the speed below 20 and the tempo from 20 up', () => {
    const song = songWith([
      { row: 0, ch: 0, effect: FX.SET_SPEED, param: 3 },
      { row: 1, ch: 0, effect: FX.SET_SPEED, param: 0x50 },
    ]);
    const player = new Player(song);
    const out = { write: () => {} };
    player.start(out);
    player.tick(out);
    expect(player.speed).toBe(3);
    for (let i = 0; i < 3; i++) player.tick(out);
    expect(player.units).toBe(tickUnits(0x50));
  });
});

describe('audio RAM layout', () => {
  it('puts the echo buffer at the top, 2 KiB per delay step', () => {
    expect(echoStart(0)).toBe(0xff00);
    expect(echoStart(1)).toBe(0x10000 - 0x800);
    expect(echoStart(15)).toBe(0x10000 - 15 * 0x800);
  });

  it('puts a silent block first and the samples after it', () => {
    const song = createSong();
    const layout = layoutAram(song);
    expect(layout.image[SILENT_SRCN * 4]).toBe(0x00); // every unused entry points at the silent block
    expect(layout.starts[0]).toBe(0x0500 + 9);
    expect(layout.end).toBeGreaterThan(layout.starts.at(-1)!);
    expect(layout.free).toBe(layout.echoStart - layout.end);
  });

  it('reports no room when the samples reach into the echo buffer', () => {
    const song = createSong();
    song.echo.delay = 15;
    song.samples.push({ name: 'big', brr: Buffer.alloc(30000, 2).toString('base64'), loop: -1, rate: 32000 });
    expect(layoutAram(song).free).toBeLessThan(0);
  });

  it('switches the echo writes off instead of overwriting the samples', () => {
    const song = createSong();
    song.echo.delay = 15;
    song.samples.push({ name: 'big', brr: Buffer.alloc(30000, 2).toString('base64'), loop: -1, rate: 32000 });
    const player = new Player(song);
    expect(player.echoWritable).toBe(false);
    const small = new Player(createSong());
    expect(small.echoWritable).toBe(true);
  });

  it('writes the echo settings of the song when it starts', () => {
    const song = createSong();
    song.echo.delay = 3;
    const rec = play(song, 1);
    expect(rec.at(0, EDL)).toBe(3);
    expect(rec.at(0, ESA)).toBe(echoStart(3) >> 8);
  });
});
