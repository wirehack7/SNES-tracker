import { describe, expect, it } from 'vitest';
import { de } from '../../src/i18n/locales/de';
import { en } from '../../src/i18n/locales/en';
import {
  HEIGHT,
  IntroText,
  MOSAIC_TIME,
  WIDTH,
  applyMosaic,
  fontText,
  hasGlyph,
  mode7Line,
  mosaicSize,
  renderFrame,
  rgb15,
  textWidth,
  waveOffset,
} from '../../src/ui/intro';

const text: IntroText = { title: 'SNES TRACKER', subtitle: 'SPC700 + S-DSP', scroller: en['about.scroller'], still: en['about.still'] };
const frame = (t: number, still = false) => {
  const buf = new Uint32Array(WIDTH * HEIGHT);
  renderFrame(buf, t, text, { still });
  return buf;
};

describe('About title screen', () => {
  it('uses 15-bit colours only', () => {
    expect(rgb15(31, 0, 0)).toBe(0xff0000ff);
    expect(rgb15(0, 31, 0)).toBe(0xff00ff00);
    expect(rgb15(40, -3, 16)).toBe(rgb15(31, 0, 16));
    // Every channel of every pixel is a 5-bit value expanded to 8 bits.
    const buf = frame(3.2);
    for (let i = 0; i < buf.length; i += 97) {
      for (const shift of [0, 8, 16]) {
        const v = (buf[i] >> shift) & 0xff;
        expect(v).toBe(((v >> 3) << 3) | (v >> 5));
      }
      expect(buf[i] >>> 24).toBe(0xff);
    }
  });

  it('fades in with the mosaic register stepping down to off', () => {
    expect(mosaicSize(0)).toBe(16);
    expect(mosaicSize(MOSAIC_TIME / 2)).toBe(8);
    expect(mosaicSize(MOSAIC_TIME)).toBe(1);
    expect(mosaicSize(99)).toBe(1);
    for (let t = 0; t < MOSAIC_TIME; t += 0.05) expect(mosaicSize(t + 0.05)).toBeLessThanOrEqual(mosaicSize(t));
  });

  it('fills each mosaic block with its top-left pixel', () => {
    const buf = Uint32Array.from({ length: 10 * 6 }, (_, i) => i);
    applyMosaic(buf, 4, 10, 6);
    expect([...buf.slice(0, 10)]).toEqual([0, 0, 0, 0, 4, 4, 4, 4, 8, 8]);
    expect(buf[5 * 10 + 9]).toBe(48);
    const intro = frame(0.1);
    const size = mosaicSize(0.1);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      expect(intro[y * WIDTH + x]).toBe(intro[(y - (y % size)) * WIDTH + (x - (x % size))]);
    }
  });

  it('gives each floor scanline its own Mode 7 matrix', () => {
    const near = mode7Line(90, 0.7, 10, 20);
    const far = mode7Line(5, 0.7, 10, 20);
    const step = (l: { du: number; dv: number }) => Math.hypot(l.du, l.dv);
    // Lines near the horizon cover more texture per pixel than lines at the bottom.
    expect(step(far)).toBeGreaterThan(step(near) * 10);
    // The step is perpendicular to the heading, and the centre pixel lies straight ahead.
    expect(near.du * Math.cos(0.7) + near.dv * Math.sin(0.7)).toBeCloseTo(0);
    const cu = near.u + near.du * (WIDTH / 2) - 10;
    const cv = near.v + near.dv * (WIDTH / 2) - 20;
    expect(Math.atan2(cv, cu)).toBeCloseTo(0.7);
    // Turning the camera turns the step vector by the same angle.
    const a = mode7Line(30, 0, 0, 0);
    const b = mode7Line(30, Math.PI / 2, 0, 0);
    expect(b.du).toBeCloseTo(-a.dv);
    expect(b.dv).toBeCloseTo(a.du);
  });

  it('waves the title line by line', () => {
    const lines = Array.from({ length: 21 }, (_, i) => waveOffset(i, 1.3));
    expect(new Set(lines).size).toBeGreaterThan(2);
    expect(Math.max(...lines.map(Math.abs))).toBeLessThanOrEqual(3);
    expect(waveOffset(5, 1.3, 0)).toBe(0);
  });

  it('animates over time and draws a still frame for reduced motion', () => {
    const a = frame(2);
    const b = frame(2.5);
    expect(a).not.toEqual(b);
    // A still frame ignores the time and has no mosaic.
    expect(frame(0.1, true)).toEqual(frame(7, true));
    const still = frame(0, true);
    const row = (HEIGHT - 30) * WIDTH;
    expect(new Set(still.slice(row, row + WIDTH)).size).toBeGreaterThan(2);
    // Sky, floor and text all show up: the frame has many distinct colours.
    expect(new Set(a).size).toBeGreaterThan(40);
  });

  it('has a glyph for every character of the title and credits in all languages', () => {
    for (const locale of [en, de]) {
      for (const key of ['about.scroller', 'about.still'] as const) {
        const raw = locale[key]!.replace('{version}', '0.1.0').toUpperCase().replace(/ß/g, 'SS').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        for (const ch of raw) expect(hasGlyph(ch), `${key}: ${ch}`).toBe(true);
      }
    }
    expect(fontText('Grüße')).toBe('GRUSSE');
    expect(fontText('a€b')).toBe('A B');
    expect(textWidth('SNES TRACKER', 3)).toBeLessThan(WIDTH);
  });
});
