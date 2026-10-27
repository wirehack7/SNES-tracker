import { Engine } from '../audio/engine';
import { DSP_RATE } from '../dsp/dsp';
import { Song } from '../tracker/song';

/** Encode stereo float samples as a 16-bit PCM WAV file. */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
  const frames = left.length;
  const dataSize = frames * 4;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // stereo
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < frames; i++) {
    v.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), true);
    v.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), true);
  }
  return new Uint8Array(buf);
}

export interface RenderOptions {
  /** Output rate; the DSP's own 32000 Hz by default (bit exact). */
  sampleRate?: number;
  /** How many times the song is played (it ends when it loops). */
  loops?: number;
  /** Safety limit in seconds. */
  maxSeconds?: number;
  /** Seconds of tail after the end (echo and releases ring out). */
  tail?: number;
  onProgress?: (seconds: number) => void;
  /** Channels to leave out (for stems). */
  muted?: readonly boolean[];
  /** Also keep each voice's output (for the video's scopes). */
  voices?: boolean;
}

export interface Rendered {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  /** VOICE_COUNT values per frame, when asked for. */
  voices?: Float32Array;
}

/** Render a song to stereo buffers. Yields to the event loop between chunks. */
export async function renderSong(song: Song, opts: RenderOptions = {}): Promise<Rendered> {
  const sampleRate = opts.sampleRate ?? DSP_RATE;
  const loops = opts.loops ?? 1;
  const maxFrames = (opts.maxSeconds ?? 600) * sampleRate;
  const engine = new Engine(song, sampleRate, !!opts.voices);
  opts.muted?.forEach((m, i) => (engine.dsp.muted[i] = m));
  engine.play(0, 0);
  const chunk = 512;
  const chunksL: Float32Array[] = [];
  const chunksR: Float32Array[] = [];
  const chunksV: Float32Array[] = [];
  let frames = 0;
  let tailFrames = -1;
  while (frames < maxFrames) {
    if (tailFrames < 0 && engine.player.loops >= loops) {
      engine.stop();
      tailFrames = Math.round((opts.tail ?? 1.5) * sampleRate);
    }
    if (tailFrames === 0) break;
    const n = tailFrames > 0 ? Math.min(chunk, tailFrames) : chunk;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    const v = opts.voices ? new Float32Array(n * 8) : undefined;
    engine.render(l, r, n, v);
    chunksL.push(l);
    chunksR.push(r);
    if (v) chunksV.push(v);
    frames += n;
    if (tailFrames > 0) tailFrames -= n;
    if (chunksL.length % 256 === 0) {
      opts.onProgress?.(frames / sampleRate);
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  const join = (parts: Float32Array[], size: number) => {
    const out = new Float32Array(size);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  return {
    left: join(chunksL, frames),
    right: join(chunksR, frames),
    sampleRate,
    voices: opts.voices ? join(chunksV, frames * 8) : undefined,
  };
}

/** One render per channel with the others muted: the stems add up to the full mix (apart from the echo's rounding). */
export async function renderStems(song: Song, opts: RenderOptions = {}) {
  const stems = [];
  for (let ch = 0; ch < 8; ch++) {
    const muted = Array.from({ length: 8 }, (_, i) => i !== ch);
    stems.push(await renderSong(structuredClone(song), { ...opts, muted }));
  }
  return stems;
}
