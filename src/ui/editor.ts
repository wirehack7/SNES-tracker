import { NOTE_COUNT, noteName } from '../tracker/notes';
import { CHANNEL_COUNT, Cell, EMPTY, INSTRUMENT_COUNT, MAX_VOLUME, NOTE_OFF, Pattern, emptyCell } from '../tracker/song';

/** Editable fields of a cell: note, instrument (2 digits), volume (2 digits), effect, param high, param low. */
export const FIELDS = ['note', 'insHi', 'insLo', 'volHi', 'volLo', 'effect', 'paramHi', 'paramLo'] as const;
export type Field = (typeof FIELDS)[number];
export const FIELD_COUNT = FIELDS.length;

export interface Cursor {
  row: number;
  ch: number;
  field: number;
}

/** Physical key codes to semitone offsets (layout independent, works on QWERTZ too). */
export const NOTE_KEYS: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21,
  Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

export const MIN_OCTAVE = 0;
export const MAX_OCTAVE = 7;

export function noteFromKey(code: string, octave: number): number | null {
  const offset = NOTE_KEYS[code];
  if (offset === undefined) return null;
  const note = octave * 12 + offset;
  return note >= 0 && note < NOTE_COUNT ? note : null;
}

const hex = (v: number) => v.toString(16).toUpperCase();
const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

/** Text of the groups of a cell as shown in the pattern view: note, instrument, volume, effect, param. */
export function formatCell(c: Cell): string[] {
  const note = c.note === NOTE_OFF ? '===' : c.note === EMPTY ? '---' : noteName(c.note);
  const fx = c.effect === EMPTY;
  return [
    note,
    c.instrument === EMPTY ? '--' : hex2(c.instrument + 1),
    c.volume === EMPTY ? '--' : hex2(c.volume),
    fx ? '-' : hex(c.effect),
    fx ? '--' : hex2(c.param),
  ];
}

/** Group (0 note, 1 instrument, 2 volume, 3 effect, 4 param) and digit of a field. */
export function fieldGroup(field: number): [number, number] {
  return [[0, 0], [1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [4, 0], [4, 1]][field] as [number, number];
}

export function moveCursor(cur: Cursor, rows: number, dRow: number, dField = 0): Cursor {
  let field = cur.field + dField;
  let ch = cur.ch;
  while (field < 0) {
    field += FIELD_COUNT;
    ch = (ch + CHANNEL_COUNT - 1) % CHANNEL_COUNT;
  }
  while (field >= FIELD_COUNT) {
    field -= FIELD_COUNT;
    ch = (ch + 1) % CHANNEL_COUNT;
  }
  const row = (((cur.row + dRow) % rows) + rows) % rows;
  return { row, ch, field };
}

export function jumpChannel(cur: Cursor, dCh: number): Cursor {
  return { ...cur, ch: (cur.ch + dCh + CHANNEL_COUNT) % CHANNEL_COUNT, field: 0 };
}

/** Enter a hex digit (0-15) into a non-note field. Returns false if nothing changed. */
export function enterDigit(c: Cell, field: number, digit: number): boolean {
  switch (FIELDS[field]) {
    case 'insHi': {
      // Instruments are shown 01..20; the digits set the displayed number.
      const shown = c.instrument === EMPTY ? 0 : c.instrument + 1;
      const v = Math.min(INSTRUMENT_COUNT, (digit << 4) | (shown & 15));
      c.instrument = v === 0 ? EMPTY : v - 1;
      return true;
    }
    case 'insLo': {
      const shown = c.instrument === EMPTY ? 0 : c.instrument + 1;
      const v = Math.min(INSTRUMENT_COUNT, (shown & 0xf0) | digit);
      c.instrument = v === 0 ? EMPTY : v - 1;
      return true;
    }
    case 'volHi': {
      const cur = c.volume === EMPTY ? 0 : c.volume;
      c.volume = Math.min(MAX_VOLUME, (digit << 4) | (cur & 15));
      return true;
    }
    case 'volLo': {
      const cur = c.volume === EMPTY ? 0 : c.volume;
      c.volume = Math.min(MAX_VOLUME, (cur & 0xf0) | digit);
      return true;
    }
    case 'effect':
      c.effect = digit;
      return true;
    case 'paramHi':
      if (c.effect === EMPTY) c.effect = 0;
      c.param = (digit << 4) | (c.param & 15);
      return true;
    case 'paramLo':
      if (c.effect === EMPTY) c.effect = 0;
      c.param = (c.param & 0xf0) | digit;
      return true;
  }
  return false;
}

export function enterNote(c: Cell, note: number, instrument: number) {
  c.note = note;
  if (note !== NOTE_OFF) c.instrument = instrument;
}

/** Clear the field under the cursor; on the note column the whole note/instrument/volume. */
export function clearField(c: Cell, field: number) {
  switch (FIELDS[field]) {
    case 'note':
      c.note = EMPTY;
      c.instrument = EMPTY;
      c.volume = EMPTY;
      break;
    case 'insHi':
    case 'insLo':
      c.instrument = EMPTY;
      break;
    case 'volHi':
    case 'volLo':
      c.volume = EMPTY;
      break;
    default:
      c.effect = EMPTY;
      c.param = 0;
  }
}

/** Insert an empty row at `row` in one channel, pushing the rest down. */
export function insertRow(p: Pattern, ch: number, row: number) {
  for (let r = p.rows.length - 1; r > row; r--) p.rows[r][ch] = p.rows[r - 1][ch];
  p.rows[row][ch] = emptyCell();
}

/** Delete `row` in one channel, pulling the rest up. */
export function deleteRow(p: Pattern, ch: number, row: number) {
  for (let r = row; r < p.rows.length - 1; r++) p.rows[r][ch] = p.rows[r + 1][ch];
  p.rows[p.rows.length - 1][ch] = emptyCell();
}

/** Change the number of rows of a pattern (cut at the end or filled with empty rows). */
export function resizePattern(p: Pattern, rows: number) {
  while (p.rows.length > rows) p.rows.pop();
  while (p.rows.length < rows) p.rows.push(Array.from({ length: CHANNEL_COUNT }, emptyCell));
}
