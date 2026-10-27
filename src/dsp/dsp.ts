/**
 * Emulation of the SNES S-DSP (the sound chip next to the SPC700 in the APU).
 *
 * It runs at the hardware's native output rate of 32000 Hz and works on the
 * 64 KiB audio RAM the way the chip does: BRR samples are fetched through the
 * sample directory, decoded block by block, run through the 4-tap Gaussian
 * interpolation, scaled by the ADSR/GAIN envelope and the voice volumes, and
 * mixed together with the echo unit (8-tap FIR, feedback, ring buffer in
 * RAM). The order of operations, the rounding and clamping, the envelope rate
 * counter, the KON/KOFF timing (every other sample, 5 samples of key-on
 * delay), the noise LFSR, pitch modulation and the echo history follow the
 * behaviour documented for the real chip (fullsnes, anomie's DSP notes and
 * blargg's cycle-tested SPC_DSP), at sample rather than clock resolution.
 */
import { GAUSS } from './gauss';

export const DSP_RATE = 32000;
export const VOICE_COUNT = 8;

// Voice registers (add voice * 0x10).
export const V_VOLL = 0x00;
export const V_VOLR = 0x01;
export const V_PITCHL = 0x02;
export const V_PITCHH = 0x03;
export const V_SRCN = 0x04;
export const V_ADSR1 = 0x05;
export const V_ADSR2 = 0x06;
export const V_GAIN = 0x07;
export const V_ENVX = 0x08;
export const V_OUTX = 0x09;

// Global registers.
export const MVOLL = 0x0c;
export const MVOLR = 0x1c;
export const EVOLL = 0x2c;
export const EVOLR = 0x3c;
export const KON = 0x4c;
export const KOFF = 0x5c;
export const FLG = 0x6c;
export const ENDX = 0x7c;
export const EFB = 0x0d;
export const PMON = 0x2d;
export const NON = 0x3d;
export const EON = 0x4d;
export const DIR = 0x5d;
export const ESA = 0x6d;
export const EDL = 0x7d;
/** FIR coefficient i is at FIR + i * 0x10. */
export const FIR = 0x0f;

/** FLG bits */
export const FLG_RESET = 0x80;
export const FLG_MUTE = 0x40;
export const FLG_ECHO_OFF = 0x20;

const BRR_BLOCK = 9;
const BRR_BUF = 12;

const enum Env {
  Release,
  Attack,
  Decay,
  Sustain,
}

/** Samples between envelope/noise steps for each of the 32 rates (0: never). */
const COUNTER_RANGE = 2048 * 5 * 3;
export const COUNTER_RATES = [
  COUNTER_RANGE + 1, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32,
  24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1,
];
const COUNTER_OFFSETS = [
  1, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536,
  0, 1040, 536, 0, 1040, 0, 0,
];

const clamp16 = (v: number) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const s8 = (v: number) => (v << 24) >> 24;
const s16 = (v: number) => (v << 16) >> 16;

class Voice {
  /** Decoded samples, twice, so the interpolation never has to wrap. */
  readonly buf = new Int32Array(BRR_BUF * 2);
  bufPos = 0;
  interpPos = 0;
  brrAddr = 0;
  brrOffset = 1;
  konDelay = 0;
  envMode = Env.Release;
  env = 0;
  hiddenEnv = 0;
  /** Output before the volumes (also the PMON source for the next voice). */
  output = 0;
  constructor(readonly index: number) {}
  get bit() {
    return 1 << this.index;
  }
}

export interface DspOptions {
  /** Keep each voice's output (after volume, mono) for the oscilloscopes. */
  captureVoices?: boolean;
}

export class Dsp {
  /** The 64 KiB audio RAM shared with the SPC700. */
  readonly ram = new Uint8Array(0x10000);
  readonly regs = new Uint8Array(128);
  readonly voices = Array.from({ length: VOICE_COUNT }, (_, i) => new Voice(i));
  /** Voices silenced in the mix (a monitoring aid, not a hardware feature). */
  readonly muted: boolean[] = Array(VOICE_COUNT).fill(false);

  private everyOther = true;
  private newKon = 0;
  private kon = 0;
  private koff = 0;
  private counter = 0;
  private noise = 0x4000;
  // Registers latched at the end of a sample for the next one.
  private tPmon = 0;
  private tNon = 0;
  private tEon = 0;
  private tDir = 0;
  private tEsa = 0;
  // Echo
  private echoOffset = 0;
  private echoLength = 0;
  private readonly echoHist = [new Int32Array(16), new Int32Array(16)];
  private echoHistPos = 0;

  /** Stereo output, interleaved, filled by run(). */
  out: Int16Array = new Int16Array(0);
  outCount = 0;
  /** Per-voice output, VOICE_COUNT values per sample (when captured). */
  voiceOut: Int16Array = new Int16Array(0);
  readonly captureVoices: boolean;

  constructor(opts: DspOptions = {}) {
    this.captureVoices = !!opts.captureVoices;
    this.reset();
  }

  /** Power-on state: everything zero except FLG (reset, mute, echo writes off). */
  reset() {
    this.regs.fill(0);
    this.regs[FLG] = 0xe0;
    for (const v of this.voices) {
      v.buf.fill(0);
      v.bufPos = 0;
      v.interpPos = 0;
      v.brrAddr = 0;
      v.brrOffset = 1;
      v.konDelay = 0;
      v.envMode = Env.Release;
      v.env = 0;
      v.hiddenEnv = 0;
      v.output = 0;
    }
    this.everyOther = true;
    this.newKon = this.kon = this.koff = 0;
    this.counter = 0;
    this.noise = 0x4000;
    this.tPmon = this.tNon = this.tEon = this.tDir = this.tEsa = 0;
    this.echoOffset = this.echoLength = 0;
    this.echoHist[0].fill(0);
    this.echoHist[1].fill(0);
    this.echoHistPos = 0;
  }

  read(addr: number): number {
    return this.regs[addr & 0x7f];
  }

  write(addr: number, value: number) {
    addr &= 0x7f;
    value &= 0xff;
    // Writes to $80-$FF are ignored by the chip; the mask above is the SPC700 side mirror.
    switch (addr) {
      case KON:
        this.newKon = value;
        break;
      case ENDX:
        // Any write clears all bits.
        this.regs[ENDX] = 0;
        return;
    }
    this.regs[addr] = value;
  }

  /** Make room for `frames` more output samples. */
  private ensure(frames: number) {
    const need = (this.outCount + frames) * 2;
    if (this.out.length < need) {
      const next = new Int16Array(Math.max(need, this.out.length * 2, 1024));
      next.set(this.out.subarray(0, this.outCount * 2));
      this.out = next;
      if (this.captureVoices) {
        const v = new Int16Array(next.length / 2 * VOICE_COUNT);
        v.set(this.voiceOut.subarray(0, this.outCount * VOICE_COUNT));
        this.voiceOut = v;
      }
    }
  }

  /** Drop the first `frames` samples of the output buffer. */
  consume(frames: number) {
    const n = Math.min(frames, this.outCount);
    this.out.copyWithin(0, n * 2, this.outCount * 2);
    if (this.captureVoices) this.voiceOut.copyWithin(0, n * VOICE_COUNT, this.outCount * VOICE_COUNT);
    this.outCount -= n;
  }

  /** Generate `frames` output samples. */
  run(frames: number) {
    this.ensure(frames);
    for (let i = 0; i < frames; i++) this.sample();
  }

  private readCounter(rate: number): boolean {
    // True when the rate does not fire on this sample.
    return (this.counter + COUNTER_OFFSETS[rate]) % COUNTER_RATES[rate] !== 0;
  }

  private sample() {
    const regs = this.regs;
    const ram = this.ram;
    const flg = regs[FLG];
    let mainL = 0;
    let mainR = 0;
    let echoL = 0;
    let echoR = 0;
    let prevOutput = 0;
    const capture = this.captureVoices;
    const vo = this.outCount * VOICE_COUNT;

    for (const v of this.voices) {
      const base = v.index << 4;
      const bit = v.bit;

      // V2: sample directory entry (start address on key-on, loop address otherwise), BRR header, pitch.
      const entry = (this.tDir * 0x100 + regs[base + V_SRCN] * 4 + (v.konDelay ? 0 : 2)) & 0xffff;
      const brrNext = ram[entry] | (ram[(entry + 1) & 0xffff] << 8);
      let brrHeader = ram[v.brrAddr];
      let pitch = (regs[base + V_PITCHL] | (regs[base + V_PITCHH] << 8)) & 0x3fff;
      if (this.tPmon & bit) pitch += ((prevOutput >> 5) * pitch) >> 10;

      // V3c: key-on delay
      if (v.konDelay) {
        if (v.konDelay === 5) {
          v.brrAddr = brrNext;
          v.brrOffset = 1;
          v.bufPos = 0;
          brrHeader = 0; // ignored on this sample
        }
        v.env = 0;
        v.hiddenEnv = 0;
        v.interpPos = 0;
        if (--v.konDelay & 3) v.interpPos = 0x4000;
        pitch = 0;
      }

      // Gaussian interpolation of the four newest samples.
      let output: number;
      {
        const offset = (v.interpPos >> 4) & 0xff;
        const i = (v.interpPos >> 12) + v.bufPos;
        const b = v.buf;
        output = (GAUSS[255 - offset] * b[i]) >> 11;
        output += (GAUSS[511 - offset] * b[i + 1]) >> 11;
        output += (GAUSS[256 + offset] * b[i + 2]) >> 11;
        output = s16(output);
        output += (GAUSS[offset] * b[i + 3]) >> 11;
        output = clamp16(output) & ~1;
      }
      if (this.tNon & bit) output = s16(this.noise * 2);
      v.output = ((output * v.env) >> 11) & ~1;
      regs[base + V_ENVX] = v.env >> 4;
      regs[base + V_OUTX] = (v.output >> 8) & 0xff;

      // Immediate silence on soft reset or at the end of a sample without loop.
      if (flg & FLG_RESET || (brrHeader & 3) === 1) {
        v.envMode = Env.Release;
        v.env = 0;
      }
      if (this.everyOther) {
        if (this.koff & bit) v.envMode = Env.Release;
        if (this.kon & bit) {
          v.konDelay = 5;
          v.envMode = Env.Attack;
        }
      }
      if (!v.konDelay) this.runEnvelope(v);

      // V4: decode the next four samples when the interpolation has used up the last ones.
      let looped = 0;
      if (v.interpPos >= 0x4000) {
        this.decodeBrr(v, brrHeader);
        if ((v.brrOffset += 2) >= BRR_BLOCK) {
          v.brrAddr = (v.brrAddr + BRR_BLOCK) & 0xffff;
          if (brrHeader & 1) {
            v.brrAddr = brrNext;
            looped = bit;
          }
          v.brrOffset = 1;
        }
      }
      v.interpPos = (v.interpPos & 0x3fff) + pitch;
      if (v.interpPos > 0x7fff) v.interpPos = 0x7fff;

      // Volumes and mixing.
      const amp = this.muted[v.index] ? 0 : v.output;
      const l = (amp * s8(regs[base + V_VOLL])) >> 7;
      const r = (amp * s8(regs[base + V_VOLR])) >> 7;
      mainL = clamp16(mainL + l);
      mainR = clamp16(mainR + r);
      if (this.tEon & bit) {
        echoL = clamp16(echoL + l);
        echoR = clamp16(echoR + r);
      }
      if (capture) this.voiceOut[vo + v.index] = clamp16((l + r) >> 1);
      prevOutput = v.output;

      // V5: ENDX
      let endx = regs[ENDX] | looped;
      if (v.konDelay === 5) endx &= ~bit;
      regs[ENDX] = endx;
    }

    // Echo: read the ring buffer, FIR filter, output, feedback, write back.
    const echoPtr = (this.tEsa * 0x100 + this.echoOffset) & 0xffff;
    this.echoHistPos = (this.echoHistPos + 1) & 7;
    const hp = this.echoHistPos;
    const inL = s16(ram[echoPtr] | (ram[(echoPtr + 1) & 0xffff] << 8)) >> 1;
    const inR = s16(ram[(echoPtr + 2) & 0xffff] | (ram[(echoPtr + 3) & 0xffff] << 8)) >> 1;
    this.echoHist[0][hp] = this.echoHist[0][hp + 8] = inL;
    this.echoHist[1][hp] = this.echoHist[1][hp + 8] = inR;
    const firIn = [0, 0];
    for (let ch = 0; ch < 2; ch++) {
      const h = this.echoHist[ch];
      const tap = (i: number) => (h[hp + i + 1] * s8(regs[FIR + i * 0x10])) >> 6;
      let acc = tap(0) + tap(1) + tap(2) + tap(3) + tap(4) + tap(5) + tap(6);
      acc = s16(acc);
      acc += s16(tap(7));
      firIn[ch] = clamp16(acc) & ~1;
    }

    const outL = clamp16(s16((mainL * s8(regs[MVOLL])) >> 7) + s16((firIn[0] * s8(regs[EVOLL])) >> 7));
    const outR = clamp16(s16((mainR * s8(regs[MVOLR])) >> 7) + s16((firIn[1] * s8(regs[EVOLR])) >> 7));

    const efb = s8(regs[EFB]);
    const fbL = clamp16(echoL + s16((firIn[0] * efb) >> 7)) & ~1;
    const fbR = clamp16(echoR + s16((firIn[1] * efb) >> 7)) & ~1;

    const o = this.outCount * 2;
    if (flg & FLG_MUTE) {
      this.out[o] = 0;
      this.out[o + 1] = 0;
    } else {
      this.out[o] = outL;
      this.out[o + 1] = outR;
    }
    this.outCount++;

    // ESA and EDL take effect when the buffer wraps.
    this.tEsa = regs[ESA];
    if (!this.echoOffset) this.echoLength = (regs[EDL] & 0x0f) * 0x800;
    this.echoOffset += 4;
    if (this.echoOffset >= this.echoLength) this.echoOffset = 0;
    if (!(flg & FLG_ECHO_OFF)) {
      ram[echoPtr] = fbL & 0xff;
      ram[(echoPtr + 1) & 0xffff] = (fbL >> 8) & 0xff;
      ram[(echoPtr + 2) & 0xffff] = fbR & 0xff;
      ram[(echoPtr + 3) & 0xffff] = (fbR >> 8) & 0xff;
    }

    // Registers latched for the next sample, KON/KOFF every other sample, counters and noise.
    this.tPmon = regs[PMON] & 0xfe; // voice 0 has no PMON
    this.tNon = regs[NON];
    this.tEon = regs[EON];
    this.tDir = regs[DIR];
    this.everyOther = !this.everyOther;
    if (this.everyOther) this.newKon &= ~this.kon;
    if (this.everyOther) {
      this.kon = this.newKon;
      this.koff = regs[KOFF];
    }
    if (--this.counter < 0) this.counter = COUNTER_RANGE - 1;
    if (!this.readCounter(regs[FLG] & 0x1f)) {
      const feedback = (this.noise << 13) ^ (this.noise << 14);
      this.noise = (feedback & 0x4000) ^ (this.noise >> 1);
    }
  }

  private decodeBrr(v: Voice, header: number) {
    const ram = this.ram;
    const nybbles = (ram[(v.brrAddr + v.brrOffset) & 0xffff] << 8) | ram[(v.brrAddr + v.brrOffset + 1) & 0xffff];
    const shift = header >> 4;
    const filter = header & 0x0c;
    const buf = v.buf;
    let pos = v.bufPos;
    for (let n = 12; n >= 0; n -= 4) {
      let s = ((nybbles >> n) << 28) >> 28; // sign-extended 4-bit value
      s = (s << shift) >> 1;
      if (shift >= 0xd) s = s < 0 ? -2048 : 0;
      const p1 = buf[pos + BRR_BUF - 1];
      const p2 = buf[pos + BRR_BUF - 2] >> 1;
      if (filter >= 8) {
        s += p1;
        s -= p2;
        if (filter === 8) {
          s += p2 >> 4;
          s += (p1 * -3) >> 6;
        } else {
          s += (p1 * -13) >> 7;
          s += (p2 * 3) >> 4;
        }
      } else if (filter) {
        s += p1 >> 1;
        s += -p1 >> 5;
      }
      s = s16(clamp16(s) * 2);
      buf[pos] = buf[pos + BRR_BUF] = s;
      pos++;
    }
    v.bufPos = pos >= BRR_BUF ? 0 : pos;
  }

  private runEnvelope(v: Voice) {
    let env = v.env;
    if (v.envMode === Env.Release) {
      env -= 8;
      v.env = env < 0 ? 0 : env;
      return;
    }
    const base = v.index << 4;
    const adsr1 = this.regs[base + V_ADSR1];
    let envData = this.regs[base + V_ADSR2];
    let rate: number;
    if (adsr1 & 0x80) {
      if (v.envMode >= Env.Decay) {
        env--;
        env -= env >> 8;
        rate = envData & 0x1f;
        if (v.envMode === Env.Decay) rate = ((adsr1 >> 3) & 0x0e) + 0x10;
      } else {
        rate = (adsr1 & 0x0f) * 2 + 1;
        env += rate < 31 ? 0x20 : 0x400;
      }
    } else {
      envData = this.regs[base + V_GAIN];
      const mode = envData >> 5;
      if (mode < 4) {
        env = envData * 0x10;
        rate = 31;
      } else {
        rate = envData & 0x1f;
        if (mode === 4) env -= 0x20;
        else if (mode < 6) {
          env--;
          env -= env >> 8;
        } else {
          env += 0x20;
          if (mode > 6 && v.hiddenEnv >>> 0 >= 0x600) env += 0x8 - 0x20;
        }
      }
    }
    if (env >> 8 === envData >> 5 && v.envMode === Env.Decay) v.envMode = Env.Sustain;
    v.hiddenEnv = env;
    if (env >>> 0 > 0x7ff) {
      env = env < 0 ? 0 : 0x7ff;
      if (v.envMode === Env.Attack) v.envMode = Env.Decay;
    }
    if (!this.readCounter(rate)) v.env = env;
  }
}
