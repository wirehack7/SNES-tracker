import { DSP_RATE } from '../dsp/dsp';
import { Song } from '../tracker/song';
import type { WorkletEvent, WorkletMessage } from './worklet';
import workletUrl from './worklet.ts?worker&url';

/** Main thread side of the audio worklet. The context is created lazily on a user gesture. */
export class AudioClient {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private starting: Promise<void> | null = null;
  private pending: WorkletMessage[] = [];
  private song: Song | null = null;
  onRow?: (order: number, row: number) => void;
  onScope?: (samples: Float32Array, frames: number) => void;

  get ready() {
    return this.node !== null;
  }

  /** Must be called from a user gesture (required by mobile browsers). */
  start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      return this.starting ?? Promise.resolve();
    }
    // The DSP's own rate when the browser allows it (it resamples to the device); otherwise the engine resamples.
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: DSP_RATE });
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    this.ctx = ctx;
    // Resume synchronously inside the gesture for iOS Safari.
    void ctx.resume();
    this.starting = ctx.audioWorklet.addModule(workletUrl).then(() => {
      const node = new AudioWorkletNode(ctx, 'snes-tracker', { numberOfInputs: 0, outputChannelCount: [2] });
      node.port.onmessage = (e: MessageEvent<WorkletEvent>) => {
        const msg = e.data;
        if (msg.type === 'row') this.onRow?.(msg.order, msg.row);
        else if (msg.type === 'scope') this.onScope?.(msg.samples, msg.frames);
      };
      const gain = new GainNode(ctx, { gain: this.volume });
      node.connect(gain).connect(ctx.destination);
      this.gain = gain;
      this.node = node;
      if (this.song) node.port.postMessage({ type: 'song', song: this.song });
      for (const m of this.pending) node.port.postMessage(m);
      this.pending = [];
    });
    return this.starting;
  }

  /** Master output gain (linear). Only affects playback, never exports. */
  setVolume(gain: number) {
    this.volume = gain;
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  /** Play mono audio directly (previews of samples that are not in the song yet). */
  async playBuffer(pcm: Float32Array, rate: number) {
    await this.start();
    const ctx = this.ctx;
    if (!ctx || !pcm.length) return;
    const buffer = ctx.createBuffer(1, pcm.length, Math.max(3000, Math.min(192000, rate)));
    buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const src = new AudioBufferSourceNode(ctx, { buffer });
    src.connect(this.gain ?? ctx.destination);
    src.start();
  }

  setSong(song: Song) {
    this.song = song;
    this.node?.port.postMessage({ type: 'song', song });
  }

  send(msg: WorkletMessage) {
    if (this.node) this.node.port.postMessage(msg);
    else if (msg.type !== 'release') this.pending.push(msg);
  }
}
