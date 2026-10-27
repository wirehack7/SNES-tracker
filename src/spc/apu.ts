/**
 * The SNES audio unit: the SPC700 with its I/O registers, three timers and
 * the IPL boot ROM around the S-DSP and its 64 KiB of RAM. It plays any SPC
 * file, whatever sound driver the game used.
 *
 * The CPU runs at 1.024 MHz, 32 cycles per DSP sample. Timers 0 and 1 count
 * at 8 kHz (every 128 cycles), timer 2 at 64 kHz (every 16 cycles).
 */
import { DSP_RATE, Dsp, KON } from '../dsp/dsp';
import { Bus, Spc700 } from './cpu';

export const CPU_RATE = 1024000;
export const CYCLES_PER_SAMPLE = CPU_RATE / DSP_RATE;

/** The 64-byte boot ROM at $FFC0: it waits for the SNES CPU to upload a program through the ports. */
export const IPL_ROM = Uint8Array.from([
  0xcd, 0xef, 0xbd, 0xe8, 0x00, 0xc6, 0x1d, 0xd0, 0xfc, 0x8f, 0xaa, 0xf4, 0x8f, 0xbb, 0xf5, 0x78,
  0xcc, 0xf4, 0xd0, 0xfb, 0x2f, 0x19, 0xeb, 0xf4, 0xd0, 0xfc, 0x7e, 0xf4, 0xd0, 0x0b, 0xe4, 0xf5,
  0xcb, 0xf4, 0xd7, 0x00, 0xfc, 0xd0, 0xf3, 0xab, 0x01, 0x10, 0xef, 0x7e, 0xf4, 0x10, 0xeb, 0xba,
  0xf6, 0xda, 0x00, 0xba, 0xf4, 0xc4, 0xf4, 0xdd, 0x5d, 0xd0, 0xdb, 0x1f, 0x00, 0x00, 0xc0, 0xff,
]);

class Timer {
  enabled = false;
  /** Divider ($FA-$FC); 0 counts 256. */
  target = 0;
  stage = 0;
  /** The 4-bit counter the CPU reads ($FD-$FF). */
  counter = 0;

  tick() {
    if (!this.enabled) return;
    this.stage = (this.stage + 1) & 0xff;
    if (this.stage === this.target) {
      this.stage = 0;
      this.counter = (this.counter + 1) & 15;
    }
  }
}

export class Apu implements Bus {
  readonly cpu: Spc700;
  readonly ram: Uint8Array;
  readonly timers = [new Timer(), new Timer(), new Timer()];
  /** Values the SNES CPU left in the ports ($F4-$F7, read by the SPC700). */
  readonly inPorts = new Uint8Array(4);
  /** Values the SPC700 wrote to the ports (for the SNES CPU). */
  readonly outPorts = new Uint8Array(4);
  iplEnabled = true;
  /** Called after each write to a DSP register (for watching what a driver plays). */
  onDspWrite?: (register: number, value: number) => void;
  /** Called before each read of a DSP register. */
  onDspRead?: (register: number) => void;
  dspAddr = 0;
  /** CPU cycles owed to (positive) or run ahead of (negative) the DSP. */
  private budget = 0;
  /**
   * Skip the cycles a driver spends waiting for a timer (it read a counter
   * as 0): its notes come out the same, at most a timer period later, for a
   * fraction of the work. For watching a driver, not for listening.
   */
  skipIdle = false;
  private idleTimer = -1;
  private fastClock = 0;
  private slowClock = 0;

  constructor(readonly dsp: Dsp) {
    this.ram = dsp.ram;
    this.cpu = new Spc700(this);
  }

  /** Power on: RAM cleared, PC at the boot ROM. */
  reset() {
    this.ram.fill(0);
    this.dsp.reset();
    this.inPorts.fill(0);
    this.outPorts.fill(0);
    for (const t of this.timers) Object.assign(t, { enabled: false, target: 0, stage: 0, counter: 0 });
    this.iplEnabled = true;
    this.dspAddr = 0;
    this.budget = this.fastClock = this.slowClock = 0;
    Object.assign(this.cpu, { a: 0, x: 0, y: 0, sp: 0xef, pc: 0xffc0, halted: false, cycles: 0 });
    this.cpu.psw = 0x02;
  }

  /** Restores the state saved in an SPC file. */
  load(spc: Uint8Array) {
    this.reset();
    this.ram.set(spc.subarray(0x100, 0x10100));
    // The 64 bytes of RAM under the boot ROM are kept apart in the file.
    if (spc.length >= 0x10200) this.ram.set(spc.subarray(0x101c0, 0x10200), 0xffc0);
    const regs = spc.subarray(0x10100, 0x10180);
    this.dsp.regs.set(regs);
    // KON was already acted on when the snapshot was taken.
    this.dsp.regs[KON] = 0;
    const cpu = this.cpu;
    cpu.pc = spc[0x25] | (spc[0x26] << 8);
    cpu.a = spc[0x27];
    cpu.x = spc[0x28];
    cpu.y = spc[0x29];
    cpu.psw = spc[0x2a];
    cpu.sp = spc[0x2b];
    const control = this.ram[0xf1];
    this.iplEnabled = (control & 0x80) !== 0;
    this.timers.forEach((t, i) => {
      t.enabled = ((control >> i) & 1) !== 0;
      t.target = this.ram[0xfa + i];
      t.counter = this.ram[0xfd + i] & 15;
    });
    this.dspAddr = this.ram[0xf2];
    this.inPorts.set(this.ram.subarray(0xf4, 0xf8));
  }

  read(addr: number): number {
    if (addr >= 0xf0 && addr <= 0xff) {
      switch (addr) {
        case 0xf2:
          return this.dspAddr;
        case 0xf3:
          this.onDspRead?.(this.dspAddr & 0x7f);
          return this.dsp.read(this.dspAddr & 0x7f);
        case 0xf4:
        case 0xf5:
        case 0xf6:
        case 0xf7:
          return this.inPorts[addr - 0xf4];
        case 0xf8:
        case 0xf9:
          return this.ram[addr];
        case 0xfd:
        case 0xfe:
        case 0xff: {
          const t = this.timers[addr - 0xfd];
          const v = t.counter;
          t.counter = 0;
          if (!v && this.skipIdle && t.enabled) this.idleTimer = addr - 0xfd;
          return v;
        }
        default:
          // $F0, $F1 and the timer dividers are write-only.
          return 0;
      }
    }
    if (addr >= 0xffc0 && this.iplEnabled) return IPL_ROM[addr - 0xffc0];
    return this.ram[addr];
  }

  write(addr: number, value: number) {
    if (addr >= 0xf0 && addr <= 0xff) {
      switch (addr) {
        case 0xf1:
          this.timers.forEach((t, i) => {
            const on = ((value >> i) & 1) !== 0;
            // Switching a timer on restarts it.
            if (on && !t.enabled) t.stage = t.counter = 0;
            t.enabled = on;
          });
          if (value & 0x10) this.inPorts[0] = this.inPorts[1] = 0;
          if (value & 0x20) this.inPorts[2] = this.inPorts[3] = 0;
          this.iplEnabled = (value & 0x80) !== 0;
          break;
        case 0xf2:
          this.dspAddr = value;
          break;
        case 0xf3:
          // $80-$FF are read-only mirrors.
          if (this.dspAddr < 0x80) {
            this.dsp.write(this.dspAddr, value);
            this.onDspWrite?.(this.dspAddr, value);
          }
          break;
        case 0xf4:
        case 0xf5:
        case 0xf6:
        case 0xf7:
          this.outPorts[addr - 0xf4] = value;
          return;
        case 0xfa:
        case 0xfb:
        case 0xfc:
          this.timers[addr - 0xfa].target = value;
          break;
      }
    }
    // Writes reach RAM, also under the boot ROM and the registers.
    this.ram[addr] = value;
  }

  /** Runs the CPU for `cycles`, ticking the timers after each instruction. */
  runCpu(cycles: number) {
    this.budget += cycles;
    while (this.budget > 0) {
      if (this.idleTimer >= 0) {
        // The driver waits for a timer that has not counted yet: jump to the cycle it does.
        const t = this.timers[this.idleTimer];
        const period = this.idleTimer === 2 ? 16 : 128;
        const clock = this.idleTimer === 2 ? this.fastClock : this.slowClock;
        const ticks = ((t.target - t.stage - 1) & 0xff) + 1;
        const n = Math.min(this.budget, period - clock + (ticks - 1) * period);
        this.idleTimer = -1;
        this.cpu.cycles += n;
        this.advance(n);
        continue;
      }
      this.advance(this.cpu.step());
    }
  }

  /** Time passes: the budget goes down and the timers count. */
  private advance(n: number) {
    this.budget -= n;
    this.fastClock += n;
    while (this.fastClock >= 16) {
      this.fastClock -= 16;
      this.timers[2].tick();
    }
    this.slowClock += n;
    while (this.slowClock >= 128) {
      this.slowClock -= 128;
      this.timers[0].tick();
      this.timers[1].tick();
    }
  }

  /** Runs CPU and DSP for `frames` samples at 32 kHz; the output lands in dsp.out. */
  run(frames: number) {
    for (let i = 0; i < frames; i++) {
      this.runCpu(CYCLES_PER_SAMPLE);
      this.dsp.run(1);
    }
  }
}
