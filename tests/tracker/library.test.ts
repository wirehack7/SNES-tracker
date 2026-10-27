import { describe, expect, it } from 'vitest';
import { unzip, zip } from '../../src/export/zip';
import { MemoryStore, SongLibrary, copySounds, fileName, uniqueNames } from '../../src/tracker/library';
import { createSong } from '../../src/tracker/song';

function library() {
  let time = 1000;
  return new SongLibrary(new MemoryStore(), () => (time += 1000));
}

function song(title: string) {
  const s = createSong();
  s.title = title;
  return s;
}

describe('song library', () => {
  it('saves new songs and lists the latest change first', async () => {
    const lib = library();
    const a = await lib.save(song('A'));
    const b = await lib.save(song('B'));
    expect(a.id).not.toBe(b.id);
    expect((await lib.list()).map((m) => m.title)).toEqual(['B', 'A']);
    await lib.save(song('A2'), a.id);
    expect((await lib.list()).map((m) => m.title)).toEqual(['A2', 'B']);
  });

  it('keeps the creation date when saving over an entry', async () => {
    const lib = library();
    const first = await lib.save(song('A'));
    const again = await lib.save(song('A'), first.id);
    expect(again.id).toBe(first.id);
    expect(again.created).toBe(first.created);
    expect(again.updated).toBeGreaterThan(first.updated);
  });

  it('stores a copy, so later edits of the song do not leak into the library', async () => {
    const lib = library();
    const s = song('A');
    const { id } = await lib.save(s);
    s.patterns[0].rows[0][0].note = 24;
    s.title = 'changed';
    const loaded = await lib.load(id);
    expect(loaded?.title).toBe('A');
    expect(loaded?.patterns[0].rows[0][0].note).toBe(-1);
  });

  it('lists details without loading the songs', async () => {
    const lib = library();
    const s = song('Tune');
    s.author = 'me';
    s.bpm = 140;
    s.patterns.push(s.patterns[0]);
    s.order = [0, 1, 0];
    const meta = await lib.save(s);
    expect(meta).toMatchObject({ title: 'Tune', author: 'me', bpm: 140, patterns: 2, positions: 3 });
  });

  it('renames inside the song too', async () => {
    const lib = library();
    const { id } = await lib.save(song('Old'));
    await lib.rename(id, 'New');
    expect((await lib.meta(id))?.title).toBe('New');
    expect((await lib.load(id))?.title).toBe('New');
  });

  it('duplicates with a suffix and deletes', async () => {
    const lib = library();
    const { id } = await lib.save(song('Tune'));
    const copy = await lib.duplicate(id, ' (copy)');
    expect(copy.id).not.toBe(id);
    expect((await lib.load(copy.id))?.title).toBe('Tune (copy)');
    await lib.remove(id);
    expect(await lib.load(id)).toBeUndefined();
    expect((await lib.list()).map((m) => m.id)).toEqual([copy.id]);
    await expect(lib.rename(id, 'x')).rejects.toThrow();
  });

  it('validates what it loads like a song file', async () => {
    const store = new MemoryStore();
    const lib = new SongLibrary(store);
    const bad = song('Bad');
    bad.speed = 99;
    const { id } = await lib.save(bad);
    expect((await lib.load(id))?.speed).toBe(31);
  });

  it('copies instruments, samples and echo but not the notes', () => {
    const target = song('T');
    target.patterns[0].rows[0][0].note = 12;
    const source = song('S');
    source.instruments[3].pan = 0x20;
    source.instruments[3].noise = true;
    source.echo.delay = 7;
    source.samples = [{ name: 'kick', brr: 'AAAAAAAAAAAA', loop: -1, rate: 16000 }];
    copySounds(target, source);
    expect(target.samples.map((x) => x.name)).toEqual(['kick']);
    expect(target.instruments[3].pan).toBe(0x20);
    expect(target.instruments[3].noise).toBe(true);
    expect(target.echo.delay).toBe(7);
    expect(target.patterns[0].rows[0][0].note).toBe(12);
    source.instruments[3].pan = 0;
    expect(target.instruments[3].pan).toBe(0x20);
  });

  it('makes file names safe and unique', () => {
    expect(fileName('My song: v2!')).toBe('My_song_v2_');
    expect(fileName('')).toBe('song');
    expect(uniqueNames(['a', 'a', 'b', 'a_2', 'a'])).toEqual(['a', 'a_2', 'b', 'a_2_2', 'a_3']);
  });
});

describe('zip', () => {
  it('reads back what it writes', () => {
    const data = zip([
      { name: 'one.gbt.json', data: '{"a":1}' },
      { name: 'Ünicode.txt', data: new Uint8Array([0, 1, 2, 255]) },
    ]);
    const entries = unzip(data);
    expect(entries.map((e: { name: string }) => e.name)).toEqual(['one.gbt.json', 'Ünicode.txt']);
    expect(new TextDecoder().decode(entries[0].data as Uint8Array)).toBe('{"a":1}');
    expect([...(entries[1].data as Uint8Array)]).toEqual([0, 1, 2, 255]);
  });

  it('rejects files that are not ZIPs', () => {
    expect(() => unzip(new TextEncoder().encode('{"patterns":[]}'))).toThrow('Not a ZIP file');
  });
});
