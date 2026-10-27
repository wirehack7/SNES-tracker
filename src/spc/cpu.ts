/**
 * The SPC700, the SNES sound CPU: all 256 opcodes with their flags and
 * cycle counts. Memory goes through a bus, so the same core runs on plain
 * RAM (the tests) and on the APU with its I/O registers and timers.
 *
 * Cycle counts are per instruction (from the official tables, plus two for
 * a taken branch), which is what timers and the DSP need: the APU advances
 * them after each instruction.
 */

export interface Bus {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

// PSW bits
export const FLAG_C = 0x01;
export const FLAG_Z = 0x02;
export const FLAG_I = 0x04;
export const FLAG_H = 0x08;
export const FLAG_B = 0x10;
export const FLAG_P = 0x20;
export const FLAG_V = 0x40;
export const FLAG_N = 0x80;

/** Cycles of each opcode, without the two extra cycles of a taken branch. */
export const CYCLES = Uint8Array.from([
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6, 6,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 12, 5,
  3, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 4,
  3, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9,
  2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 4, 5, 3, 4, 3, 4, 3,
  2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3,
]);

export class Spc700 {
  a = 0;
  x = 0;
  y = 0;
  sp = 0xef;
  pc = 0;
  // Flags kept apart; `psw` packs them.
  n = false;
  v = false;
  p = false;
  b = false;
  h = false;
  i = false;
  z = false;
  c = false;
  /** SLEEP or STOP ran: the CPU waits for a reset (the APU has no interrupts). */
  halted = false;
  /** Cycles run so far. */
  cycles = 0;

  constructor(readonly bus: Bus) {}

  get psw(): number {
    return (
      (this.n ? FLAG_N : 0) | (this.v ? FLAG_V : 0) | (this.p ? FLAG_P : 0) | (this.b ? FLAG_B : 0) |
      (this.h ? FLAG_H : 0) | (this.i ? FLAG_I : 0) | (this.z ? FLAG_Z : 0) | (this.c ? FLAG_C : 0)
    );
  }

  set psw(v: number) {
    this.n = (v & FLAG_N) !== 0;
    this.v = (v & FLAG_V) !== 0;
    this.p = (v & FLAG_P) !== 0;
    this.b = (v & FLAG_B) !== 0;
    this.h = (v & FLAG_H) !== 0;
    this.i = (v & FLAG_I) !== 0;
    this.z = (v & FLAG_Z) !== 0;
    this.c = (v & FLAG_C) !== 0;
  }

  get ya() {
    return (this.y << 8) | this.a;
  }

  set ya(v: number) {
    this.a = v & 0xff;
    this.y = (v >> 8) & 0xff;
  }

  // ------------------------------------------------------------ memory

  private rd(addr: number) {
    return this.bus.read(addr & 0xffff);
  }

  private wr(addr: number, v: number) {
    this.bus.write(addr & 0xffff, v & 0xff);
  }

  private fetch() {
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16() {
    const lo = this.fetch();
    return lo | (this.fetch() << 8);
  }

  /** Direct page address: page 0, or page 1 with P set. */
  private dp(off: number) {
    return (this.p ? 0x100 : 0) | (off & 0xff);
  }

  /** A word in the direct page; the high byte wraps within the page. */
  private rdDpWord(off: number) {
    return this.rd(this.dp(off)) | (this.rd(this.dp(off + 1)) << 8);
  }

  private wrDpWord(off: number, v: number) {
    this.wr(this.dp(off), v);
    this.wr(this.dp(off + 1), v >> 8);
  }

  private push(v: number) {
    this.wr(0x100 | this.sp, v);
    this.sp = (this.sp - 1) & 0xff;
  }

  private pop() {
    this.sp = (this.sp + 1) & 0xff;
    return this.rd(0x100 | this.sp);
  }

  private push16(v: number) {
    this.push(v >> 8);
    this.push(v & 0xff);
  }

  private pop16() {
    const lo = this.pop();
    return lo | (this.pop() << 8);
  }

  // Addressing modes: each returns an address.
  private aDp() { return this.dp(this.fetch()); }
  private aDpX() { return this.dp(this.fetch() + this.x); }
  private aDpY() { return this.dp(this.fetch() + this.y); }
  private aAbs() { return this.fetch16(); }
  private aAbsX() { return (this.fetch16() + this.x) & 0xffff; }
  private aAbsY() { return (this.fetch16() + this.y) & 0xffff; }
  private aIndX() { return this.rdDpWord(this.fetch() + this.x); }
  private aIndY() { return (this.rdDpWord(this.fetch()) + this.y) & 0xffff; }
  private aX() { return this.dp(this.x); }
  private aY() { return this.dp(this.y); }

  // ------------------------------------------------------------ ALU

  private nz(v: number) {
    this.n = (v & 0x80) !== 0;
    this.z = (v & 0xff) === 0;
    return v & 0xff;
  }

  private or(a: number, b: number) { return this.nz(a | b); }
  private and(a: number, b: number) { return this.nz(a & b); }
  private eor(a: number, b: number) { return this.nz(a ^ b); }

  private adc(a: number, b: number) {
    const r = a + b + (this.c ? 1 : 0);
    this.v = (~(a ^ b) & (a ^ r) & 0x80) !== 0;
    this.h = ((a ^ b ^ r) & 0x10) !== 0;
    this.c = r > 0xff;
    return this.nz(r);
  }

  private sbc(a: number, b: number) {
    return this.adc(a, ~b & 0xff);
  }

  private cmp(a: number, b: number) {
    const r = a - b;
    this.c = r >= 0;
    this.nz(r);
    return a;
  }

  private asl(v: number) {
    this.c = (v & 0x80) !== 0;
    return this.nz(v << 1);
  }

  private rol(v: number) {
    const r = (v << 1) | (this.c ? 1 : 0);
    this.c = (v & 0x80) !== 0;
    return this.nz(r);
  }

  private lsr(v: number) {
    this.c = (v & 1) !== 0;
    return this.nz(v >> 1);
  }

  private ror(v: number) {
    const r = (v >> 1) | (this.c ? 0x80 : 0);
    this.c = (v & 1) !== 0;
    return this.nz(r);
  }

  private inc(v: number) { return this.nz(v + 1); }
  private dec(v: number) { return this.nz(v - 1); }

  private nz16(v: number) {
    this.n = (v & 0x8000) !== 0;
    this.z = (v & 0xffff) === 0;
    return v & 0xffff;
  }

  /** ADDW and SUBW: two byte additions, flags from the high one, Z from the word. */
  private addw(a: number, b: number) {
    this.c = false;
    const lo = this.adc(a & 0xff, b & 0xff);
    const hi = this.adc(a >> 8, (b >> 8) & 0xff);
    const r = (hi << 8) | lo;
    this.z = r === 0;
    return r;
  }

  private subw(a: number, b: number) {
    this.c = true;
    const lo = this.adc(a & 0xff, ~b & 0xff);
    const hi = this.adc(a >> 8, (~b >> 8) & 0xff);
    const r = (hi << 8) | lo;
    this.z = r === 0;
    return r;
  }

  /** Read, modify, write at an address: ASL, ROL, LSR, ROR, DEC, INC (0-5). */
  private rmw(addr: number, op: number) {
    const v = this.rd(addr);
    this.wr(addr, op === 0 ? this.asl(v) : op === 1 ? this.rol(v) : op === 2 ? this.lsr(v) : op === 3 ? this.ror(v) : op === 4 ? this.dec(v) : this.inc(v));
  }

  /** ALU operation `row` on a memory operand into A. */
  private toA(addr: number, row: number) {
    this.a = this.aluOp(row, this.a, this.rd(addr));
  }

  /** ALU operation `row` from memory to memory (dp,dp / (X),(Y) / dp,#imm), CMP without the write. */
  private mem(dst: number, src: number, row: number, write = true) {
    const r = this.aluOp(row, this.rd(dst), src);
    if (write) this.wr(dst, r);
  }

  private branch(cond: boolean) {
    const off = (this.fetch() << 24) >> 24;
    if (cond) {
      this.pc = (this.pc + off) & 0xffff;
      this.cycles += 2;
    }
  }

  /** mem.bit operand: 13-bit address and 3-bit bit number. */
  private memBit(): [number, number] {
    const v = this.fetch16();
    return [v & 0x1fff, v >> 13];
  }

  private bitOf(): boolean {
    const [addr, bit] = this.memBit();
    return ((this.rd(addr) >> bit) & 1) !== 0;
  }

  // ------------------------------------------------------------ execution

  /** Run one instruction; returns its cycles. */
  step(): number {
    if (this.halted) {
      this.cycles += 2;
      return 2;
    }
    const before = this.cycles;
    const op = this.fetch();
    this.cycles += CYCLES[op];
    this.exec(op);
    return this.cycles - before;
  }

  /** Run until at least `cycles` more cycles have passed; returns how many ran. */
  run(cycles: number): number {
    const end = this.cycles + cycles;
    const start = this.cycles;
    while (this.cycles < end) this.step();
    return this.cycles - start;
  }

  private exec(op: number) {
    const lo = op & 0x0f;
    const row = op >> 4;
    // Columns shared by every row.
    if (lo === 0x01) {
      // TCALL n
      this.push16(this.pc);
      const v = 0xffde - row * 2;
      this.pc = this.rd(v) | (this.rd(v + 1) << 8);
      return;
    }
    if (lo === 0x02) {
      // SET1 / CLR1 dp.bit
      const addr = this.aDp();
      const bit = 1 << (row >> 1);
      const v = this.rd(addr);
      this.wr(addr, row & 1 ? v & ~bit : v | bit);
      return;
    }
    if (lo === 0x03) {
      // BBS / BBC dp.bit, rel
      const v = this.rd(this.aDp());
      const set = ((v >> (row >> 1)) & 1) !== 0;
      this.branch(row & 1 ? !set : set);
      return;
    }
    if (lo >= 0x04 && lo <= 0x08 && row < 0xc && this.alu(op)) return;
    switch (op) {
      // ------------------------------------------------ branches and jumps
      case 0x10: return this.branch(!this.n);
      case 0x30: return this.branch(this.n);
      case 0x50: return this.branch(!this.v);
      case 0x70: return this.branch(this.v);
      case 0x90: return this.branch(!this.c);
      case 0xb0: return this.branch(this.c);
      case 0xd0: return this.branch(!this.z);
      case 0xf0: return this.branch(this.z);
      case 0x2f: {
        // BRA: its four cycles already include the jump.
        const off = (this.fetch() << 24) >> 24;
        this.pc = (this.pc + off) & 0xffff;
        return;
      }
      case 0x2e: {
        const v = this.rd(this.aDp());
        return this.branch(this.a !== v);
      }
      case 0xde: {
        const v = this.rd(this.aDpX());
        return this.branch(this.a !== v);
      }
      case 0x6e: {
        const addr = this.aDp();
        const v = (this.rd(addr) - 1) & 0xff;
        this.wr(addr, v);
        return this.branch(v !== 0);
      }
      case 0xfe:
        this.y = (this.y - 1) & 0xff;
        return this.branch(this.y !== 0);
      case 0x5f:
        this.pc = this.fetch16();
        return;
      case 0x1f: {
        const addr = this.aAbsX();
        this.pc = this.rd(addr) | (this.rd(addr + 1) << 8);
        return;
      }
      case 0x3f: {
        const addr = this.fetch16();
        this.push16(this.pc);
        this.pc = addr;
        return;
      }
      case 0x4f: {
        const up = this.fetch();
        this.push16(this.pc);
        this.pc = 0xff00 | up;
        return;
      }
      case 0x0f:
        this.push16(this.pc);
        this.push(this.psw);
        this.b = true;
        this.i = false;
        this.pc = this.rd(0xffde) | (this.rd(0xffdf) << 8);
        return;
      case 0x6f:
        this.pc = this.pop16();
        return;
      case 0x7f:
        this.psw = this.pop();
        this.pc = this.pop16();
        return;

      // ------------------------------------------------ flags
      case 0x00: return;
      case 0x20: this.p = false; return;
      case 0x40: this.p = true; return;
      case 0x60: this.c = false; return;
      case 0x80: this.c = true; return;
      case 0xa0: this.i = true; return;
      case 0xc0: this.i = false; return;
      case 0xe0: this.v = this.h = false; return;
      case 0xed: this.c = !this.c; return;
      case 0xef:
      case 0xff:
        this.halted = true;
        return;

      // ------------------------------------------------ stack
      case 0x0d: return this.push(this.psw);
      case 0x2d: return this.push(this.a);
      case 0x4d: return this.push(this.x);
      case 0x6d: return this.push(this.y);
      case 0x8e: this.psw = this.pop(); return;
      case 0xae: this.a = this.pop(); return;
      case 0xce: this.x = this.pop(); return;
      case 0xee: this.y = this.pop(); return;

      // ------------------------------------------------ bit operations
      case 0x0e:
      case 0x4e: {
        const addr = this.aAbs();
        const v = this.rd(addr);
        this.nz(this.a - v);
        this.wr(addr, op === 0x0e ? v | this.a : v & ~this.a);
        return;
      }
      case 0x0a: { const b = this.bitOf(); this.c ||= b; return; }
      case 0x2a: { const b = this.bitOf(); this.c ||= !b; return; }
      case 0x4a: { const b = this.bitOf(); this.c &&= b; return; }
      case 0x6a: { const b = this.bitOf(); this.c &&= !b; return; }
      case 0x8a: { const b = this.bitOf(); this.c = this.c !== b; return; }
      case 0xaa: this.c = this.bitOf(); return;
      case 0xca: {
        const [addr, bit] = this.memBit();
        const v = this.rd(addr);
        this.wr(addr, this.c ? v | (1 << bit) : v & ~(1 << bit));
        return;
      }
      case 0xea: {
        const [addr, bit] = this.memBit();
        this.wr(addr, this.rd(addr) ^ (1 << bit));
        return;
      }

      // ------------------------------------------------ dp,#imm and (X),(Y) ALU forms
      case 0x18: case 0x38: case 0x58: case 0x78: case 0x98: case 0xb8: {
        const imm = this.fetch();
        return this.mem(this.aDp(), imm, row, op !== 0x78);
      }
      case 0x19: case 0x39: case 0x59: case 0x79: case 0x99: case 0xb9: {
        const src = this.rd(this.aY());
        return this.mem(this.aX(), src, row, op !== 0x79);
      }
      case 0x09: case 0x29: case 0x49: case 0x69: case 0x89: case 0xa9: {
        const src = this.rd(this.aDp());
        return this.mem(this.aDp(), src, row, op !== 0x69);
      }

      // ------------------------------------------------ shifts, INC, DEC
      case 0x0b: return this.rmw(this.aDp(), 0);
      case 0x0c: return this.rmw(this.aAbs(), 0);
      case 0x1b: return this.rmw(this.aDpX(), 0);
      case 0x1c: this.a = this.asl(this.a); return;
      case 0x2b: return this.rmw(this.aDp(), 1);
      case 0x2c: return this.rmw(this.aAbs(), 1);
      case 0x3b: return this.rmw(this.aDpX(), 1);
      case 0x3c: this.a = this.rol(this.a); return;
      case 0x4b: return this.rmw(this.aDp(), 2);
      case 0x4c: return this.rmw(this.aAbs(), 2);
      case 0x5b: return this.rmw(this.aDpX(), 2);
      case 0x5c: this.a = this.lsr(this.a); return;
      case 0x6b: return this.rmw(this.aDp(), 3);
      case 0x6c: return this.rmw(this.aAbs(), 3);
      case 0x7b: return this.rmw(this.aDpX(), 3);
      case 0x7c: this.a = this.ror(this.a); return;
      case 0x8b: return this.rmw(this.aDp(), 4);
      case 0x8c: return this.rmw(this.aAbs(), 4);
      case 0x9b: return this.rmw(this.aDpX(), 4);
      case 0x9c: this.a = this.dec(this.a); return;
      case 0xab: return this.rmw(this.aDp(), 5);
      case 0xac: return this.rmw(this.aAbs(), 5);
      case 0xbb: return this.rmw(this.aDpX(), 5);
      case 0xbc: this.a = this.inc(this.a); return;
      case 0x1d: this.x = this.dec(this.x); return;
      case 0x3d: this.x = this.inc(this.x); return;
      case 0xdc: this.y = this.dec(this.y); return;
      case 0xfc: this.y = this.inc(this.y); return;

      // ------------------------------------------------ 16-bit
      case 0x1a:
      case 0x3a: {
        const off = this.fetch();
        const r = this.nz16(this.rdDpWord(off) + (op === 0x3a ? 1 : -1));
        this.wrDpWord(off, r);
        return;
      }
      case 0x5a: {
        const w = this.rdDpWord(this.fetch());
        const r = this.ya - w;
        this.c = r >= 0;
        this.nz16(r);
        return;
      }
      case 0x7a: this.ya = this.addw(this.ya, this.rdDpWord(this.fetch())); this.n = (this.y & 0x80) !== 0; return;
      case 0x9a: this.ya = this.subw(this.ya, this.rdDpWord(this.fetch())); this.n = (this.y & 0x80) !== 0; return;
      case 0xba: this.ya = this.nz16(this.rdDpWord(this.fetch())); return;
      case 0xda: this.wrDpWord(this.fetch(), this.ya); return;
      case 0xcf: {
        this.ya = this.y * this.a;
        this.nz(this.y);
        return;
      }
      case 0x9e: return this.div();
      case 0xdf: {
        if (this.c || this.a > 0x99) {
          this.a = (this.a + 0x60) & 0xff;
          this.c = true;
        }
        if (this.h || (this.a & 15) > 9) this.a = (this.a + 6) & 0xff;
        this.nz(this.a);
        return;
      }
      case 0xbe: {
        if (!this.c || this.a > 0x99) {
          this.a = (this.a - 0x60) & 0xff;
          this.c = false;
        }
        if (!this.h || (this.a & 15) > 9) this.a = (this.a - 6) & 0xff;
        this.nz(this.a);
        return;
      }
      case 0x9f: this.a = this.nz((this.a >> 4) | (this.a << 4)); return;

      // ------------------------------------------------ compares with X and Y
      case 0x1e: this.cmp(this.x, this.rd(this.aAbs())); return;
      case 0x3e: this.cmp(this.x, this.rd(this.aDp())); return;
      case 0xc8: this.cmp(this.x, this.fetch()); return;
      case 0x5e: this.cmp(this.y, this.rd(this.aAbs())); return;
      case 0x7e: this.cmp(this.y, this.rd(this.aDp())); return;
      case 0xad: this.cmp(this.y, this.fetch()); return;

      // ------------------------------------------------ moves
      case 0x5d: this.x = this.nz(this.a); return;
      case 0x7d: this.a = this.nz(this.x); return;
      case 0xdd: this.a = this.nz(this.y); return;
      case 0xfd: this.y = this.nz(this.a); return;
      case 0x9d: this.x = this.nz(this.sp); return;
      case 0xbd: this.sp = this.x; return;
      case 0x8d: this.y = this.nz(this.fetch()); return;
      case 0xcd: this.x = this.nz(this.fetch()); return;
      case 0xe8: this.a = this.nz(this.fetch()); return;
      case 0xe4: this.a = this.nz(this.rd(this.aDp())); return;
      case 0xe5: this.a = this.nz(this.rd(this.aAbs())); return;
      case 0xe6: this.a = this.nz(this.rd(this.aX())); return;
      case 0xe7: this.a = this.nz(this.rd(this.aIndX())); return;
      case 0xf4: this.a = this.nz(this.rd(this.aDpX())); return;
      case 0xf5: this.a = this.nz(this.rd(this.aAbsX())); return;
      case 0xf6: this.a = this.nz(this.rd(this.aAbsY())); return;
      case 0xf7: this.a = this.nz(this.rd(this.aIndY())); return;
      case 0xbf: {
        this.a = this.nz(this.rd(this.aX()));
        this.x = (this.x + 1) & 0xff;
        return;
      }
      case 0xf8: this.x = this.nz(this.rd(this.aDp())); return;
      case 0xf9: this.x = this.nz(this.rd(this.aDpY())); return;
      case 0xe9: this.x = this.nz(this.rd(this.aAbs())); return;
      case 0xeb: this.y = this.nz(this.rd(this.aDp())); return;
      case 0xfb: this.y = this.nz(this.rd(this.aDpX())); return;
      case 0xec: this.y = this.nz(this.rd(this.aAbs())); return;
      case 0xc4: return this.wr(this.aDp(), this.a);
      case 0xc5: return this.wr(this.aAbs(), this.a);
      case 0xc6: return this.wr(this.aX(), this.a);
      case 0xc7: return this.wr(this.aIndX(), this.a);
      case 0xd4: return this.wr(this.aDpX(), this.a);
      case 0xd5: return this.wr(this.aAbsX(), this.a);
      case 0xd6: return this.wr(this.aAbsY(), this.a);
      case 0xd7: return this.wr(this.aIndY(), this.a);
      case 0xaf: {
        this.wr(this.aX(), this.a);
        this.x = (this.x + 1) & 0xff;
        return;
      }
      case 0xd8: return this.wr(this.aDp(), this.x);
      case 0xd9: return this.wr(this.aDpY(), this.x);
      case 0xc9: return this.wr(this.aAbs(), this.x);
      case 0xcb: return this.wr(this.aDp(), this.y);
      case 0xdb: return this.wr(this.aDpX(), this.y);
      case 0xcc: return this.wr(this.aAbs(), this.y);
      case 0x8f: {
        const imm = this.fetch();
        return this.wr(this.aDp(), imm);
      }
      case 0xfa: {
        const v = this.rd(this.aDp());
        return this.wr(this.aDp(), v);
      }
    }
    throw new Error(`SPC700: opcode $${op.toString(16)} not handled`);
  }

  /** OR, AND, EOR, CMP, ADC, SBC for the rows 0-B (two rows each). */
  private aluOp(row: number, a: number, b: number): number {
    switch (row >> 1) {
      case 0: return this.or(a, b);
      case 1: return this.and(a, b);
      case 2: return this.eor(a, b);
      case 3: return this.cmp(a, b);
      case 4: return this.adc(a, b);
      default: return this.sbc(a, b);
    }
  }

  /** The A-register forms of the six ALU operations, columns 4-8. Returns false for other opcodes. */
  private alu(op: number): boolean {
    const lo = op & 0x0f;
    const row = op >> 4;
    const odd = row & 1;
    switch (lo) {
      case 0x04: this.toA(odd ? this.aDpX() : this.aDp(), row); return true;
      case 0x05: this.toA(odd ? this.aAbsX() : this.aAbs(), row); return true;
      case 0x06: this.toA(odd ? this.aAbsY() : this.aX(), row); return true;
      case 0x07: this.toA(odd ? this.aIndY() : this.aIndX(), row); return true;
      case 0x08:
        if (odd) return false;
        this.a = this.aluOp(row, this.a, this.fetch());
        return true;
    }
    return false;
  }

  /** DIV YA,X with the hardware's results when the quotient does not fit. */
  private div() {
    const ya = this.ya;
    const x = this.x;
    this.v = this.y >= x;
    this.h = (this.y & 15) >= (x & 15);
    if (this.y < x << 1) {
      this.a = Math.floor(ya / x) & 0xff;
      this.y = ya % x & 0xff;
    } else {
      this.a = (255 - Math.floor((ya - (x << 9)) / (256 - x))) & 0xff;
      this.y = (x + ((ya - (x << 9)) % (256 - x))) & 0xff;
    }
    this.nz(this.a);
  }
}
