/**
 * Enough of an SPC700 to run the exported driver: the opcodes it uses, the
 * registers it touches ($F1 control, $FA timer 0 divider, $F2/$F3 the DSP
 * port, $FD the timer 0 counter) and timer 0 itself.
 *
 * The CPU runs at 1.024 MHz, so one timer 0 period (its divider × 128 cycles
 * at 8 kHz) is 128 cycles per divider step. Instruction timings are the ones
 * from the manual; they only have to be close enough for the driver's waits
 * to land on the same ticks the tracker played.
 */
export interface DspWrite {
  /** Timer 0 periods (125 µs) since the start. */
  time: number;
  register: number;
  value: number;
}

const CYCLES: Record<number, number> = {
  0xcd: 2, 0xbd: 2, 0x8f: 5, 0xe4: 3, 0x8d: 2, 0xf7: 6, 0x3a: 6, 0x30: 2, 0xc4: 4,
  0x2f: 4, 0x68: 2, 0xf0: 2, 0x28: 2, 0x7a: 5, 0xda: 5, 0x5a: 4, 0x90: 2, 0x9a: 5,
  0x6e: 5, 0xba: 5, 0xb0: 2,
};

export class Spc700 {
  pc = 0;
  a = 0;
  x = 0;
  y = 0;
  sp = 0xff;
  carry = false;
  zero = false;
  negative = false;
  /** Cycles run so far (1.024 MHz). */
  cycles = 0;
  /** Timer 0 counter ($FD), 4 bits, cleared by a read. */
  private counter = 0;
  private timerOn = false;
  private divider = 1;
  private timerCycles = 0;
  readonly writes: DspWrite[] = [];
  private dspAddress = 0;

  constructor(readonly ram: Uint8Array) {}

  /** Timer 0 periods since the start, however the timer is divided. */
  get time() {
    return this.cycles / 128;
  }

  private read(addr: number): number {
    if (addr === 0xfd) {
      const v = this.counter;
      this.counter = 0;
      return v;
    }
    return this.ram[addr];
  }

  private write(addr: number, value: number) {
    if (addr === 0xf1) {
      this.timerOn = (value & 1) !== 0;
      if (value & 0x10) this.counter = 0;
      this.timerCycles = 0;
    } else if (addr === 0xfa) {
      this.divider = value === 0 ? 256 : value;
    } else if (addr === 0xf2) {
      this.dspAddress = value & 0x7f;
    } else if (addr === 0xf3) {
      this.writes.push({ time: this.time, register: this.dspAddress, value });
    } else {
      this.ram[addr] = value;
    }
  }

  private byte() {
    return this.ram[this.pc++];
  }

  private rel() {
    const off = this.byte();
    return off < 0x80 ? off : off - 256;
  }

  private word(addr: number) {
    return this.ram[addr] | (this.ram[addr + 1] << 8);
  }

  private setWord(addr: number, v: number) {
    this.ram[addr] = v & 0xff;
    this.ram[addr + 1] = (v >> 8) & 0xff;
  }

  private nz(v: number) {
    this.zero = (v & 0xff) === 0;
    this.negative = (v & 0x80) !== 0;
    return v & 0xff;
  }

  private nz16(v: number) {
    this.zero = (v & 0xffff) === 0;
    this.negative = (v & 0x8000) !== 0;
    return v & 0xffff;
  }

  private tick(cycles: number) {
    this.cycles += cycles;
    if (!this.timerOn) return;
    this.timerCycles += cycles;
    const step = 128 * this.divider;
    while (this.timerCycles >= step) {
      this.timerCycles -= step;
      this.counter = (this.counter + 1) & 15;
    }
  }

  /** Run one instruction. Returns false on an opcode this subset does not have. */
  step(): boolean {
    const op = this.byte();
    this.tick(CYCLES[op] ?? 2);
    switch (op) {
      case 0xcd: // mov x,#imm
        this.x = this.nz(this.byte());
        return true;
      case 0xbd: // mov sp,x
        this.sp = this.x;
        return true;
      case 0x8f: {
        // mov dp,#imm
        const imm = this.byte();
        this.write(this.byte(), imm);
        return true;
      }
      case 0xe4: // mov a,dp
        this.a = this.nz(this.read(this.byte()));
        return true;
      case 0x8d: // mov y,#imm
        this.y = this.nz(this.byte());
        return true;
      case 0xf7: {
        // mov a,[dp]+y
        const dp = this.byte();
        this.a = this.nz(this.read((this.word(dp) + this.y) & 0xffff));
        return true;
      }
      case 0x3a: {
        // incw dp
        const dp = this.byte();
        this.setWord(dp, this.nz16(this.word(dp) + 1));
        return true;
      }
      case 0xc4: // mov dp,a
        this.write(this.byte(), this.a);
        return true;
      case 0x2f: {
        // bra
        const off = this.rel();
        this.pc += off;
        return true;
      }
      case 0x30: {
        // bmi
        const off = this.rel();
        if (this.negative) {
          this.pc += off;
          this.tick(2);
        }
        return true;
      }
      case 0xf0: {
        // beq
        const off = this.rel();
        if (this.zero) {
          this.pc += off;
          this.tick(2);
        }
        return true;
      }
      case 0xb0: {
        // bcs
        const off = this.rel();
        if (this.carry) {
          this.pc += off;
          this.tick(2);
        }
        return true;
      }
      case 0x90: {
        // bcc
        const off = this.rel();
        if (!this.carry) {
          this.pc += off;
          this.tick(2);
        }
        return true;
      }
      case 0x68: {
        // cmp a,#imm
        const v = this.a - this.byte();
        this.carry = v >= 0;
        this.nz(v);
        return true;
      }
      case 0x28: // and a,#imm
        this.a = this.nz(this.a & this.byte());
        return true;
      case 0x7a: {
        // addw ya,dp
        const v = ((this.y << 8) | this.a) + this.word(this.byte());
        this.carry = v > 0xffff;
        const r = this.nz16(v);
        this.a = r & 0xff;
        this.y = r >> 8;
        return true;
      }
      case 0x9a: {
        // subw ya,dp
        const v = ((this.y << 8) | this.a) - this.word(this.byte());
        this.carry = v >= 0;
        const r = this.nz16(v);
        this.a = r & 0xff;
        this.y = r >> 8;
        return true;
      }
      case 0x5a: {
        // cmpw ya,dp
        const v = ((this.y << 8) | this.a) - this.word(this.byte());
        this.carry = v >= 0;
        this.nz16(v);
        return true;
      }
      case 0xda: // movw dp,ya
        this.setWord(this.byte(), (this.y << 8) | this.a);
        return true;
      case 0xba: {
        // movw ya,dp
        const v = this.word(this.byte());
        this.a = v & 0xff;
        this.y = v >> 8;
        this.nz16(v);
        return true;
      }
      case 0x6e: {
        // dbnz dp,rel
        const dp = this.byte();
        const off = this.rel();
        const v = (this.ram[dp] - 1) & 0xff;
        this.ram[dp] = v;
        if (v !== 0) {
          this.pc += off;
          this.tick(2);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Run until `periods` timer 0 periods have passed, or an unknown opcode turns up. */
  run(periods: number, maxInstructions = 50_000_000) {
    const until = this.cycles + periods * 128;
    let n = 0;
    while (this.cycles < until) {
      if (++n > maxInstructions) throw new Error('the driver ran too long');
      if (!this.step()) throw new Error(`unknown opcode $${this.ram[this.pc - 1].toString(16)} at $${(this.pc - 1).toString(16)}`);
    }
  }
}
