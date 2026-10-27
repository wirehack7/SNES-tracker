import { describe, expect, it } from 'vitest';
import { DIR } from '../../src/dsp/dsp';
import { buildSpc } from '../../src/export/spc';
import { SPC_SIZE } from '../../src/export/spcimport';
import { SpcCapture, SpcNote, captureSpc, fitGrid, importSpc, rowIndexer, rowLength, songFromCapture, tempoFor, volumePan } from '../../src/spc/transcribe';
import { FX } from '../../src/tracker/player';
import { noiseClockFor } from '../../src/tracker/notes';
import { DIR_PAGE } from '../../src/tracker/aram';
import { demoSong } from '../../src/tracker/demo';
import { pitchFor } from '../../src/tracker/notes';
import { tickUnits } from '../../src/tracker/player';
import { EMPTY, NOTE_OFF, Song } from '../../src/tracker/song';
import { songWith } from '../helpers';

/** The SPC of a song without its song chunk, as from any other player or game. */
function foreign(song: Song) {
  const data = buildSpc(song).data.slice(0, SPC_SIZE);
  data[0x10100 + DIR] = DIR_PAGE;
  return data;
}

/** Seconds a song takes to play once. */
const seconds = (song: Song) => (song.order.length * 64 * song.speed * tickUnits(song.bpm) * 4) / 32000;

/** Pitch register value a cell plays (its note through the instrument's tuning and the sample's rate). */
function pitchOf(song: Song, note: number, instrument: number) {
  const ins = song.instruments[instrument];
  return pitchFor(note + ins.transpose + ins.finetune / 128, song.samples[ins.sample].rate);
}

interface Played {
  row: number;
  ch: number;
  pitch: number;
}

function notesOf(song: Song): Played[] {
  const out: Played[] = [];
  const last: number[] = [];
  song.order.forEach((p, o) =>
    song.patterns[p].rows.forEach((r, row) =>
      r.forEach((c, ch) => {
        if (c.instrument !== EMPTY) last[ch] = c.instrument;
        if (c.note >= 0) out.push({ row: o * 64 + row, ch, pitch: pitchOf(song, c.note, last[ch]) });
      }),
    ),
  );
  return out;
}

describe('SPC transcription', () => {
  it('writes down the notes, rows and pitches of an SPC played by its own driver', async () => {
    const song = songWith([
      { row: 1, ch: 0, note: 48, instrument: 0 },
      { row: 3, ch: 1, note: 55, instrument: 3, volume: 0x40 },
      { row: 4, ch: 0, note: 60, instrument: 0 },
      { row: 7, ch: 2, note: 36, instrument: 7 },
      { row: 8, ch: 0, note: NOTE_OFF },
      { row: 9, ch: 0, note: 50, instrument: 5 },
      { row: 13, ch: 1, note: 57, instrument: 3 },
      { row: 15, ch: 3, note: 62, instrument: 0 },
      { row: 20, ch: 1, note: 59, instrument: 3 },
      { row: 23, ch: 0, note: 43, instrument: 0 },
      { row: 30, ch: 2, note: 40, instrument: 7 },
      { row: 31, ch: 0, note: 45, instrument: 0 },
    ]);
    const result = await importSpc(foreign(song), 'test', { seconds: seconds(song) });
    expect(result.embedded).toBe(false);
    const original = notesOf(song);
    const found = notesOf(result.song);
    expect(result.notes).toBe(original.length);
    // The transcription starts at the first note.
    const shift = original[0].row;
    expect(found.map((n) => [n.row + shift, n.ch])).toEqual(original.map((n) => [n.row, n.ch]));
    found.forEach((n, i) => expect(Math.abs(n.pitch / original[i].pitch - 1), `note ${i}`).toBeLessThan(0.005));
    // Row length and tempo follow the song's.
    const rowSamples = song.speed * tickUnits(song.bpm) * 4;
    expect(result.song.speed * tickUnits(result.song.bpm) * 4).toBeCloseTo(rowSamples, -1);
    // The key-off, the volume and the instruments (sample, ADSR) come along.
    const cells = result.song.patterns[0].rows;
    expect(cells[8 - shift][0].note).toBe(NOTE_OFF);
    // The volume the voice had: instrument volume × volume column.
    expect(cells[3 - shift][1].volume).toBe(Math.round((song.instruments[3].volume * 0x40) / 127));
    const ins = result.song.instruments[cells[3 - shift][1].instrument];
    expect(ins.adsr).toEqual(song.instruments[3].adsr);
    expect(result.song.title).toBe(song.title);
  });

  it('recovers nearly every note of the demo song', async () => {
    const song = demoSong();
    const result = await importSpc(foreign(song), 'demo', { seconds: seconds(song) });
    const original = notesOf(song);
    const found = notesOf(result.song);
    const shift = original[0].row;
    const key = (n: Played) => `${n.row}:${n.ch}`;
    const byPos = new Map(found.map((n) => [`${n.row + shift}:${n.ch}`, n]));
    let matched = 0;
    for (const n of original) {
      const f = byPos.get(key(n));
      if (f && Math.abs(f.pitch / n.pitch - 1) < 0.005) matched++;
    }
    expect(matched / original.length).toBeGreaterThan(0.95);
    // Echo and main volume as the driver set them.
    expect(result.song.echo.delay).toBe(song.echo.delay);
    expect(result.song.echo.fir).toEqual(song.echo.fir);
  });

  it('reports progress and gives the samples only when the driver plays nothing', async () => {
    const data = foreign(demoSong());
    // The driver never starts: an endless loop at its entry.
    data[0x100 + 0x0200] = 0x2f;
    data[0x100 + 0x0201] = 0xfe;
    const progress: number[] = [];
    const result = await importSpc(data, 'idle', { seconds: 2, onProgress: (p) => progress.push(p) });
    expect(result.notes).toBe(0);
    expect(result.samples).toBeGreaterThan(5);
    expect(progress.at(-1)).toBe(1);
  });

  it('opens the tracker’s own SPC as the song without running it', async () => {
    const song = demoSong();
    const result = await importSpc(buildSpc(song).data);
    expect(result.embedded).toBe(true);
    expect(result.song.patterns).toEqual(song.patterns);
  });

  it('captures key-on, key-off and volume changes with their times', async () => {
    const song = songWith([
      { row: 0, ch: 2, note: 48, instrument: 0 },
      { row: 2, ch: 2, note: NOTE_OFF },
      { row: 4, ch: 2, note: 48, instrument: 0, volume: 0x20 },
    ]);
    const cap = await captureSpc(foreign(song), { seconds: 1 });
    const row = song.speed * tickUnits(song.bpm) * 4;
    expect(cap.notes.map((n) => n.voice)).toEqual([2, 2]);
    expect(cap.notes[1].time - cap.notes[0].time).toBeCloseTo(4 * row, -2);
    expect(cap.offs.some((o) => o.voice === 2 && Math.abs(o.time - cap.notes[0].time - 2 * row) < 200)).toBe(true);
    expect(cap.volumes.some((v) => v.voice === 2)).toBe(true);
    expect(cap.length).toBe(32000);
    const { song: out } = songFromCapture(cap, foreign(song).subarray(0x100, 0x10100));
    expect(out.patterns[0].rows[4][2].volume).toBe(Math.round((song.instruments[0].volume * 0x20) / 127));
  });
});

describe('notes from a capture', () => {
  const data = foreign(demoSong());
  const ram = data.subarray(0x100, 0x10100);
  const regs = data.slice(0x10100, 0x10180);
  regs[DIR] = DIR_PAGE;
  const note = (time: number, voice: number, patch: Partial<SpcNote> = {}): SpcNote => ({
    time, voice, srcn: 0, pitch: 0x1000, volL: 0x40, volR: 0x40, adsr1: 0x8f, adsr2: 0xe0, gain: 0, echo: false, noise: false, noiseClock: 0, ...patch,
  });
  const capture = (notes: SpcNote[], extra: Partial<SpcCapture> = {}): SpcCapture => ({ notes, offs: [], volumes: [], length: 64000, regs, ...extra });

  it('writes panning, noise notes and the GAIN envelope', () => {
    const clock = noiseClockFor(60);
    const { song } = songFromCapture(
      capture([
        note(0, 0, { volL: 0x40, volR: 0x10 }),
        note(1000, 1, { noise: true, noiseClock: clock }),
        note(2000, 2, { srcn: 1, adsr1: 0, gain: 0x50 }),
        note(3000, 3, { volL: 0x10, volR: 0x40 }),
        // Panned, then centred within the same row: no panning left.
        note(4000, 0, { volL: 0x40, volR: 0 }),
        note(4100, 0),
      ]),
      ram,
      1000,
    );
    const rows = song.patterns[0].rows;
    expect([rows[0][0].effect, rows[0][0].param]).toEqual([FX.PANNING, 32]);
    expect(rows[3][3].param).toBe(223);
    expect(rows[4][0].effect).toBe(EMPTY);
    const noise = song.instruments[rows[1][1].instrument];
    expect(noise.noise).toBe(true);
    expect(noiseClockFor(rows[1][1].note)).toBe(clock);
    const gain = song.instruments[rows[2][2].instrument];
    expect([gain.envelope, gain.gain]).toEqual(['gain', 0x50]);
  });

  it('transposes instruments whose notes leave the note range and skips what cannot play', () => {
    const { song, notes } = songFromCapture(
      capture(
        [
          note(0, 0, { pitch: 0x3fff, srcn: 0 }),
          note(1000, 0, { pitch: 0x3000, srcn: 0 }),
          note(2000, 1, { pitch: 0 }), // silent
          note(3000, 2, { srcn: 60 }), // the silent block, no sample
          note(4000, 3, { srcn: 0, pitch: 4 }),
        ],
        { offs: [{ time: 500, voice: 5 }], volumes: [{ time: 1500, voice: 0, volL: 0x10, volR: 0x10 }, { time: 1600, voice: 6, volL: 1, volR: 1 }] },
      ),
      ram,
      1000,
    );
    expect(notes).toBe(3);
    const ins = song.instruments[0];
    const rows = song.patterns[0].rows;
    // Pitches beyond B-7 and below C-0 for the same sample: the notes are clamped after the transposition.
    expect(ins.transpose).not.toBe(0);
    expect(rows[0][0].note).toBeLessThan(96);
    expect(rows[2][0].volume).toBe(0x10);
    expect(rows[0][5].note).toBe(EMPTY); // key-off of a voice that never played
    expect(rows[2][1].note).toBe(EMPTY);
    expect(rows[3][2].note).toBe(EMPTY);
  });
});

describe('row grid', () => {
  const jitter = (i: number) => ((i * 37) % 64) - 32;

  it('finds the longest row that fits every note, with timer jitter', () => {
    // Notes on rows 0, 1, 3, 4, 6, … of 819 samples, each up to 32 samples off.
    const times = Array.from({ length: 200 }, (_, i) => 5000 + Math.floor(i * 1.5) * 819 + jitter(i));
    const g = fitGrid(times);
    expect(g.row).toBeCloseTo(819, 0);
    expect(g.error * g.row).toBeLessThan(40);
    // On every other row only: twice the row.
    const even = Array.from({ length: 100 }, (_, i) => i * 2 * 900 + jitter(i));
    expect(fitGrid(even).row).toBeCloseTo(1800, 0);
  });

  it('keeps rows over a long song whose timing drifts and jumps', () => {
    const times: number[] = [];
    let t = 0;
    for (let i = 0; i < 2000; i++) {
      times.push(Math.round(t) + jitter(i));
      t += 819.4 * (i % 3 === 0 ? 2 : 1);
      if (i === 1000) t += 300; // the loop restarts off the old grid
    }
    const row = rowLength(times);
    expect(row).toBeCloseTo(819.4, 0);
    const rowOf = rowIndexer(times, row);
    expect(rowOf(times[0])).toBe(0);
    expect(rowOf(times[1])).toBe(2);
    // Every note on its own row, in order, after the jump too.
    const rows = times.map(rowOf);
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeGreaterThan(rows[i - 1]);
    expect(rows[1002] - rows[1001]).toBeGreaterThanOrEqual(1);
    expect(rowOf(times[0] - 819)).toBe(-1);
  });

  it('falls back to a default grid with too few notes', () => {
    expect(fitGrid([100]).row).toBe(4000);
    expect(rowIndexer([], 1000)(2600)).toBe(3);
  });

  it('turns a row length into speed and BPM', () => {
    for (const row of [819, 3840, 6000, 12000, 1640]) {
      const { speed, bpm } = tempoFor(row);
      expect(Math.abs(speed * tickUnits(bpm) * 4 - row) / row).toBeLessThan(0.01);
    }
  });

  it('turns voice volumes into volume and panning', () => {
    expect(volumePan(0x40, 0x40)).toEqual({ volume: 0x40, pan: 128 });
    expect(volumePan(0x40, 0)).toEqual({ volume: 0x40, pan: 0 });
    expect(volumePan(0, 0x40)).toEqual({ volume: 0x40, pan: 255 });
    expect(volumePan(0x40, 0x20).pan).toBe(64);
    expect(volumePan(0xc0, 0xc0)).toEqual({ volume: 0x40, pan: 128 }); // surround: the size counts
    expect(volumePan(0, 0)).toEqual({ volume: 0, pan: 128 });
  });
});
