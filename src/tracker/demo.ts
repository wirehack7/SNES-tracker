import { NOTE_COUNT, noteName } from './notes';
import { FX, VOICE_FLAG } from './player';
import { EMPTY, NOTE_OFF, Song, clonePattern, createSong } from './song';

/** Note number of a name such as "C-4" or "A#3". */
export function noteNumber(name: string): number {
  for (let i = 0; i < NOTE_COUNT; i++) if (noteName(i) === name) return i;
  return EMPTY;
}

/** A short demo so the first visit makes a sound: strings, bass, drums and an echoing lead. */
export function demoSong(): Song {
  const s = createSong();
  s.title = 'Demo';
  s.bpm = 120;
  s.speed = 6;
  const ins = (name: string) => s.instruments.findIndex((i) => i.name === name);
  const n = noteNumber;
  const chords = [
    ['A-3', 'C-4', 'E-4', 'A-1'],
    ['F-3', 'A-3', 'C-4', 'F-1'],
    ['C-3', 'E-3', 'G-3', 'C-2'],
    ['G-3', 'B-3', 'D-4', 'G-1'],
  ];
  const lead = [
    'E-5', '', 'A-5', '', 'B-5', '', 'C-6', '', '', '', 'B-5', '', 'A-5', '', 'E-5', '',
    'F-5', '', '', '', 'A-5', '', 'C-6', '', 'D-6', '', 'C-6', '', 'A-5', '', '', '',
    'G-5', '', '', '', 'E-5', '', 'G-5', '', 'C-6', '', '', '', 'B-5', '', 'G-5', '',
    'D-5', '', '', '', 'G-5', '', 'B-5', '', 'D-6', '', '', '', 'B-5', '', '', '',
  ];
  const p0 = s.patterns[0];
  for (let r = 0; r < 64; r++) {
    const chord = chords[Math.floor(r / 16)];
    const row = p0.rows[r];
    if (r % 16 === 0) {
      for (let v = 0; v < 3; v++) Object.assign(row[1 + v], { note: n(chord[v]), instrument: ins('Strings'), volume: 0x50 });
      if (r === 0) Object.assign(row[1], { effect: FX.ECHO_VOLUME, param: 0x30 });
    }
    if (r % 16 === 14) for (let v = 0; v < 3; v++) row[1 + v].note = NOTE_OFF;
    // Bass: root on the beat, octave on the off-beat.
    if (r % 4 === 0) Object.assign(row[4], { note: n(chord[3]) + (r % 8 === 4 ? 12 : 0), instrument: ins('Bass') });
    if (r % 4 === 3) row[4].note = NOTE_OFF;
    // Drums
    if (r % 8 === 0 || r % 16 === 10) Object.assign(row[5], { note: n('C-4'), instrument: ins('Kick') });
    if (r % 8 === 4) Object.assign(row[6], { note: n('C-4'), instrument: ins('Snare') });
    if (r % 2 === 0) Object.assign(row[7], { note: n('C-4'), instrument: ins('Hi-hat'), volume: r % 4 === 0 ? 0x7f : 0x48 });
  }
  Object.assign(p0.rows[0][6], { note: n('C-4'), instrument: ins('Crash') });
  // Arpeggio on the first channel in the intro.
  for (let r = 0; r < 64; r += 16) {
    Object.assign(p0.rows[r][0], { note: n(chords[r / 16][0]) + 12, instrument: ins('Pulse 25%'), volume: 0x38, effect: FX.ARPEGGIO, param: 0x37 });
    for (let k = 1; k < 14; k++) Object.assign(p0.rows[r + k][0], { effect: FX.ARPEGGIO, param: 0x37 });
    p0.rows[r + 14][0].note = NOTE_OFF;
  }
  // Second pattern: the same with a lead melody (vibrato, echo).
  const p1 = clonePattern(p0);
  for (let r = 0; r < 64; r++) {
    const row = p1.rows[r];
    row[0] = { note: EMPTY, instrument: EMPTY, volume: EMPTY, effect: EMPTY, param: 0 };
    if (lead[r]) Object.assign(row[0], { note: n(lead[r]), instrument: ins('Saw'), volume: 0x60 });
    else if (r % 2 === 1 && lead[r - 1]) Object.assign(row[0], { effect: FX.VIBRATO, param: 0x64 });
  }
  Object.assign(p1.rows[0][0], { effect: FX.VOICE_FLAGS, param: (VOICE_FLAG.ECHO << 4) | 1 });
  p1.rows[63][0].note = NOTE_OFF;
  s.patterns.push(p1);
  s.order = [0, 1];
  return s;
}
