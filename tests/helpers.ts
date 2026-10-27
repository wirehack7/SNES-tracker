import { Engine } from '../src/audio/engine';
import { Song, createSong, emptyCell } from '../src/tracker/song';

/** Estimated frequency of a signal from its rising zero crossings. */
export function frequency(samples: ArrayLike<number>, rate: number): number {
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length || 1;
  const crossings: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] - mean;
    const b = samples[i] - mean;
    if (a < 0 && b >= 0) crossings.push(i - 1 + a / (a - b));
  }
  if (crossings.length < 2) return 0;
  return ((crossings.length - 1) * rate) / (crossings[crossings.length - 1] - crossings[0]);
}

/** Left channel of a native render, as numbers. */
export function renderLeft(engine: Engine, frames: number): number[] {
  const out = engine.renderNative(frames);
  return Array.from({ length: frames }, (_, i) => out[i * 2]);
}

export function songWith(cells: { row: number; ch: number; note?: number; instrument?: number; volume?: number; effect?: number; param?: number }[]): Song {
  const song = createSong();
  song.echo.volumeL = song.echo.volumeR = 0;
  for (const c of cells) song.patterns[0].rows[c.row][c.ch] = { ...emptyCell(), ...c };
  return song;
}
