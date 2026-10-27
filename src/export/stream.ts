/**
 * The song captured as the DSP register writes the player makes per tick.
 * This is the base of the SPC export: a small SPC700 driver replays the
 * stream with the same timing (timer 0 periods per tick) as the tracker.
 */
import { ENDX, KON } from '../dsp/dsp';
import { Player } from '../tracker/player';
import { Song } from '../tracker/song';

export interface Tick {
  /** Register/value pairs in write order. */
  writes: [number, number][];
  /** Timer periods (125 µs) until the next tick. */
  units: number;
}

export interface CapturedStream {
  ticks: Tick[];
  /** Tick the song loops back to. */
  loopTick: number;
  /** Register state at the loop tick, rewritten when the driver jumps back there (no KON). */
  loopState: [number, number][];
}

/** Capture writes until the song loops (or `maxTicks`). */
export function captureStream(song: Song, maxTicks = 50 * 60 * 30): CapturedStream {
  const player = new Player(song);
  let writes: [number, number][] = [];
  const out = { write: (addr: number, value: number) => writes.push([addr, value]) };
  player.start(out);
  const ticks: Tick[] = [];
  const rowTick = new Map<number, { tick: number; state: Int16Array }>();
  let loopTick = 0;
  const loopState: [number, number][] = [];
  while (ticks.length < maxTicks) {
    const before = player.loops;
    const key = (player.order << 8) | player.row;
    const atRowStart = player.tickInRow === 0;
    const state = player.registers();
    player.tick(out);
    if (player.loops !== before) {
      // This tick starts the second pass over a row: the loop goes back to its first visit.
      const first = rowTick.get(key);
      if (first) {
        loopTick = first.tick;
        first.state.forEach((v, reg) => {
          if (v >= 0 && reg !== KON && reg !== ENDX) loopState.push([reg, v]);
        });
      }
      break;
    }
    if (atRowStart && !rowTick.has(key)) rowTick.set(key, { tick: ticks.length, state });
    ticks.push({ writes, units: player.units });
    writes = [];
  }
  return { ticks, loopTick, loopState };
}

/** Stream bytes understood by the SPC driver. */
export const CMD_TEMPO = 0x80;
export const CMD_LOOP = 0xff;
export const MAX_WAIT = 0x7e;

/**
 * Encodes the stream: `rr vv` writes vv to DSP register rr (rr < $80),
 * `80 lo hi` sets the timer periods per tick, `81`-`FE` waits 1-126 ticks,
 * `FF` jumps to the loop address. Returns the bytes and the loop offset.
 */
export function encodeStream(stream: CapturedStream): { data: Uint8Array; loopOffset: number; units: number } {
  const bytes: number[] = [];
  let loopOffset = 0;
  const units = stream.ticks[0]?.units ?? 160;
  let curUnits = units;
  let pendingWait = 0;
  const flushWait = () => {
    while (pendingWait > 0) {
      const n = Math.min(MAX_WAIT, pendingWait);
      bytes.push(0x80 | n);
      pendingWait -= n;
    }
  };
  stream.ticks.forEach((t, i) => {
    if (i === stream.loopTick) {
      flushWait();
      loopOffset = bytes.length;
      for (const [r, v] of stream.loopState) bytes.push(r, v);
      // The tempo at the loop point may differ from the one at the end.
      bytes.push(CMD_TEMPO, curUnits & 0xff, curUnits >> 8);
    }
    if (t.writes.length) flushWait();
    for (const [r, v] of t.writes) bytes.push(r & 0x7f, v & 0xff);
    if (t.units !== curUnits) {
      flushWait();
      bytes.push(CMD_TEMPO, t.units & 0xff, t.units >> 8);
      curUnits = t.units;
    }
    pendingWait++;
  });
  flushWait();
  bytes.push(CMD_LOOP);
  return { data: Uint8Array.from(bytes), loopOffset, units };
}
