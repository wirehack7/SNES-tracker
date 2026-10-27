/** Minimal ZIP writer (stored, no compression) for bundling exported projects. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
}

export function zip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const files = entries.map((e) => {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    return { name: enc.encode(e.name), data, crc: crc32(data) };
  });
  const localSize = files.reduce((n, f) => n + 30 + f.name.length + f.data.length, 0);
  const centralSize = files.reduce((n, f) => n + 46 + f.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const v = new DataView(out.buffer);
  // DOS date 2026-01-01 00:00, fixed so exports are reproducible.
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  let p = 0;
  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(p);
    v.setUint32(p, 0x04034b50, true);
    v.setUint16(p + 4, 20, true);
    v.setUint16(p + 6, 0x0800, true); // UTF-8 names
    v.setUint16(p + 8, 0, true);
    v.setUint16(p + 10, 0, true);
    v.setUint16(p + 12, date, true);
    v.setUint32(p + 14, f.crc, true);
    v.setUint32(p + 18, f.data.length, true);
    v.setUint32(p + 22, f.data.length, true);
    v.setUint16(p + 26, f.name.length, true);
    v.setUint16(p + 28, 0, true);
    out.set(f.name, p + 30);
    out.set(f.data, p + 30 + f.name.length);
    p += 30 + f.name.length + f.data.length;
  }
  const centralStart = p;
  files.forEach((f, i) => {
    v.setUint32(p, 0x02014b50, true);
    v.setUint16(p + 4, 20, true);
    v.setUint16(p + 6, 20, true);
    v.setUint16(p + 8, 0x0800, true);
    v.setUint16(p + 10, 0, true);
    v.setUint16(p + 12, 0, true);
    v.setUint16(p + 14, date, true);
    v.setUint32(p + 16, f.crc, true);
    v.setUint32(p + 20, f.data.length, true);
    v.setUint32(p + 24, f.data.length, true);
    v.setUint16(p + 28, f.name.length, true);
    v.setUint32(p + 42, offsets[i], true);
    out.set(f.name, p + 46);
    p += 46 + f.name.length;
  });
  v.setUint32(p, 0x06054b50, true);
  v.setUint16(p + 8, files.length, true);
  v.setUint16(p + 10, files.length, true);
  v.setUint32(p + 12, centralSize, true);
  v.setUint32(p + 16, centralStart, true);
  return out;
}

/**
 * Reads the entries of a ZIP file written without compression, such as the ones `zip()` writes.
 * Throws on compressed entries, which this tracker never writes.
 */
export function unzip(data: Uint8Array): ZipEntry[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Not a ZIP file');
  const count = v.getUint16(end + 10, true);
  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = v.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Broken ZIP directory');
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLength = v.getUint16(p + 28, true);
    const extraLength = v.getUint16(p + 30, true);
    const commentLength = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = dec.decode(data.subarray(p + 46, p + 46 + nameLength));
    if (method !== 0) throw new Error(`${name} is compressed`);
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    entries.push({ name, data: data.slice(start, start + size) });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
