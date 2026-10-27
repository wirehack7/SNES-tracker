/**
 * Compressed exports through WebCodecs (via mediabunny): MP3 audio and an
 * MP4 video with the eight voice scopes and the scrolling pattern. The song
 * is rendered offline one video frame at a time, faster than real time on
 * most machines.
 */
import { Engine } from '../audio/engine';
import { VOICE_COUNT } from '../dsp/dsp';
import { CHANNEL_COUNT, Song } from '../tracker/song';
import { formatCell } from '../ui/editor';
import { scopeTrace } from '../ui/scope';

export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
export const VIDEO_FPS = 30;
export const MEDIA_RATE = 48000;

export interface TimelineFrame {
  left: Float32Array;
  right: Float32Array;
  /** Per-voice output, VOICE_COUNT interleaved values per sample. */
  voices: Float32Array;
  order: number;
  row: number;
  /** Seconds from the start to the end of this frame. */
  time: number;
}

/**
 * Steps the emulator one video frame at a time. Sample counts per frame are
 * rounded so that the total always matches the elapsed time exactly.
 */
export class Timeline {
  readonly engine: Engine;
  private frame = 0;
  private samples = 0;
  private tailLeft = -1;
  private order = 0;
  private row = 0;

  constructor(
    song: Song,
    readonly sampleRate: number,
    readonly fps: number,
    readonly loops = 1,
    readonly tail = 1.5,
    readonly maxSeconds = 600,
  ) {
    this.engine = new Engine(song, sampleRate, true);
    this.engine.player.onRow = (order, row) => {
      this.order = order;
      this.row = row;
    };
    this.engine.play(0, 0);
  }

  get seconds() {
    return this.samples / this.sampleRate;
  }

  /** The next frame, or null once the song (and its tail) has ended. */
  next(): TimelineFrame | null {
    if (this.tailLeft < 0 && (this.engine.player.loops >= this.loops || this.seconds >= this.maxSeconds)) {
      this.engine.stop();
      this.tailLeft = Math.round(this.tail * this.sampleRate);
    }
    if (this.tailLeft === 0) return null;
    let n = Math.round(((this.frame + 1) * this.sampleRate) / this.fps) - this.samples;
    if (this.tailLeft > 0) {
      n = Math.min(n, this.tailLeft);
      this.tailLeft -= n;
    }
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    const voices = new Float32Array(n * VOICE_COUNT);
    this.engine.render(left, right, n, voices);
    this.frame++;
    this.samples += n;
    return { left, right, voices, order: this.order, row: this.row, time: this.seconds };
  }
}

export interface VideoColors {
  bg: string;
  surface: string;
  line: string;
  ink: string;
  inkSoft: string;
  accent: string;
  stripes: string[];
  patBg: string;
  patBeat: string;
  patBar: string;
  play: string;
  playInk: string;
  num: string;
  /** Note, instrument, volume, effect, param */
  fields: string[];
  off: string;
  empty: string;
  scopeBg: string;
  scopeInk: string;
}

/** Light theme colours (src/theme.css), used when no page styles are available. */
export const DEFAULT_COLORS: VideoColors = {
  bg: '#cfccd6',
  surface: '#e6e4ec',
  line: '#b9b5c4',
  ink: '#25222e',
  inkSoft: '#615c70',
  accent: '#5b4a9e',
  stripes: ['#d6312b', '#e8a321', '#2f9e4f', '#2f5fc4'],
  patBg: '#f4f3f7',
  patBeat: '#eae8f0',
  patBar: '#dedbe7',
  play: '#5b4a9e',
  playInk: '#f6f4ff',
  num: '#8e8a9c',
  fields: ['#2f3f9e', '#a23a8c', '#2b7a3f', '#b4570f', '#7a4a12'],
  off: '#8e8a9c',
  empty: '#c5c1cf',
  scopeBg: '#22202b',
  scopeInk: '#9ee6a8',
};

/** Colours of the current theme, read from the page's CSS variables. */
export function themeColors(style: CSSStyleDeclaration): VideoColors {
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const d = DEFAULT_COLORS;
  return {
    bg: v('--bg', d.bg),
    surface: v('--surface', d.surface),
    line: v('--line', d.line),
    ink: v('--ink', d.ink),
    inkSoft: v('--ink-soft', d.inkSoft),
    accent: v('--accent', d.accent),
    stripes: [v('--btn-a', d.stripes[0]), v('--btn-b', d.stripes[1]), v('--btn-x', d.stripes[2]), v('--btn-y', d.stripes[3])],
    patBg: v('--pat-bg', d.patBg),
    patBeat: v('--pat-beat', d.patBeat),
    patBar: v('--pat-bar', d.patBar),
    play: v('--pat-play', d.play),
    playInk: v('--pat-play-ink', d.playInk),
    num: v('--c-num', d.num),
    fields: [v('--c-note', d.fields[0]), v('--c-inst', d.fields[1]), v('--c-vol', d.fields[2]), v('--c-fx', d.fields[3]), v('--c-param', d.fields[4])],
    off: v('--c-off', d.off),
    empty: v('--c-empty', d.empty),
    scopeBg: v('--scope-bg', d.scopeBg),
    scopeInk: v('--scope-ink', d.scopeInk),
  };
}

const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** Group widths in characters (note, instrument, volume, effect, param) and the gaps before them. */
const GROUP_CHARS = [3, 2, 2, 1, 2];
const GROUP_GAP = [0, 1, 1, 1, 0];
const EMPTY_GLYPH = ['···', '··', '··', '·', '··'];
const VISIBLE_ROWS = 15;

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** Draw one video frame: title bar, eight voice scopes and the pattern around the playing row. */
export function drawFrame(
  g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  song: Song,
  frame: TimelineFrame,
  c: VideoColors,
) {
  const W = VIDEO_WIDTH;
  const H = VIDEO_HEIGHT;
  g.fillStyle = c.bg;
  g.fillRect(0, 0, W, H);

  // Title bar with the four SNES button colours as a stripe.
  g.fillStyle = c.surface;
  g.fillRect(0, 0, W, 64);
  c.stripes.forEach((s, i) => {
    g.fillStyle = s;
    g.fillRect((i * W) / 4, 64, W / 4, 5);
  });
  g.textBaseline = 'middle';
  g.fillStyle = c.accent;
  g.font = `italic 800 26px ${SANS}`;
  g.fillText('SNES TRACKER', 24, 33);
  g.fillStyle = c.ink;
  g.font = `700 22px ${SANS}`;
  const title = song.title + (song.author ? ` — ${song.author}` : '');
  g.fillText(title.length > 60 ? title.slice(0, 59) + '…' : title, 250, 33);
  g.textAlign = 'right';
  g.font = `700 20px ${MONO}`;
  g.fillStyle = c.inkSoft;
  g.fillText(`${hex2(frame.order)}/${hex2(frame.row)}  ${clock(frame.time)}`, W - 24, 33);
  g.textAlign = 'left';

  // Scopes: two rows of four.
  const n = frame.left.length;
  const sw = (W - 24 * 2 - 12 * 3) / 4;
  const sh = 74;
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const x = 24 + (ch % 4) * (sw + 12);
    const y = 84 + Math.floor(ch / 4) * (sh + 10);
    g.fillStyle = c.scopeBg;
    g.fillRect(x, y, sw, sh);
    g.fillStyle = c.scopeInk;
    g.font = `700 14px ${MONO}`;
    g.globalAlpha = 0.7;
    g.fillText(String(ch + 1), x + 8, y + 14);
    g.globalAlpha = 1;
    const trace = scopeTrace(frame.voices, n, ch, 400);
    g.strokeStyle = c.scopeInk;
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < trace.length; i++) {
      const px = x + (i / Math.max(1, trace.length - 1)) * sw;
      const py = y + sh / 2 - trace[i] * (sh / 2 - 4);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  }

  // Pattern around the playing row.
  const top = 84 + 2 * (sh + 10) + 6;
  const rowH = (H - top - 12) / VISIBLE_ROWS;
  const pattern = song.patterns[song.order[frame.order]] ?? song.patterns[0];
  const font = 15;
  g.font = `${font}px ${MONO}`;
  const cw = g.measureText('0').width;
  const cellChars = 12;
  const colW = cellChars * cw + 10;
  const left = (W - (3 * cw + 10 + CHANNEL_COUNT * colW)) / 2;
  g.fillStyle = c.patBg;
  g.fillRect(left - 8, top, W - 2 * (left - 8), H - top - 12);
  for (let i = 0; i < VISIBLE_ROWS; i++) {
    const r = frame.row - Math.floor(VISIBLE_ROWS / 2) + i;
    if (r < 0 || r >= pattern.rows.length) continue;
    const y = top + i * rowH;
    const playing = r === frame.row;
    const bg = playing ? c.play : r % 16 === 0 ? c.patBar : r % 4 === 0 ? c.patBeat : null;
    if (bg) {
      g.fillStyle = bg;
      g.fillRect(left - 8, y, W - 2 * (left - 8), rowH);
    }
    const mid = y + rowH / 2;
    g.fillStyle = playing ? c.playInk : c.num;
    g.font = `${font}px ${MONO}`;
    g.fillText(hex2(r), left, mid);
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      let x = left + 3 * cw + 10 + ch * colW;
      const groups = formatCell(pattern.rows[r][ch]);
      groups.forEach((text, gi) => {
        x += GROUP_GAP[gi] * cw * 0.6;
        const empty = text.startsWith('-');
        const off = gi === 0 && text === '===';
        g.fillStyle = playing ? c.playInk : empty ? c.empty : off ? c.off : c.fields[gi];
        g.font = `${gi === 0 && !empty ? '700 ' : ''}${font}px ${MONO}`;
        g.fillText(empty ? EMPTY_GLYPH[gi] : text, x, mid);
        x += GROUP_CHARS[gi] * cw;
      });
    }
  }
}

export interface MediaOptions {
  loops: number;
  onProgress?: (seconds: number) => void;
  colors?: VideoColors;
}

/** The song as an MP3 file (LAME, compiled to WebAssembly, when the browser has no MP3 encoder). */
export async function exportMp3(song: Song, opts: MediaOptions): Promise<{ data: Uint8Array; seconds: number }> {
  const mb = await import('mediabunny');
  if (!(await mb.canEncodeAudio('mp3'))) {
    const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
    registerMp3Encoder();
  }
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.Mp3OutputFormat(), target });
  const source = new mb.AudioSampleSource({ codec: 'mp3', bitrate: 192000 });
  output.addAudioTrack(source);
  await output.start();
  const timeline = new Timeline(song, 44100, 10, opts.loops);
  let time = 0;
  for (let f = timeline.next(); f; f = timeline.next()) {
    const sample = audioSample(mb, f, 44100, time);
    await source.add(sample);
    sample.close();
    time = f.time;
    opts.onProgress?.(time);
  }
  await output.finalize();
  return { data: new Uint8Array(target.buffer!), seconds: time };
}

function audioSample(mb: typeof import('mediabunny'), f: TimelineFrame, rate: number, timestamp: number) {
  const n = f.left.length;
  const data = new Float32Array(n * 2);
  data.set(f.left, 0);
  data.set(f.right, n);
  return new mb.AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: rate, timestamp });
}

/** Whether this browser can make the MP4 video (H.264/AV1/VP9 and AAC/Opus through WebCodecs). */
export async function canExportVideo(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') return false;
  const mb = await import('mediabunny');
  const video = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: VIDEO_WIDTH, height: VIDEO_HEIGHT });
  const audio = await mb.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: MEDIA_RATE });
  return !!video && !!audio;
}

/** The song as an MP4 video, 1280×720 at 30 fps with the scopes and the pattern. */
export async function exportMp4(song: Song, opts: MediaOptions): Promise<{ data: Uint8Array; seconds: number }> {
  const mb = await import('mediabunny');
  const videoCodec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: VIDEO_WIDTH, height: VIDEO_HEIGHT });
  const audioCodec = await mb.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: MEDIA_RATE });
  if (!videoCodec || !audioCodec) throw new Error('This browser cannot encode video (WebCodecs).');
  const canvas = new OffscreenCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const g = canvas.getContext('2d')!;
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const video = new mb.CanvasSource(canvas, { codec: videoCodec, bitrate: mb.QUALITY_HIGH, keyFrameInterval: 2 });
  const audio = new mb.AudioSampleSource({ codec: audioCodec, bitrate: 192000 });
  output.addVideoTrack(video, { frameRate: VIDEO_FPS });
  output.addAudioTrack(audio);
  await output.start();
  const timeline = new Timeline(song, MEDIA_RATE, VIDEO_FPS, opts.loops);
  const colors = opts.colors ?? DEFAULT_COLORS;
  let time = 0;
  for (let f = timeline.next(); f; f = timeline.next()) {
    drawFrame(g, song, f, colors);
    await video.add(time, f.time - time);
    const sample = audioSample(mb, f, MEDIA_RATE, time);
    await audio.add(sample);
    sample.close();
    time = f.time;
    opts.onProgress?.(time);
  }
  await output.finalize();
  return { data: new Uint8Array(target.buffer!), seconds: time };
}
