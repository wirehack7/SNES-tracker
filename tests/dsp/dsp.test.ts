import { describe, expect, it } from 'vitest';
import { encodeBrr } from '../../src/dsp/brr';
import {
  DIR,
  DSP_RATE,
  Dsp,
  EDL,
  EFB,
  EON,
  ESA,
  EVOLL,
  EVOLR,
  FIR,
  FLG,
  FLG_ECHO_OFF,
  FLG_MUTE,
  FLG_RESET,
  KOFF,
  KON,
  MVOLL,
  MVOLR,
  NON,
  PMON,
  V_ADSR1,
  V_ADSR2,
  V_ENVX,
  V_GAIN,
  V_OUTX,
  V_PITCHH,
  V_PITCHL,
  V_SRCN,
  V_VOLL,
  V_VOLR,
  VOICE_COUNT,
} from '../../src/dsp/dsp';

const SAMPLE_ADDR = 0x1000;
const DIR_ADDR = 0x0200;

/** A DSP with one looping sample (a square wave) in its RAM, ready to play. */
function dsp(pcm = squareWave(), { loop = true } = {}) {
  const d = new Dsp();
  const brr = encodeBrr(pcm, loop ? { loopBlock: 0 } : {});
  d.ram.set(brr, SAMPLE_ADDR);
  // Directory entry 0: start and loop address.
  d.ram.set([SAMPLE_ADDR & 0xff, SAMPLE_ADDR >> 8, SAMPLE_ADDR & 0xff, SAMPLE_ADDR >> 8], DIR_ADDR);
  d.write(FLG, 0x20); // out of reset, not muted, echo writes off
  d.write(DIR, DIR_ADDR >> 8);
  d.write(MVOLL, 0x7f);
  d.write(MVOLR, 0x7f);
  d.write(V_SRCN, 0);
  d.write(V_VOLL, 0x7f);
  d.write(V_VOLR, 0x7f);
  d.write(V_PITCHL, 0x00);
  d.write(V_PITCHH, 0x10); // play at the sample's own rate
  d.write(V_GAIN, 0x7f); // direct gain, full level
  d.write(V_ADSR1, 0x00); // GAIN mode
  return d;
}

function squareWave(period = 32, amp = 16000) {
  return Array.from({ length: period * 4 }, (_, i) => (i % period < period / 2 ? amp : -amp));
}

/** Runs `frames` samples and returns the interleaved output. */
function render(d: Dsp, frames: number): Int16Array {
  d.run(frames);
  const out = d.out.slice(0, frames * 2);
  d.consume(frames);
  return out;
}

const peak = (data: ArrayLike<number>) => {
  let p = 0;
  for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
  return p;
};

describe('S-DSP', () => {
  it('starts a voice five samples after KON', () => {
    const d = dsp();
    d.write(KON, 1);
    const out = render(d, 16);
    // The first samples are still silent while the voice starts up.
    expect(out[0]).toBe(0);
    expect(peak(out.subarray(0, 8))).toBe(0);
    expect(peak(out.subarray(12, 32))).toBeGreaterThan(1000);
  });

  it('reads the envelope back through ENVX and OUTX', () => {
    const d = dsp();
    d.write(KON, 1);
    render(d, 64);
    expect(d.read(V_ENVX)).toBe(0x7f);
    expect(Math.abs((d.read(V_OUTX) << 24) >> 24)).toBeGreaterThan(0);
  });

  it('runs an ADSR attack, decay and sustain', () => {
    const d = dsp();
    // Attack rate 12 (about 16 ms), decay 7 (fastest), sustain level 3/8, sustain rate 0 (hold).
    d.write(V_ADSR1, 0x80 | (7 << 4) | 12);
    d.write(V_ADSR2, (3 << 5) | 0);
    d.write(KON, 1);
    render(d, 16);
    const early = d.read(V_ENVX);
    render(d, DSP_RATE / 100); // 10 ms
    const mid = d.read(V_ENVX);
    expect(mid).toBeGreaterThan(early);
    render(d, DSP_RATE / 10); // 100 ms: attack and decay are over
    const held = d.read(V_ENVX);
    expect(held).toBeGreaterThan(0x30);
    expect(held).toBeLessThan(0x45); // the 4/8 sustain level of 0x7f
    render(d, DSP_RATE / 2);
    expect(d.read(V_ENVX)).toBe(held); // sustain rate 0 holds
  });

  it('fades out on KOFF and reports the voice as ended', () => {
    const d = dsp();
    d.write(KON, 1);
    render(d, 256);
    expect(d.read(V_ENVX)).toBeGreaterThan(0);
    d.write(KOFF, 1);
    render(d, 512); // key off takes about 256 samples
    expect(d.read(V_ENVX)).toBe(0);
    expect(peak(render(d, 64))).toBe(0);
  });

  it('plays a one-shot sample to its end and sets ENDX', () => {
    const d = dsp(squareWave(16, 12000), { loop: false });
    d.write(KON, 1);
    render(d, 256);
    expect(d.read(0x7c) & 1).toBe(1); // ENDX
    expect(peak(render(d, 64))).toBe(0);
  });

  it('plays an octave up at twice the pitch', () => {
    const low = dsp();
    low.write(KON, 1);
    const high = dsp();
    high.write(V_PITCHH, 0x20);
    high.write(KON, 1);
    const a = render(low, 2048);
    const b = render(high, 2048);
    const zeros = (out: Int16Array) => {
      let n = 0;
      for (let i = 2; i < out.length; i += 2) if (out[i - 2] < 0 && out[i] >= 0) n++;
      return n;
    };
    expect(zeros(b)).toBeGreaterThan(zeros(a) * 1.8);
  });

  it('pans with the left and right voice volumes', () => {
    const d = dsp();
    d.write(V_VOLR, 0);
    d.write(KON, 1);
    const out = render(d, 512);
    const left = peak(out.filter((_, i) => i % 2 === 0));
    const right = peak(out.filter((_, i) => i % 2 === 1));
    expect(left).toBeGreaterThan(1000);
    expect(right).toBe(0);
  });

  it('mutes and resets with the FLG bits', () => {
    const d = dsp();
    d.write(KON, 1);
    render(d, 64);
    d.write(FLG, FLG_MUTE | FLG_ECHO_OFF);
    expect(peak(render(d, 64))).toBe(0);
    d.write(FLG, FLG_ECHO_OFF);
    expect(peak(render(d, 64))).toBeGreaterThan(0);
    d.write(FLG, FLG_RESET | FLG_ECHO_OFF);
    render(d, 8);
    expect(d.read(V_ENVX)).toBe(0);
  });

  it('plays noise instead of the sample when NON is set', () => {
    const d = dsp();
    d.write(NON, 1);
    d.write(FLG, FLG_ECHO_OFF | 20); // noise clock 20
    d.write(KON, 1);
    const out = render(d, 4096);
    expect(peak(out)).toBeGreaterThan(1000);
    // Noise is not periodic: the signal differs from itself one sample-period later.
    let same = 0;
    for (let i = 0; i + 64 < out.length; i += 2) if (out[i] === out[i + 64]) same++;
    expect(same).toBeLessThan(out.length / 4);
  });

  it('modulates the pitch of the next voice with PMON', () => {
    const plain = dsp();
    plain.write(KON, 2); // voice 1 only
    const modulated = dsp();
    modulated.write(PMON, 2);
    modulated.write(KON, 3); // voices 0 and 1; voice 0 modulates voice 1
    const copy = (d: Dsp) => {
      for (const reg of [V_VOLL, V_VOLR, V_PITCHL, V_PITCHH, V_SRCN, V_ADSR1, V_GAIN]) d.write(0x10 | reg, d.read(reg));
    };
    copy(plain);
    copy(modulated);
    plain.write(KON, 2);
    modulated.write(KON, 3);
    const a = render(plain, 2048);
    const b = render(modulated, 2048);
    expect(Array.from(b)).not.toEqual(Array.from(a));
  });

  it('delays the echo by the EDL time and feeds it back', () => {
    const d = dsp();
    d.write(EON, 1);
    d.write(EVOLL, 0x50);
    d.write(EVOLR, 0x50);
    d.write(EFB, 0x40);
    d.write(EDL, 2); // 32 ms
    d.write(ESA, 0xf0); // echo buffer at $F000
    d.write(FIR, 0x7f); // first tap only
    for (let i = 1; i < 8; i++) d.write(FIR + i * 0x10, 0);
    d.write(FLG, 0); // echo writes on
    d.write(KON, 1);
    render(d, 2000); // 62 ms: the first echo is already in the buffer
    d.write(KOFF, 1);
    render(d, 600); // the voice is silent now
    const tail = render(d, 600);
    expect(peak(tail)).toBeGreaterThan(200); // the echo plays on
    // The buffer holds 32 ms of stereo samples.
    expect(d.ram[0xf000] !== 0 || d.ram[0xf001] !== 0).toBe(true);
  });

  it('writes nothing into the echo buffer while echo writes are off', () => {
    const d = dsp();
    d.write(EON, 1);
    d.write(EDL, 1);
    d.write(ESA, 0xf0);
    d.write(FLG, FLG_ECHO_OFF);
    d.write(KON, 1);
    render(d, 2000);
    expect(d.ram.subarray(0xf000, 0xf800).some((b) => b !== 0)).toBe(false);
  });

  it('has eight independent voices', () => {
    const d = dsp();
    expect(VOICE_COUNT).toBe(8);
    for (let v = 1; v < VOICE_COUNT; v++) {
      d.write(v * 0x10 + V_SRCN, 0);
      d.write(v * 0x10 + V_VOLL, 0x7f);
      d.write(v * 0x10 + V_VOLR, 0x7f);
      d.write(v * 0x10 + V_PITCHH, 0x10);
      d.write(v * 0x10 + V_GAIN, 0x7f);
    }
    d.write(KON, 0xff);
    const all = peak(render(d, 512));
    const one = dsp();
    one.write(KON, 1);
    expect(all).toBeGreaterThan(peak(render(one, 512)));
  });

  it('can mute single voices without changing the others', () => {
    const d = dsp();
    d.muted[0] = true;
    d.write(KON, 1);
    expect(peak(render(d, 512))).toBe(0);
    d.muted[0] = false;
    expect(peak(render(d, 512))).toBeGreaterThan(0);
  });
});
