import { describe, expect, it } from 'vitest';
import { BRR_END, BRR_LOOP } from '../../src/dsp/brr';
import { DIR, EDL, EFB, EVOLL, FIR, V_ADSR1, V_ADSR2, V_SRCN } from '../../src/dsp/dsp';
import { buildSpc } from '../../src/export/spc';
import { SONG_CHUNK, SPC_SIZE, directorySamples, isSpc, readSpc, spcTags } from '../../src/export/spcimport';
import { DIR_PAGE } from '../../src/tracker/aram';
import { demoSong } from '../../src/tracker/demo';
import { sampleBytes } from '../../src/tracker/sample';
import { parseSong } from '../../src/tracker/song';

/** An SPC from the tracker without its song chunk, as another player would leave it. */
function foreign() {
  const data = buildSpc(demoSong()).data.slice(0, SPC_SIZE);
  data[0x10100 + DIR] = DIR_PAGE;
  return data;
}

describe('SPC import', () => {
  it('loads the tracker’s own SPC back as the same song', () => {
    const song = demoSong();
    const { data } = buildSpc(song);
    expect(new TextDecoder().decode(data.subarray(SPC_SIZE, SPC_SIZE + 4))).toBe(SONG_CHUNK);
    const result = readSpc(data);
    expect(result.embedded).toBe(true);
    expect(result.song).toEqual(parseSong(JSON.parse(JSON.stringify(song))));
  });

  it('takes the samples out of the sample directory of any other SPC', () => {
    const song = demoSong();
    const result = readSpc(foreign(), 'file');
    expect(result.embedded).toBe(false);
    const used = song.samples.filter((s) => sampleBytes(s).length);
    expect(result.samples).toBe(used.length);
    result.song.samples.forEach((s, i) => {
      expect(Array.from(sampleBytes(s))).toEqual(Array.from(sampleBytes(used[i])));
      expect(s.loop).toBe(used[i].loop);
    });
    // One instrument per sample, an empty pattern, the title from the tag.
    expect(result.song.instruments[0].sample).toBe(0);
    expect(result.song.instruments[result.samples - 1].sample).toBe(result.samples - 1);
    expect(result.song.patterns).toHaveLength(1);
    expect(result.song.patterns[0].rows.flat().every((c) => c.note === -1)).toBe(true);
    expect(result.song.title).toBe(song.title);
  });

  it('tunes a single-cycle loop to C-4 and keeps one-shot samples one-shot', () => {
    const { song } = readSpc(foreign());
    const square = song.samples[0];
    expect(square.loop).toBe(0);
    expect(square.rate).toBe(demoSong().samples[0].rate);
    const kick = song.samples.find((_, i) => demoSong().samples[i].name === 'Kick')!;
    expect(kick.loop).toBe(-1);
    expect(kick.rate).toBe(32000);
  });

  it('copies the envelope of the voice playing a sample and the echo setup', () => {
    const data = foreign();
    const dsp = 0x10100;
    data[dsp + 0x30 + V_SRCN] = 2; // voice 3 plays SRCN 2
    data[dsp + 0x30 + V_ADSR1] = 0x80 | (3 << 4) | 9;
    data[dsp + 0x30 + V_ADSR2] = (5 << 5) | 17;
    data[dsp + EDL] = 3;
    data[dsp + EFB] = 0xc0;
    data[dsp + EVOLL] = 0x20;
    data[dsp + FIR + 0x10] = 0xff;
    const { song } = readSpc(data);
    expect(song.instruments[2].adsr).toEqual({ attack: 9, decay: 3, sustain: 5, sustainRate: 17 });
    expect(song.instruments[2].envelope).toBe('adsr');
    expect(song.echo.delay).toBe(3);
    expect(song.echo.feedback).toBe(-64);
    expect(song.echo.volumeL).toBe(32);
    expect(song.echo.fir[1]).toBe(-1);
  });

  it('skips entries that are not samples', () => {
    const ram = new Uint8Array(0x10000);
    const entry = (n: number, start: number, loop = start) => {
      ram.set([start & 0xff, start >> 8, loop & 0xff, loop >> 8], 0x400 + n * 4);
    };
    const block = (o: number, header: number) => {
      ram[o] = header;
      ram.fill(0x77, o + 1, o + 9);
    };
    block(0x1000, 0xb0 | BRR_END | BRR_LOOP); // a valid looped block
    entry(0, 0x1000);
    block(0x2000, 0xf0 | BRR_END); // shift 15: invalid
    entry(1, 0x2000);
    entry(2, 0x3000); // silent
    block(0xfff8, 0xb0); // runs off the end of RAM
    entry(3, 0xfff8);
    entry(4, 0x1000); // the same sample again
    block(0x1100, 0xb0);
    block(0x1109, 0xb0 | BRR_END);
    entry(5, 0x1100, 0x1105); // loop not on a block: one-shot
    const found = directorySamples(ram, 0x04);
    expect(found.map((f) => f.srcn)).toEqual([0, 5]);
    expect(found[1].sample.loop).toBe(-1);
  });

  it('reads ID666 tags in text and binary form', () => {
    const data = foreign();
    data.fill(0, 0xb0, 0xd1);
    data.set(new TextEncoder().encode('Koji'), 0xb1);
    expect(spcTags(data).artist).toBe('Koji');
    data.fill(0, 0xb0, 0xd1);
    data.set(new TextEncoder().encode('Koji'), 0xb0);
    expect(spcTags(data).artist).toBe('Koji');
  });

  it('rejects files that are not SPC files or have no samples', () => {
    expect(isSpc(new Uint8Array(100))).toBe(false);
    expect(() => readSpc(new Uint8Array(SPC_SIZE))).toThrow('Not an SPC file');
    const empty = foreign();
    empty.fill(0, 0x100, 0x10100);
    expect(() => readSpc(empty)).toThrow('No samples');
  });
});
