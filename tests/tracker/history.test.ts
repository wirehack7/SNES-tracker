import { describe, expect, it } from 'vitest';
import { clearBlock, contains, copyBlock, normalize, pasteBlock, transposeBlock } from '../../src/tracker/block';
import { History } from '../../src/tracker/history';
import { NOTE_COUNT } from '../../src/tracker/notes';
import { EMPTY, NOTE_OFF, emptyPattern } from '../../src/tracker/song';

describe('undo history', () => {
  it('undoes and redoes edits in order', () => {
    const h = new History('a');
    expect(h.canUndo).toBe(false);
    h.commit('b');
    h.commit('c');
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe('b');
    expect(h.redo()).toBe('c');
    expect(h.redo()).toBeNull();
  });

  it('drops the redo steps after a new edit and ignores no-op commits', () => {
    const h = new History('a');
    h.commit('b');
    h.undo();
    expect(h.commit('a')).toBe(false);
    expect(h.canRedo).toBe(true);
    h.commit('x');
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe('a');
  });

  it('keeps at most maxSteps and maxBytes', () => {
    const h = new History('0', 3);
    for (let i = 1; i <= 10; i++) h.commit(String(i));
    expect([h.undo(), h.undo(), h.undo(), h.undo()]).toEqual(['9', '8', '7', null]);
    const big = new History('x'.repeat(10), 100, 25);
    for (let i = 0; i < 5; i++) big.commit(String(i).repeat(10));
    let steps = 0;
    while (big.undo() !== null) steps++;
    expect(steps).toBe(2);
  });

  it('starts over on reset', () => {
    const h = new History('a');
    h.commit('b');
    h.reset('z');
    expect(h.canUndo).toBe(false);
    h.commit('y');
    expect(h.undo()).toBe('z');
  });
});

function numbered() {
  const p = emptyPattern(16);
  p.rows.forEach((row, r) => row.forEach((c, ch) => (c.note = r * 4 + ch)));
  return p;
}

describe('pattern blocks', () => {
  it('normalizes reversed and out-of-range corners', () => {
    expect(normalize({ r0: 20, r1: 3, c0: 9, c1: -1 }, 16)).toEqual({ r0: 3, r1: 15, c0: 0, c1: 7 });
    expect(contains({ r0: 4, r1: 2, c0: 2, c1: 1 }, 3, 1)).toBe(true);
    expect(contains({ r0: 4, r1: 2, c0: 2, c1: 1 }, 5, 1)).toBe(false);
  });

  it('copies, clears and pastes a block of rows and channels', () => {
    const p = numbered();
    const clip = copyBlock(p, { r0: 2, r1: 3, c0: 1, c1: 2 });
    expect(clip.map((r) => r.map((c) => c.note))).toEqual([
      [9, 10],
      [13, 14],
    ]);
    clearBlock(p, { r0: 2, r1: 3, c0: 1, c1: 2 });
    expect(p.rows[2][1].note).toBe(EMPTY);
    expect(p.rows[2][0].note).toBe(8);
    expect(p.rows[3][3].note).toBe(15);
    // The clip is a copy: clearing did not touch it.
    expect(clip[0][0].note).toBe(9);
    const at = pasteBlock(p, 14, 3, clip);
    expect(at).toEqual({ r0: 14, r1: 15, c0: 3, c1: 4 });
    expect(p.rows[14][3].note).toBe(9);
    expect(p.rows[15][3].note).toBe(13);
    // Pasted cells are new objects.
    p.rows[14][3].note = 0;
    expect(clip[0][0].note).toBe(9);
  });

  it('mix-pastes only the filled cells', () => {
    const p = numbered();
    const clip = copyBlock(emptyPattern(2), { r0: 0, r1: 1, c0: 0, c1: 0 });
    clip[1][0].note = 50;
    pasteBlock(p, 0, 0, clip, true);
    expect(p.rows[0][0].note).toBe(0);
    expect(p.rows[1][0].note).toBe(50);
    pasteBlock(p, 0, 0, clip);
    expect(p.rows[0][0].note).toBe(EMPTY);
  });

  it('transposes notes in the block within the note range and keeps note-offs', () => {
    const p = emptyPattern(4);
    p.rows[0][0].note = 10;
    p.rows[1][0].note = NOTE_OFF;
    p.rows[2][0].note = NOTE_COUNT - 2;
    p.rows[3][1].note = 10;
    transposeBlock(p, { r0: 0, r1: 3, c0: 0, c1: 0 }, 12);
    expect(p.rows.map((r) => r[0].note)).toEqual([22, NOTE_OFF, NOTE_COUNT - 1, EMPTY]);
    expect(p.rows[3][1].note).toBe(10);
    transposeBlock(p, { r0: 0, r1: 0, c0: 0, c1: 0 }, -30);
    expect(p.rows[0][0].note).toBe(0);
  });
});
