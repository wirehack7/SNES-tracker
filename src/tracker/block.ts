/** Block operations of the pattern editor: a rectangle of rows × channels. */
import { NOTE_COUNT } from './notes';
import { CHANNEL_COUNT, Cell, Pattern, emptyCell, isEmptyCell } from './song';

export interface Block {
  /** First and last row and channel, inclusive (any order). */
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** The block with its corners sorted and clipped to the pattern. */
export function normalize(b: Block, rows: number): Block {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  return {
    r0: clamp(Math.min(b.r0, b.r1), rows - 1),
    r1: clamp(Math.max(b.r0, b.r1), rows - 1),
    c0: clamp(Math.min(b.c0, b.c1), CHANNEL_COUNT - 1),
    c1: clamp(Math.max(b.c0, b.c1), CHANNEL_COUNT - 1),
  };
}

export function contains(b: Block, row: number, ch: number): boolean {
  return row >= Math.min(b.r0, b.r1) && row <= Math.max(b.r0, b.r1) && ch >= Math.min(b.c0, b.c1) && ch <= Math.max(b.c0, b.c1);
}

/** Copies of the cells in the block, as clip[row][channel]. */
export function copyBlock(p: Pattern, b: Block): Cell[][] {
  const n = normalize(b, p.rows.length);
  const clip: Cell[][] = [];
  for (let r = n.r0; r <= n.r1; r++) clip.push(p.rows[r].slice(n.c0, n.c1 + 1).map((c) => ({ ...c })));
  return clip;
}

/** Empty every cell in the block. */
export function clearBlock(p: Pattern, b: Block) {
  const n = normalize(b, p.rows.length);
  for (let r = n.r0; r <= n.r1; r++) for (let c = n.c0; c <= n.c1; c++) p.rows[r][c] = emptyCell();
}

/**
 * Paste a clip with its top left at (row, ch). Rows and channels past the end
 * of the pattern are dropped. With `mix`, only filled cells of the clip are
 * written, so it layers onto what is there. Returns the block written.
 */
export function pasteBlock(p: Pattern, row: number, ch: number, clip: Cell[][], mix = false): Block | null {
  if (!clip.length || !clip[0].length) return null;
  const r1 = Math.min(p.rows.length - 1, row + clip.length - 1);
  const c1 = Math.min(CHANNEL_COUNT - 1, ch + clip[0].length - 1);
  for (let r = row; r <= r1; r++)
    for (let c = ch; c <= c1; c++) {
      const src = clip[r - row][c - ch];
      if (mix && isEmptyCell(src)) continue;
      p.rows[r][c] = { ...src };
    }
  return { r0: row, r1, c0: ch, c1 };
}

/** Transpose the notes in the block; notes stay inside the note range, note-offs are kept. */
export function transposeBlock(p: Pattern, b: Block, semitones: number) {
  const n = normalize(b, p.rows.length);
  for (let r = n.r0; r <= n.r1; r++)
    for (let c = n.c0; c <= n.c1; c++) {
      const cell = p.rows[r][c];
      if (cell.note >= 0) cell.note = Math.max(0, Math.min(NOTE_COUNT - 1, cell.note + semitones));
    }
}
