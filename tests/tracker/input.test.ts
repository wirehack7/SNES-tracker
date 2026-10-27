import { describe, expect, it } from 'vitest';
import { MIDI_NOTE_OFFSET, midiToNote, parseMidi } from '../../src/input/midi';
import { NOTE_COUNT, noteFrequency, noteName } from '../../src/tracker/notes';
import { pianoKeys, pianoOctaves, pianoWhites } from '../../src/ui/piano';

describe('MIDI input', () => {
  it('decodes note on/off on any channel', () => {
    expect(parseMidi([0x90, 60, 100])).toEqual({ type: 'on', note: 60, velocity: 100, channel: 0 });
    expect(parseMidi([0x9f, 61, 1])).toEqual({ type: 'on', note: 61, velocity: 1, channel: 15 });
    expect(parseMidi([0x83, 60, 64])).toEqual({ type: 'off', note: 60, velocity: 64, channel: 3 });
    // Running-status style note on with velocity 0 is a note off.
    expect(parseMidi([0x90, 60, 0])?.type).toBe('off');
  });

  it('ignores other messages', () => {
    expect(parseMidi([0xb0, 7, 100])).toBeNull(); // control change
    expect(parseMidi([0xe0, 0, 64])).toBeNull(); // pitch bend
    expect(parseMidi([0xf8])).toBeNull(); // clock
    expect(parseMidi([0x90, 60])).toBeNull();
  });

  it('maps MIDI 60 to C-4 at the same pitch as the tracker', () => {
    const c4 = midiToNote(60)!;
    expect(noteName(c4)).toBe('C-4');
    // MIDI note n has 440 * 2^((n-69)/12) Hz.
    for (const n of [12, 60, 69, 100, 107]) expect(noteFrequency(midiToNote(n)!)).toBeCloseTo(440 * 2 ** ((n - 69) / 12), 6);
  });

  it('rejects notes outside the tracker range', () => {
    expect(midiToNote(MIDI_NOTE_OFFSET - 1)).toBeNull();
    expect(midiToNote(MIDI_NOTE_OFFSET)).toBe(0);
    expect(midiToNote(MIDI_NOTE_OFFSET + NOTE_COUNT - 1)).toBe(NOTE_COUNT - 1);
    expect(midiToNote(MIDI_NOTE_OFFSET + NOTE_COUNT)).toBeNull();
  });
});

describe('on-screen piano', () => {
  it('lays out octaves like a piano: 7 white and 5 black keys each, plus the closing C', () => {
    const keys = pianoKeys(4, 2);
    expect(keys).toHaveLength(25);
    expect(keys.filter((k) => !k.black)).toHaveLength(15);
    expect(noteName(keys[0].note)).toBe('C-4');
    expect(noteName(keys[24].note)).toBe('C-6');
    expect(keys.filter((k) => k.label).map((k) => k.label)).toEqual(['C4', 'C5', 'C6']);
    // C# sits on the right edge of C, F# on the right edge of F (white index 3).
    expect(keys[1]).toMatchObject({ black: true, white: 0 });
    expect(keys[6]).toMatchObject({ black: true, white: 3 });
    // Keys are consecutive semitones.
    keys.forEach((k, i) => expect(k.note).toBe(keys[0].note + i));
  });

  it('shifts down at the top of the note range instead of shrinking', () => {
    const keys = pianoKeys(7, 2);
    expect(noteName(keys[0].note)).toBe('C-6');
    expect(keys.at(-1)!.note).toBe(NOTE_COUNT - 1);
    expect(noteName(keys.at(-1)!.note)).toBe('B-7');
    // Same white keys for every octave, so the keys never change size.
    for (const octaves of [1, 2, 3, 4])
      for (let octave = 2; octave <= 7; octave++) {
        const whites = pianoKeys(octave, octaves).filter((k) => !k.black);
        expect(whites.length).toBeGreaterThanOrEqual(pianoWhites(octaves) - 1);
        expect(whites.at(-1)!.white).toBeLessThan(pianoWhites(octaves));
      }
  });

  it('fits more octaves on wider screens', () => {
    expect(pianoOctaves(320)).toBe(1);
    expect(pianoOctaves(700)).toBe(3);
    expect(pianoOctaves(5000)).toBe(4);
    // Touch: wider keys, one octave on a phone, so each white key is ~48 px.
    expect(pianoOctaves(390, 46)).toBe(1);
    expect(pianoOctaves(1024, 46)).toBe(3);
  });
});
