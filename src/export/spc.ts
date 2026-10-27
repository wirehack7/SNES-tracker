/**
 * SPC export: a 64 KiB audio RAM image with a small SPC700 driver, the
 * samples and the song as a DSP register stream, in the SPC file format
 * (v0.30 with ID666 text tags) that SNES music players and emulators load.
 *
 * Audio RAM: driver at $0200, sample directory at $0400, samples from
 * $0500 (see tracker/aram.ts), the stream after them, the echo buffer at the
 * top. The driver runs timer 0 at 8 kHz and replays the stream with the
 * tracker's tick timing. The song itself follows the SPC data, so the
 * tracker can open the file again (see export/spcimport.ts).
 */
import { DSP_RATE, EDL, ESA, FLG } from '../dsp/dsp';
import { DRIVER_ADDR, layoutAram } from '../tracker/aram';
import { Song } from '../tracker/song';
import { SAMPLES_PER_UNIT } from '../tracker/player';
import { captureStream, encodeStream } from './stream';
import { songChunk } from './spcimport';

/** Zero page variables of the driver. */
export const ZP_PTR = 0x00;
export const ZP_UNITS = 0x02;
export const ZP_ACC = 0x04;
export const ZP_COUNT = 0x06;
export const ZP_LOOP = 0x08;

/**
 * The driver, hand-assembled SPC700 code for $0200:
 *
 *        mov  x,#$EF / mov sp,x
 *        mov  $F1,#$00          ; timers off
 *        mov  $FA,#$01          ; timer 0: every 125 µs
 *        mov  $F1,#$01          ; timer 0 on
 *        mov  a,$FD             ; clear its counter
 * read:  mov  y,#0
 *        mov  a,[ptr]+y / incw ptr
 *        cmp  a,#$80 / bcs cmd  ; (incw clobbers N, so this compares instead of bmi)
 *        mov  $F2,a             ; DSP register
 *        mov  a,[ptr]+y / incw ptr
 *        mov  $F3,a             ; DSP data
 *        bra  read
 * cmd:   cmp  a,#$FF / beq loop
 *        cmp  a,#$80 / beq tempo
 *        and  a,#$7F / mov count,a
 * wait:  mov  a,$FD / mov y,#0  ; timer periods since the last read
 *        addw ya,acc / movw acc,ya
 *        cmpw ya,units / bcc wait
 *        subw ya,units / movw acc,ya
 *        dbnz count,wait
 *        bra  read
 * tempo: mov  a,[ptr]+y / incw ptr / mov units,a
 *        mov  a,[ptr]+y / incw ptr / mov units+1,a
 *        bra  read
 * loop:  movw ya,loopaddr / movw ptr,ya
 *        bra  read
 */
export const DRIVER = Uint8Array.from([
  0xcd, 0xef, 0xbd, 0x8f, 0x00, 0xf1, 0x8f, 0x01, 0xfa, 0x8f, 0x01, 0xf1, 0xe4, 0xfd,
  // read ($020E)
  0x8d, 0x00, 0xf7, ZP_PTR, 0x3a, ZP_PTR, 0x68, 0x80, 0xb0, 0x0a, 0xc4, 0xf2,
  0xf7, ZP_PTR, 0x3a, ZP_PTR, 0xc4, 0xf3, 0x2f, 0xec,
  // cmd ($0222)
  0x68, 0xff, 0xf0, 0x2b, 0x68, 0x80, 0xf0, 0x19, 0x28, 0x7f, 0xc4, ZP_COUNT,
  // wait ($022E)
  0xe4, 0xfd, 0x8d, 0x00, 0x7a, ZP_ACC, 0xda, ZP_ACC, 0x5a, ZP_UNITS, 0x90, 0xf4, 0x9a, ZP_UNITS, 0xda, ZP_ACC,
  0x6e, ZP_COUNT, 0xed, 0x2f, 0xcb,
  // tempo ($0243)
  0xf7, ZP_PTR, 0x3a, ZP_PTR, 0xc4, ZP_UNITS, 0xf7, ZP_PTR, 0x3a, ZP_PTR, 0xc4, ZP_UNITS + 1, 0x2f, 0xbd,
  // loop ($0251)
  0xba, ZP_LOOP, 0xda, ZP_PTR, 0x2f, 0xb7,
]);

export interface SpcResult {
  data: Uint8Array;
  /** Bytes of the register stream. */
  streamBytes: number;
  /** Bytes of audio RAM left free. */
  free: number;
  /** Seconds until the song loops. */
  seconds: number;
}

export interface SpcInfo {
  title: string;
  author: string;
  game?: string;
  comment?: string;
  /** Play time before the fade, seconds. */
  seconds: number;
  fadeMs?: number;
  date?: Date;
}

/** The SPC file around a RAM image and DSP registers. */
export function spcFile(ram: Uint8Array, dspRegs: Uint8Array, pc: number, info: SpcInfo): Uint8Array {
  const out = new Uint8Array(0x10200);
  const text = (o: number, s: string, len: number) => {
    const bytes = new TextEncoder().encode(s.normalize('NFKD').replace(/[^\x20-\x7e]/g, ''));
    out.set(bytes.subarray(0, len), o);
  };
  text(0, 'SNES-SPC700 Sound File Data v0.30', 33);
  out[0x21] = 26;
  out[0x22] = 26;
  out[0x23] = 26; // has ID666
  out[0x24] = 30;
  out[0x25] = pc & 0xff;
  out[0x26] = pc >> 8;
  out[0x2b] = 0xef; // SP
  text(0x2e, info.title, 32);
  text(0x4e, info.game ?? 'SNES Tracker', 32);
  text(0x6e, 'SNES Tracker', 16);
  text(0x7e, info.comment ?? '', 32);
  const d = info.date ?? new Date();
  text(0x9e, `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`, 11);
  text(0xa9, String(Math.min(999, Math.max(1, Math.ceil(info.seconds)))), 3);
  text(0xac, String(Math.min(99999, info.fadeMs ?? 5000)), 5);
  text(0xb1, info.author, 32);
  out[0xd1] = 0;
  out[0xd2] = 0x30; // emulator: unknown
  out.set(ram, 0x100);
  out.set(dspRegs.subarray(0, 128), 0x10100);
  // The 64 bytes under the IPL ROM: the top of RAM.
  out.set(ram.subarray(0xffc0), 0x101c0);
  return out;
}

/** Build the SPC file of a song. Throws when samples and song do not fit in audio RAM. */
export function buildSpc(song: Song, opts: { date?: Date } = {}): SpcResult {
  const layout = layoutAram(song);
  const captured = captureStream(song);
  const stream = encodeStream(captured);
  const ram = new Uint8Array(0x10000);
  ram.set(DRIVER, DRIVER_ADDR);
  ram.set(layout.image, 0x0400);
  const start = layout.end;
  const end = start + stream.data.length;
  if (end > layout.echoStart)
    throw new Error(
      `Song does not fit in audio RAM: samples ${layout.end - 0x500} bytes, song data ${stream.data.length} bytes, echo ${0x10000 - layout.echoStart} bytes (${end - layout.echoStart} bytes too many)`,
    );
  ram.set(stream.data, start);
  const loop = start + stream.loopOffset;
  ram[ZP_PTR] = start & 0xff;
  ram[ZP_PTR + 1] = start >> 8;
  ram[ZP_UNITS] = stream.units & 0xff;
  ram[ZP_UNITS + 1] = stream.units >> 8;
  ram[ZP_LOOP] = loop & 0xff;
  ram[ZP_LOOP + 1] = loop >> 8;
  // Control registers as the driver leaves them: timers off until it starts them.
  ram[0xf1] = 0;
  const regs = new Uint8Array(128);
  regs[FLG] = 0xe0;
  regs[ESA] = layout.esa;
  regs[EDL] = song.echo.delay;
  const units = captured.ticks.reduce((s, t) => s + t.units, 0);
  const seconds = (units * SAMPLES_PER_UNIT) / DSP_RATE;
  const spc = spcFile(ram, regs, DRIVER_ADDR, { title: song.title, author: song.author, seconds, date: opts.date });
  const chunk = songChunk(song);
  const data = new Uint8Array(spc.length + chunk.length);
  data.set(spc);
  data.set(chunk, spc.length);
  return {
    data,
    streamBytes: stream.data.length,
    free: layout.echoStart - end,
    seconds,
  };
}
