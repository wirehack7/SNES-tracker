/**
 * Notes and their S-DSP pitch values.
 *
 * Note 0 is C-0 and note 95 is B-7; C-4 (note 48) plays a sample at its own
 * rate. The DSP pitch register is a 14-bit step per output sample in 1/4096
 * of a source sample: 0x1000 plays a sample recorded at 32000 Hz unchanged,
 * and the highest value (0x3FFF) is just under four times that.
 */
import { COUNTER_RATES, DSP_RATE } from '../dsp/dsp';

export const NOTE_COUNT = 96;
export const C4 = 48;
export const MAX_PITCH = 0x3fff;
const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

export function noteName(note: number): string {
  return NAMES[note % 12] + Math.floor(note / 12);
}

/** Equal temperament, A-4 = 440 Hz. */
export function noteFrequency(note: number): number {
  return 440 * Math.pow(2, (note - 57) / 12);
}

/**
 * Pitch register value for a note given in (fractional) semitones, for a
 * sample whose C-4 rate is `rate` Hz. Clamped to the register's range.
 */
export function pitchFor(semitones: number, rate: number): number {
  const p = Math.round(((0x1000 * rate) / DSP_RATE) * Math.pow(2, (semitones - C4) / 12));
  return Math.max(0, Math.min(MAX_PITCH, p));
}

/** Playback frequency of a pitch register value for a sample with C-4 rate `rate`, in samples per second. */
export function pitchRate(pitch: number): number {
  return (pitch * DSP_RATE) / 0x1000;
}

/** Noise clock (FLG bits 0-4) whose LFSR rate is closest to 8 × the note's frequency. */
export function noiseClockFor(note: number): number {
  const target = Math.log(noteFrequency(note) * 8);
  let best = 1;
  let dist = Infinity;
  for (let c = 1; c < 32; c++) {
    const d = Math.abs(Math.log(DSP_RATE / COUNTER_RATES[c]) - target);
    if (d < dist) {
      dist = d;
      best = c;
    }
  }
  return best;
}
