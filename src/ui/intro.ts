/**
 * The About screen's title demo, drawn the way a Super Nintendo would: a 256-pixel-wide frame with
 * a Mode 7 floor (one affine matrix per scanline, as HDMA feeds it), a parallax mountain layer, an
 * HDMA colour gradient in the sky, a title whose scanlines are shifted by a sine wave, a mosaic
 * fade-in and a bouncing credits scroller. Every colour is a 15-bit BGR555 colour.
 *
 * The renderer only writes into a Uint32Array (RGBA bytes, little-endian), so it runs without a canvas.
 */

export const WIDTH = 256;
export const HEIGHT = 160;
export const HORIZON = 64;
/** Mosaic fade-in time in seconds; the mosaic register steps from 15 down to 0. */
export const MOSAIC_TIME = 0.9;

const FOCAL = 128;
const CAMERA_HEIGHT = 24;
const TEX = 128; // floor texture size in texels, wraps

/** A 15-bit colour (0..31 per channel) as a little-endian RGBA pixel. */
export function rgb15(r: number, g: number, b: number): number {
  const c = (v: number) => {
    const q = Math.max(0, Math.min(31, Math.round(v)));
    return (q << 3) | (q >> 2);
  };
  return (0xff000000 | (c(b) << 16) | (c(g) << 8) | c(r)) >>> 0;
}

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, f: number): RGB => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const px = (c: RGB) => rgb15(c[0], c[1], c[2]);

// Palette in 0..31 per channel: the console's greys and purples and the pad's ABXY colours.
const SKY_TOP: RGB = [3, 2, 9];
const SKY_MID: RGB = [11, 7, 20];
const SKY_LOW: RGB = [25, 13, 21];
const MOUNTAIN: RGB = [7, 5, 13];
const MOUNTAIN_HI: RGB = [12, 9, 20];
const TILE_LIGHT: RGB = [23, 22, 26];
const TILE_DARK: RGB = [15, 14, 20];
const GRID: RGB = [9, 7, 16];
const PAD: RGB[] = [
  [26, 6, 5], // A red
  [29, 20, 4], // B yellow
  [6, 12, 24], // X blue
  [6, 20, 10], // Y green
];
const TITLE: RGB[] = [
  [31, 31, 25],
  [31, 27, 10],
  [31, 21, 4],
  [30, 13, 4],
  [26, 6, 6],
];
const OUTLINE = rgb15(2, 1, 5);
const WHITE = rgb15(31, 31, 31);
const SHADOW = rgb15(4, 3, 8);

/** Mosaic block size at time t: 16 pixels at open, 1 (off) once the fade-in is over. */
export function mosaicSize(t: number): number {
  if (t >= MOSAIC_TIME) return 1;
  return 16 - Math.floor((Math.max(0, t) / MOSAIC_TIME) * 16);
}

/** Pixel offset of one title scanline; the wave HDMA would write to the BG scroll register. */
export function waveOffset(line: number, t: number, amplitude = 3): number {
  return Math.round(Math.sin(line * 0.35 + t * 5) * amplitude);
}

export interface Mode7Line {
  /** Texture coordinates of the line's leftmost pixel. */
  u: number;
  v: number;
  /** Texture step per screen pixel (the matrix's A and C entries). */
  du: number;
  dv: number;
}

/** The affine matrix of the floor scanline `d` rows below the horizon, for a camera at (x, y) facing `angle`. */
export function mode7Line(d: number, angle: number, x: number, y: number): Mode7Line {
  const z = (CAMERA_HEIGHT * FOCAL) / Math.max(1, d);
  const scale = z / FOCAL;
  const fx = Math.cos(angle);
  const fy = Math.sin(angle);
  // The right vector is the forward vector turned by 90 degrees.
  const du = -fy * scale;
  const dv = fx * scale;
  return { u: x + fx * z - du * (WIDTH / 2), v: y + fy * z - dv * (WIDTH / 2), du, dv };
}

/** Camera path: forward along the heading while slowly turning, the way a Mode 7 title screen sweeps. */
export function camera(t: number): { angle: number; x: number; y: number } {
  const angle = t * 0.22 + Math.sin(t * 0.37) * 0.6;
  return { angle, x: t * 18 + Math.sin(t * 0.21) * 90, y: t * 7 + Math.cos(t * 0.17) * 90 };
}

let floor: Uint32Array | null = null;

/** The 128×128 floor texture: a checkerboard of grey-purple tiles with grid lines and ABXY "buttons". */
function floorTexture(): Uint32Array {
  if (floor) return floor;
  floor = new Uint32Array(TEX * TEX);
  for (let v = 0; v < TEX; v++) {
    for (let u = 0; u < TEX; u++) {
      const tx = u >> 4;
      const ty = v >> 4;
      const lu = u & 15;
      const lv = v & 15;
      let c: RGB = (tx + ty) & 1 ? TILE_DARK : TILE_LIGHT;
      if (lu === 0 || lv === 0) c = GRID;
      else if ((tx & 3) === 1 && (ty & 3) === 1) {
        // A round pad button in the middle of every fourth tile.
        const dx = lu - 8;
        const dy = lv - 8;
        if (dx * dx + dy * dy <= 30) c = PAD[((tx >> 2) + (ty >> 2) * 3) & 3];
      }
      floor[v * TEX + u] = px(c);
    }
  }
  return floor;
}

/** 5×7 pixel font: seven rows of five bits per glyph, as hex pairs. */
const FONT: Record<string, string> = {
  A: '0e11111f111111', B: '1e11111e11111e', C: '0e11101010110e', D: '1e11111111111e',
  E: '1f10101e10101f', F: '1f10101e101010', G: '0e11101711110f', H: '1111111f111111',
  I: '0e04040404040e', J: '0702020202120c', K: '11121418141211', L: '1010101010101f',
  M: '111b1515111111', N: '11111915131111', O: '0e11111111110e', P: '1e11111e101010',
  Q: '0e11111115120d', R: '1e11111e141211', S: '0f10100e01011e', T: '1f040404040404',
  U: '1111111111110e', V: '11111111110a04', W: '1111111515150a', X: '11110a040a1111',
  Y: '11110a04040404', Z: '1f01020408101f', '0': '0e11131519110e', '1': '040c040404040e',
  '2': '0e11010204081f', '3': '1f02040201110e', '4': '02060a121f0202',
  '5': '1f101e0101110e', '6': '0608101e11110e', '7': '1f010204080808', '8': '0e11110e11110e',
  '9': '0e11110f01020c', ' ': '00000000000000', '.': '00000000000c0c', ',': '000000000c0408',
  '-': '0000001f000000', '!': '04040404040004', ':': '000c0c000c0c00', '/': '01010204081010',
  '*': '0004150e150400', '+': '0004041f040400', '(': '02040808080402', ')': '08040202020408',
  "'": '04040800000000', '&': '0c12140815120d', '?': '0e110102040004', '♥': '000a1f1f0e0400',
};

const glyphs = new Map<string, number[]>(
  Object.entries(FONT).map(([ch, hex]) => [ch, Array.from({ length: 7 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))]),
);

/** Text in the font's alphabet: upper case, accents dropped (Ü → U, ß → SS), unknown characters as spaces. */
export function fontText(text: string): string {
  return [...text.toUpperCase().replace(/ß|ẞ/g, 'SS').normalize('NFD').replace(/[̀-ͯ]/g, '')]
    .map((ch) => (glyphs.has(ch) ? ch : ' '))
    .join('');
}

export const hasGlyph = (ch: string) => glyphs.has(ch);

/** Width in pixels of text at a scale (6 pixels per character including the gap). */
export const textWidth = (text: string, scale = 1) => fontText(text).length * 6 * scale - scale;

function plot(buf: Uint32Array, x: number, y: number, c: number) {
  if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) buf[y * WIDTH + x] = c;
}

/** Draws text; `lineColour` and `lineShift` give each scaled pixel row its own colour and x offset. */
function drawText(
  buf: Uint32Array,
  text: string,
  x0: number,
  y0: number,
  scale: number,
  lineColour: (row: number) => number,
  lineShift: (row: number) => number = () => 0,
  charLift: (index: number) => number = () => 0,
) {
  const chars = [...fontText(text)];
  const h = 7 * scale;
  // Three passes: outline, then a hard drop shadow, then the face, so neighbours never cover each other.
  for (const pass of [0, 1, 2]) {
    chars.forEach((ch, i) => {
      const rows = glyphs.get(ch)!;
      const cx = x0 + i * 6 * scale;
      const cy = y0 + charLift(i);
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (!((rows[gy] >> (4 - gx)) & 1)) continue;
          for (let sy = 0; sy < scale; sy++) {
            const row = gy * scale + sy;
            const y = cy + row;
            const shift = lineShift(row);
            for (let sx = 0; sx < scale; sx++) {
              const x = cx + gx * scale + sx + shift;
              if (pass === 0) {
                for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) plot(buf, x + ox, y + oy, OUTLINE);
              } else if (pass === 1) plot(buf, x + 2, y + 2, OUTLINE);
              else plot(buf, x, y, lineColour(Math.min(h - 1, row)));
            }
          }
        }
      }
    });
  }
}

/** SNES mosaic: every size×size block takes the colour of its top-left pixel. */
export function applyMosaic(buf: Uint32Array, size: number, width = WIDTH, height = HEIGHT) {
  if (size <= 1) return;
  for (let by = 0; by < height; by += size) {
    for (let bx = 0; bx < width; bx += size) {
      const c = buf[by * width + bx];
      for (let y = by; y < Math.min(height, by + size); y++) buf.fill(c, y * width + bx, y * width + Math.min(width, bx + size));
    }
  }
}

/** Mountain height above the horizon at a background column (wraps every 512 columns). */
function mountain(col: number): number {
  const a = (col / 512) * Math.PI * 2;
  return 6 + Math.sin(a * 3) * 4 + Math.sin(a * 7 + 1) * 3 + Math.sin(a * 13 + 2) * 1.5;
}

export interface IntroText {
  title: string;
  subtitle: string;
  /** Scrolls along the bottom; in a still frame it is replaced by `still`. */
  scroller: string;
  still: string;
}

export interface FrameOptions {
  /** Reduced motion: no mosaic, no wave, no scrolling, a fixed camera. */
  still?: boolean;
}

/** Renders the frame at time t (seconds since the screen opened) into buf (WIDTH × HEIGHT pixels). */
export function renderFrame(buf: Uint32Array, t: number, text: IntroText, options: FrameOptions = {}) {
  const still = !!options.still;
  const time = still ? 0 : t;
  const cam = camera(time);
  const tex = floorTexture();

  // Sky: one colour per scanline, as an HDMA channel writing the backdrop colour would.
  const skyLow = mix(SKY_LOW, PAD[1], 0.15 + 0.15 * Math.sin(time * 0.8));
  for (let y = 0; y < HORIZON; y++) {
    const f = y / (HORIZON - 1);
    const c = px(f < 0.5 ? mix(SKY_TOP, SKY_MID, f * 2) : mix(SKY_MID, skyLow, (f - 0.5) * 2));
    buf.fill(c, y * WIDTH, (y + 1) * WIDTH);
  }
  // Stars on two parallax layers that scroll with the camera's heading.
  for (let i = 0; i < 40; i++) {
    const layer = i & 1;
    const speed = layer ? 60 : 30;
    const sx = Math.floor((((i * 97) % 512) - (cam.angle * speed * 512) / Math.PI) % WIDTH);
    const sy = 2 + ((i * 53) % (HORIZON - 20));
    const twinkle = still || ((i * 7 + Math.floor(time * 4)) & 7) !== 0;
    if (twinkle) plot(buf, (sx + WIDTH) % WIDTH, sy, layer ? WHITE : rgb15(18, 18, 26));
  }
  // Mountains: a BG layer whose horizontal scroll follows the heading, as in Mode 7 racing games.
  const scroll = (cam.angle / (Math.PI * 2)) * 1024;
  for (let x = 0; x < WIDTH; x++) {
    const col = (((x + scroll) % 512) + 512) % 512;
    const top = Math.round(HORIZON - mountain(col));
    for (let y = Math.max(0, top); y < HORIZON; y++) buf[y * WIDTH + x] = px(y === top ? MOUNTAIN_HI : MOUNTAIN);
  }

  // Mode 7 floor: one matrix per scanline, faded into the horizon colour like colour math would.
  const fog = mix(skyLow, MOUNTAIN, 0.3);
  for (let y = HORIZON; y < HEIGHT; y++) {
    const d = y - HORIZON + 1;
    const line = mode7Line(d, cam.angle, cam.x, cam.y);
    const haze = Math.min(1, Math.max(0, 1 - d / 40));
    const tint = haze > 0 ? haze * haze : 0;
    let u = line.u;
    let v = line.v;
    const row = y * WIDTH;
    for (let x = 0; x < WIDTH; x++) {
      const c = tex[((Math.floor(v) & (TEX - 1)) << 7) | (Math.floor(u) & (TEX - 1))];
      if (tint > 0) {
        const r = (c & 0xff) >> 3;
        const g = ((c >> 8) & 0xff) >> 3;
        const b = ((c >> 16) & 0xff) >> 3;
        buf[row + x] = px(mix([r, g, b], fog, tint));
      } else buf[row + x] = c;
      u += line.du;
      v += line.dv;
    }
  }

  // Title: three times the font size, one gradient colour per scanline and a sine wave across the lines.
  const titleScale = 3;
  const titleW = textWidth(text.title, titleScale);
  const titleX = Math.round((WIDTH - titleW) / 2);
  const amp = still ? 0 : 2;
  drawText(
    buf,
    text.title,
    titleX,
    13,
    titleScale,
    (row) => px(TITLE[Math.min(TITLE.length - 1, Math.floor((row / (7 * titleScale)) * TITLE.length))]),
    (row) => waveOffset(row, time, amp),
  );
  const subtitle = fontText(text.subtitle);
  drawText(buf, subtitle, Math.round((WIDTH - textWidth(subtitle)) / 2), 42, 1, () => rgb15(26, 24, 31));

  // Credits: a bar along the bottom with text that scrolls and bounces character by character.
  const barTop = HEIGHT - 24;
  for (let y = barTop; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const c = buf[y * WIDTH + x];
      // Colour math at half: the floor under the bar at half brightness so the text reads.
      buf[y * WIDTH + x] = rgb15((c & 0xff) >> 4, ((c >> 8) & 0xff) >> 4, ((c >> 16) & 0xff) >> 4);
    }
  }
  buf.fill(SHADOW, barTop * WIDTH, (barTop + 1) * WIDTH);
  const scrollerScale = 2;
  if (still) {
    const line = fontText(text.still);
    drawText(buf, line, Math.round((WIDTH - textWidth(line, scrollerScale)) / 2), barTop + 5, scrollerScale, () => WHITE);
  } else {
    const line = fontText(text.scroller);
    const span = textWidth(line, scrollerScale) + WIDTH;
    const x = WIDTH - ((time * 48) % span);
    drawText(
      buf,
      line,
      Math.round(x),
      barTop + 6,
      scrollerScale,
      (row) => (row < 6 ? WHITE : rgb15(22, 20, 31)),
      () => 0,
      (i) => Math.round(Math.sin(time * 6 + i * 0.45) * 3),
    );
  }

  if (!still) applyMosaic(buf, mosaicSize(t));
}
