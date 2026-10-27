import { DSP_RATE, Dsp, VOICE_COUNT } from '../dsp/dsp';
import { layoutAram, loadAram } from '../tracker/aram';
import { Player, SAMPLES_PER_UNIT } from '../tracker/player';
import { Song } from '../tracker/song';

/**
 * DSP + player, clocked together: the player ticks every `units` timer
 * periods (4 DSP samples each), exactly like a driver running from the
 * SPC700's timer 0. The DSP runs at 32 kHz; `render` resamples to the output
 * rate with cubic interpolation.
 */
export class Engine {
  readonly dsp: Dsp;
  readonly player: Player;
  private untilTick = 0;
  /** DSP samples not yet consumed by the resampler: the last 4 for interpolation. */
  private hist = new Float32Array(8);
  private histVoices = new Float32Array(4 * VOICE_COUNT);
  private frac = 0;
  private readonly step: number;

  constructor(
    song: Song,
    readonly sampleRate = DSP_RATE,
    readonly captureVoices = false,
  ) {
    this.dsp = new Dsp({ captureVoices });
    this.player = new Player(song);
    this.step = DSP_RATE / sampleRate;
    this.loadSamples(song);
    this.player.init(this.dsp);
  }

  private loadSamples(song: Song) {
    loadAram(this.dsp.ram, layoutAram(song));
  }

  /** New song data. Samples are reloaded when they or the echo size changed. */
  setSong(song: Song) {
    const old = this.player.song;
    const reload = old.samples !== song.samples || old.echo.delay !== song.echo.delay || JSON.stringify(old.samples) !== JSON.stringify(song.samples);
    this.player.setSong(song);
    if (reload) {
      this.loadSamples(song);
      this.player.init(this.dsp);
    } else this.player.applyGlobals(this.dsp);
  }

  play(order = 0, row = 0, loopPattern = false) {
    this.player.loopPattern = loopPattern;
    this.player.start(this.dsp, order, row);
    this.untilTick = 0;
  }

  stop() {
    this.player.stop(this.dsp);
  }

  /** Run the DSP (and the player) for `n` samples at 32 kHz; output lands in dsp.out. */
  private runDsp(n: number) {
    while (n > 0) {
      if (this.untilTick <= 0) {
        this.player.tick(this.dsp);
        this.untilTick += this.player.units * SAMPLES_PER_UNIT;
      }
      const k = Math.min(n, this.untilTick);
      this.dsp.run(k);
      this.untilTick -= k;
      n -= k;
    }
  }

  /** Render at the DSP's own rate: 16-bit stereo, interleaved. */
  renderNative(frames: number): Int16Array {
    this.runDsp(frames);
    const out = this.dsp.out.slice(0, frames * 2);
    this.dsp.consume(frames);
    return out;
  }

  /**
   * Render `frames` stereo samples at the output rate, -1..1. Per-voice output
   * (if captured) is written to `voices` as VOICE_COUNT values per frame.
   */
  render(left: Float32Array, right: Float32Array, frames: number, voices?: Float32Array) {
    const dsp = this.dsp;
    const capture = !!voices && this.captureVoices;
    if (this.step === 1) {
      this.runDsp(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = dsp.out[i * 2] / 32768;
        right[i] = dsp.out[i * 2 + 1] / 32768;
      }
      if (capture) for (let i = 0; i < frames * VOICE_COUNT; i++) voices[i] = dsp.voiceOut[i] / 32768;
      dsp.consume(frames);
      return;
    }
    const h = this.hist;
    const hv = this.histVoices;
    let used = 0;
    let frac = this.frac;
    for (let i = 0; i < frames; i++) {
      while (frac >= 1) {
        if (used >= dsp.outCount) this.runDsp(64);
        // Shift in the next DSP sample.
        h.copyWithin(0, 2);
        h[6] = dsp.out[used * 2] / 32768;
        h[7] = dsp.out[used * 2 + 1] / 32768;
        if (capture) {
          hv.copyWithin(0, VOICE_COUNT);
          for (let v = 0; v < VOICE_COUNT; v++) hv[3 * VOICE_COUNT + v] = dsp.voiceOut[used * VOICE_COUNT + v] / 32768;
        }
        used++;
        frac -= 1;
      }
      left[i] = cubic(h[0], h[2], h[4], h[6], frac);
      right[i] = cubic(h[1], h[3], h[5], h[7], frac);
      if (capture) for (let v = 0; v < VOICE_COUNT; v++) voices[i * VOICE_COUNT + v] = hv[2 * VOICE_COUNT + v];
      frac += this.step;
    }
    // Samples produced but not yet shifted in stay for the next call.
    dsp.consume(used);
    this.frac = frac;
  }
}

/** Catmull-Rom interpolation between y1 and y2. */
function cubic(y0: number, y1: number, y2: number, y3: number, t: number) {
  return y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
}
