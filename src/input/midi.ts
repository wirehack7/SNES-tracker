/**
 * Web MIDI input: note on/off from any connected device. Parsing is kept
 * separate from the browser API so it can be tested.
 */
import { NOTE_COUNT } from '../tracker/notes';

export type MidiEvent = { type: 'on' | 'off'; note: number; velocity: number; channel: number };

/** MIDI note number of the tracker's lowest note (C-0 = MIDI 12, so MIDI 60 is C-4). */
export const MIDI_NOTE_OFFSET = 12;

/** Tracker note index for a MIDI note number, or null when out of range. */
export function midiToNote(midi: number): number | null {
  const note = midi - MIDI_NOTE_OFFSET;
  return note >= 0 && note < NOTE_COUNT ? note : null;
}

/** Decode a channel voice message. Note on with velocity 0 is a note off. */
export function parseMidi(data: ArrayLike<number>): MidiEvent | null {
  if (data.length < 3) return null;
  const status = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  const note = data[1] & 0x7f;
  const velocity = data[2] & 0x7f;
  if (status === 0x90 && velocity > 0) return { type: 'on', note, velocity, channel };
  if (status === 0x80 || status === 0x90) return { type: 'off', note, velocity, channel };
  return null;
}

export interface MidiStatus {
  supported: boolean;
  enabled: boolean;
  inputs: string[];
  error?: string;
}

/** Listens to every MIDI input, including devices plugged in later. */
export class MidiInput {
  private access: MIDIAccess | null = null;
  status: MidiStatus = { supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator, enabled: false, inputs: [] };
  onEvent?: (e: MidiEvent) => void;
  onStatus?: (s: MidiStatus) => void;

  async enable(): Promise<MidiStatus> {
    if (!this.status.supported) return this.update({ error: 'Web MIDI is not supported by this browser.' });
    try {
      this.access ??= await navigator.requestMIDIAccess();
    } catch (err) {
      return this.update({ enabled: false, error: (err as Error).message || 'MIDI access denied.' });
    }
    this.access.onstatechange = () => this.bind();
    this.status.enabled = true;
    this.bind();
    return this.status;
  }

  disable() {
    if (this.access) {
      this.access.onstatechange = null;
      for (const input of this.access.inputs.values()) input.onmidimessage = null;
    }
    this.update({ enabled: false, inputs: [] });
  }

  private bind() {
    if (!this.access || !this.status.enabled) return;
    const names: string[] = [];
    for (const input of this.access.inputs.values()) {
      if (input.state !== 'connected') continue;
      names.push(input.name ?? 'MIDI input');
      input.onmidimessage = (m: MIDIMessageEvent) => {
        const e = m.data ? parseMidi(m.data) : null;
        if (e) this.onEvent?.(e);
      };
    }
    this.update({ inputs: names, error: undefined });
  }

  private update(patch: Partial<MidiStatus>): MidiStatus {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
    return this.status;
  }
}
