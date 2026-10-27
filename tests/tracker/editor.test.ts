import { describe, expect, it } from 'vitest';
import { EMPTY, NOTE_OFF, emptyCell, emptyPattern } from '../../src/tracker/song';
import { clearField, deleteRow, enterDigit, fieldGroup, formatCell, insertRow, jumpChannel, moveCursor, noteFromKey } from '../../src/ui/editor';

describe('pattern editor', () => {
  it('maps physical keys to notes relative to the octave', () => {
    expect(noteFromKey('KeyZ', 4)).toBe(48); // C-4
    expect(noteFromKey('KeyQ', 4)).toBe(60); // C-5
    expect(noteFromKey('KeyA', 4)).toBeNull();
    expect(noteFromKey('KeyP', 7)).toBeNull(); // beyond B-7
  });

  it('wraps the cursor across fields, voices and rows', () => {
    expect(moveCursor({ row: 0, ch: 0, field: 7 }, 64, 0, 1)).toEqual({ row: 0, ch: 1, field: 0 });
    expect(moveCursor({ row: 0, ch: 0, field: 0 }, 64, -1, -1)).toEqual({ row: 63, ch: 7, field: 7 });
    expect(jumpChannel({ row: 3, ch: 7, field: 4 }, 1)).toEqual({ row: 3, ch: 0, field: 0 });
  });

  it('enters hex digits into the right fields', () => {
    const c = emptyCell();
    enterDigit(c, 1, 0); // instrument high digit
    enterDigit(c, 2, 3); // instrument low digit: shown 03
    enterDigit(c, 3, 7); // volume high digit
    enterDigit(c, 4, 0xf);
    enterDigit(c, 5, 0xa); // effect
    enterDigit(c, 6, 0x4);
    enterDigit(c, 7, 0x7);
    expect(c).toEqual({ note: EMPTY, instrument: 2, volume: 0x7f, effect: 0xa, param: 0x47 });
    expect(formatCell(c)).toEqual(['---', '03', '7F', 'A', '47']);
    clearField(c, 5);
    expect(c.effect).toBe(EMPTY);
    expect(c.param).toBe(0);
  });

  it('keeps the instrument and volume inside their ranges', () => {
    const c = emptyCell();
    enterDigit(c, 1, 0xf); // F0 instruments: clamped to 32 (shown 20)
    expect(c.instrument).toBe(31);
    enterDigit(c, 3, 0xf); // volume F0: clamped to 7F
    expect(c.volume).toBe(0x7f);
  });

  it('has eight fields in five groups', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((f) => fieldGroup(f)[0])).toEqual([0, 1, 1, 2, 2, 3, 4, 4]);
  });

  it('formats note off', () => {
    expect(formatCell({ ...emptyCell(), note: NOTE_OFF })[0]).toBe('===');
  });

  it('inserts and deletes rows in one voice only', () => {
    const p = emptyPattern(4);
    p.rows[1][2].note = 10;
    p.rows[1][0].note = 5;
    insertRow(p, 2, 0);
    expect(p.rows[2][2].note).toBe(10);
    expect(p.rows[1][0].note).toBe(5);
    deleteRow(p, 2, 0);
    expect(p.rows[1][2].note).toBe(10);
  });
});
