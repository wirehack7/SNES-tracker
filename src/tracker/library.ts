/**
 * Song library: the songs kept in the browser (IndexedDB), each with an id and a few
 * details for the list, so the list can be shown without reading every song.
 */
import { Song, parseSong } from './song';

export interface SongMeta {
  id: string;
  title: string;
  author: string;
  bpm: number;
  /** Milliseconds since 1970 */
  created: number;
  updated: number;
  patterns: number;
  /** Length of the order list */
  positions: number;
}

/** Where the library keeps its data. */
export interface LibraryStore {
  list(): Promise<SongMeta[]>;
  get(id: string): Promise<unknown>;
  put(meta: SongMeta, song: Song): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Keeps everything in memory: for tests, and when the browser has no IndexedDB (some private windows). */
export class MemoryStore implements LibraryStore {
  private songs = new Map<string, { meta: SongMeta; song: Song }>();

  async list() {
    return [...this.songs.values()].map((e) => ({ ...e.meta }));
  }

  async get(id: string) {
    return structuredClone(this.songs.get(id)?.song);
  }

  async put(meta: SongMeta, song: Song) {
    this.songs.set(meta.id, { meta: { ...meta }, song: structuredClone(song) });
  }

  async delete(id: string) {
    this.songs.delete(id);
  }
}

const DB_NAME = 'snes-tracker';
const META = 'meta';
const SONGS = 'songs';

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** IndexedDB store: one object store for the list details, one for the songs. */
export class IndexedDbStore implements LibraryStore {
  private constructor(private db: IDBDatabase) {}

  static async open(): Promise<IndexedDbStore> {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(META, { keyPath: 'id' });
      request.result.createObjectStore(SONGS, { keyPath: 'id' });
    };
    return new IndexedDbStore(await done(request));
  }

  private async write(run: (meta: IDBObjectStore, songs: IDBObjectStore) => void) {
    const tx = this.db.transaction([META, SONGS], 'readwrite');
    run(tx.objectStore(META), tx.objectStore(SONGS));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  list() {
    return done(this.db.transaction(META).objectStore(META).getAll() as IDBRequest<SongMeta[]>);
  }

  async get(id: string) {
    const entry = await done(this.db.transaction(SONGS).objectStore(SONGS).get(id));
    return (entry as { song?: unknown } | undefined)?.song;
  }

  put(meta: SongMeta, song: Song) {
    return this.write((m, s) => {
      m.put(meta);
      s.put({ id: meta.id, song });
    });
  }

  delete(id: string) {
    return this.write((m, s) => {
      m.delete(id);
      s.delete(id);
    });
  }
}

/** Opens the IndexedDB library, or an in-memory one when the browser refuses. */
export async function openStore(): Promise<{ store: LibraryStore; persistent: boolean }> {
  try {
    return { store: await IndexedDbStore.open(), persistent: true };
  } catch {
    return { store: new MemoryStore(), persistent: false };
  }
}

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class SongLibrary {
  constructor(
    private store: LibraryStore,
    private now: () => number = Date.now,
  ) {}

  /** All songs, most recently changed first. */
  async list(): Promise<SongMeta[]> {
    return (await this.store.list()).sort((a, b) => b.updated - a.updated || a.title.localeCompare(b.title));
  }

  async meta(id: string): Promise<SongMeta | undefined> {
    return (await this.store.list()).find((m) => m.id === id);
  }

  /** The song with this id, validated like a song file; undefined when it is not in the library. */
  async load(id: string): Promise<Song | undefined> {
    const raw = await this.store.get(id);
    return raw === undefined ? undefined : parseSong(raw);
  }

  /** Saves the song under `id` (keeping its creation date), or as a new entry without one. */
  async save(song: Song, id?: string): Promise<SongMeta> {
    const old = id ? await this.meta(id) : undefined;
    const time = this.now();
    const meta: SongMeta = {
      id: old?.id ?? id ?? newId(),
      title: song.title,
      author: song.author,
      bpm: song.bpm,
      created: old?.created ?? time,
      updated: time,
      patterns: song.patterns.length,
      positions: song.order.length,
    };
    await this.store.put(meta, song);
    return meta;
  }

  /** Copies an entry; the copy's title gets a suffix such as " (copy)". */
  async duplicate(id: string, suffix: string): Promise<SongMeta> {
    const song = await this.require(id);
    song.title = `${song.title}${suffix}`;
    return this.save(song);
  }

  /** Changes the title of an entry, inside the song too. */
  async rename(id: string, title: string): Promise<SongMeta> {
    const song = await this.require(id);
    song.title = title;
    return this.save(song, id);
  }

  remove(id: string): Promise<void> {
    return this.store.delete(id);
  }

  private async require(id: string): Promise<Song> {
    const song = await this.load(id);
    if (!song) throw new Error('Song not found');
    return song;
  }
}

/** Takes the instruments, samples and echo settings of `source` into `target`, leaving its notes alone. */
export function copySounds(target: Song, source: Song) {
  // Instruments refer to samples by index, so they travel together.
  target.instruments = structuredClone(source.instruments);
  target.samples = structuredClone(source.samples);
  target.echo = structuredClone(source.echo);
}

/** A file name without characters that file systems reject. */
export const fileName = (title: string) => (title || 'song').replace(/[^\w-]+/g, '_');

/** Gives every name in the list a different spelling by numbering repeats ("a", "a_2", …). */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    let name = n;
    for (let i = 2; used.has(name); i++) name = `${n}_${i}`;
    used.add(name);
    return name;
  });
}
