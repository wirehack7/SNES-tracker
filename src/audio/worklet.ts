/// <reference lib="webworker" />
// AudioWorklet processor: runs the DSP emulation and the player on the audio thread.
import { VOICE_COUNT } from '../dsp/dsp';
import { Song } from '../tracker/song';
import { Engine } from './engine';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export type WorkletMessage =
  | { type: 'song'; song: Song }
  | { type: 'play'; order: number; row: number; loopPattern: boolean }
  | { type: 'stop' }
  | { type: 'preview'; channel: number; note: number; instrument: number }
  | { type: 'release'; channel: number }
  | { type: 'sample'; index: number; note: number }
  | { type: 'mute'; muted: boolean[] };

export type WorkletEvent =
  | { type: 'row'; order: number; row: number }
  | { type: 'scope'; samples: Float32Array; frames: number };

const SCOPE_FRAMES = 1024;
const QUANTUM = 128;

class TrackerProcessor extends AudioWorkletProcessor {
  private engine: Engine | null = null;
  private readonly scope = new Float32Array(SCOPE_FRAMES * VOICE_COUNT);
  private scopePos = 0;
  private readonly voiceBuf = new Float32Array(QUANTUM * VOICE_COUNT);
  private quanta = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletMessage>) => this.handle(e.data);
  }

  private handle(msg: WorkletMessage) {
    if (msg.type === 'song') {
      if (!this.engine) {
        this.engine = new Engine(msg.song, sampleRate, true);
        this.engine.player.onRow = (order, row) => this.port.postMessage({ type: 'row', order, row });
      } else this.engine.setSong(msg.song);
      return;
    }
    const engine = this.engine;
    if (!engine) return;
    switch (msg.type) {
      case 'play':
        engine.play(msg.order, msg.row, msg.loopPattern);
        break;
      case 'stop':
        engine.stop();
        break;
      case 'preview':
        engine.player.preview(engine.dsp, msg.channel, msg.note, msg.instrument);
        break;
      case 'release':
        engine.player.releasePreview(engine.dsp, msg.channel);
        break;
      case 'sample':
        engine.player.previewSample(engine.dsp, 7, msg.index, msg.note);
        break;
      case 'mute':
        msg.muted.forEach((m, i) => (engine.dsp.muted[i] = m));
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    if (!this.engine || !out?.length) return true;
    const left = out[0];
    const right = out[1] ?? out[0];
    const frames = left.length;
    this.engine.render(left, right, frames, this.voiceBuf);

    for (let i = 0; i < frames; i++) {
      this.scope.set(this.voiceBuf.subarray(i * VOICE_COUNT, (i + 1) * VOICE_COUNT), this.scopePos * VOICE_COUNT);
      this.scopePos = (this.scopePos + 1) % SCOPE_FRAMES;
    }
    if (++this.quanta % 8 === 0) {
      // Send the ring buffer unrolled, oldest sample first.
      const samples = new Float32Array(SCOPE_FRAMES * VOICE_COUNT);
      samples.set(this.scope.subarray(this.scopePos * VOICE_COUNT));
      samples.set(this.scope.subarray(0, this.scopePos * VOICE_COUNT), (SCOPE_FRAMES - this.scopePos) * VOICE_COUNT);
      this.port.postMessage({ type: 'scope', samples, frames: SCOPE_FRAMES }, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor('snes-tracker', TrackerProcessor);
