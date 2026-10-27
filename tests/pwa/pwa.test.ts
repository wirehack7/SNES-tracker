import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serviceWorker } from '../../src/pwa/plugin';

const SCOPE = 'https://snes.example/app/';
const enc = (s: string) => new TextEncoder().encode(s);

/** A minimal Cache Storage and fetch, enough to run the service worker in Node. */
function environment(source: string, network: Record<string, string> | null) {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name)!;
    const key = (r: Request | string) => (typeof r === 'string' ? r : r.url);
    return {
      addAll: async (urls: string[]) => {
        for (const url of urls) map.set(url, await fetchMock(new Request(url)));
      },
      put: async (r: Request, res: Response) => void map.set(key(r), res),
      match: async (r: Request | string, opts?: { ignoreSearch?: boolean }) => {
        // Like the Cache API, ignore the fragment.
        let url = key(r).split('#')[0];
        if (opts?.ignoreSearch) url = url.split('?')[0];
        return map.get(url)?.clone();
      },
    };
  };
  const fetched: string[] = [];
  const fetchMock = async (r: Request) => {
    fetched.push(r.url);
    if (!network) throw new TypeError('offline');
    const path = r.url.slice(SCOPE.length);
    return path in network ? new Response(network[path]) : new Response('missing', { status: 404 });
  };
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = {
    registration: { scope: SCOPE },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  new Function('self', 'caches', 'fetch', source)(self, caches, fetchMock);
  /** Fires an event and waits for what it handed to waitUntil or respondWith. */
  const fire = async (type: string, request?: Request): Promise<Response | undefined> => {
    let pending: Promise<unknown> | undefined;
    listeners[type]({
      request,
      waitUntil: (p: Promise<unknown>) => (pending = p),
      respondWith: (p: Promise<unknown>) => (pending = p),
    });
    return (await pending) as Response | undefined;
  };
  return {
    stores,
    fetched,
    fire,
    setNetwork: (n: Record<string, string> | null) => (network = n),
  };
}

const navigate = (url: string) => Object.defineProperty(new Request(url), 'mode', { value: 'navigate' });

describe('service worker', () => {
  const build = [
    { path: 'index.html', data: enc('<tracker>') },
    { path: 'manual.html', data: enc('<manual>') },
    { path: 'assets/main-abc.js', data: enc('js') },
    { path: 'icon-192.png', data: enc('png') },
  ];
  const network = {
    '': '<tracker>',
    'index.html': '<tracker>',
    'manual.html': '<manual>',
    'assets/main-abc.js': 'js',
    'icon-192.png': 'png',
  };

  it('names its cache after the build contents', () => {
    const name = (src: string) => /const CACHE = "([^"]+)"/.exec(src)![1];
    const a = serviceWorker(build);
    expect(name(a)).toMatch(/^snes-tracker-[0-9a-f]{12}$/);
    expect(name(serviceWorker([...build].reverse()))).toBe(name(a));
    expect(name(serviceWorker([...build.slice(1), { path: 'index.html', data: enc('<new>') }]))).not.toBe(name(a));
  });

  it('caches the whole build on install and drops older versions on activate', async () => {
    const env = environment(serviceWorker(build), network);
    const old = env.stores.set('snes-tracker-000000000000', new Map()).set('other-app', new Map());
    await env.fire('install');
    await env.fire('activate');
    const names = [...old.keys()];
    expect(names).toHaveLength(2);
    expect(names).toContain('other-app');
    const cache = env.stores.get(names.find((n) => n.startsWith('snes-tracker-'))!)!;
    expect([...cache.keys()].sort()).toEqual([SCOPE, ...build.map((f) => SCOPE + f.path)].sort());
  });

  it('serves pages from the network when online and from the cache when offline', async () => {
    const env = environment(serviceWorker(build), network);
    await env.fire('install');
    env.setNetwork({ ...network, 'manual.html': '<manual v2>' });
    expect(await (await env.fire('fetch', navigate(SCOPE + 'manual.html')))!.text()).toBe('<manual v2>');
    env.setNetwork(null);
    expect(await (await env.fire('fetch', navigate(SCOPE + 'manual.html#export')))!.text()).toBe('<manual>');
    expect(await (await env.fire('fetch', navigate(SCOPE + '?song=1')))!.text()).toBe('<tracker>');
    // Any other page of the scope falls back to the tracker.
    expect(await (await env.fire('fetch', navigate(SCOPE + 'nothing/here')))!.text()).toBe('<tracker>');
  });

  it('serves assets from the cache without the network and caches new ones', async () => {
    const env = environment(serviceWorker(build), network);
    await env.fire('install');
    env.fetched.length = 0;
    expect(await (await env.fire('fetch', new Request(SCOPE + 'assets/main-abc.js')))!.text()).toBe('js');
    expect(env.fetched).toEqual([]);
    env.setNetwork({ ...network, 'docs/late.png': 'late' });
    expect(await (await env.fire('fetch', new Request(SCOPE + 'docs/late.png')))!.text()).toBe('late');
    env.setNetwork(null);
    expect(await (await env.fire('fetch', new Request(SCOPE + 'docs/late.png')))!.text()).toBe('late');
  });

  it('leaves other origins and non-GET requests to the browser', async () => {
    const env = environment(serviceWorker(build), network);
    expect(await env.fire('fetch', new Request('https://other.example/x.js'))).toBeUndefined();
    expect(await env.fire('fetch', new Request(SCOPE + 'api', { method: 'POST' }))).toBeUndefined();
  });
});

describe('web app manifest', () => {
  const pub = resolve(import.meta.dirname, '../../public');
  const manifest = JSON.parse(readFileSync(resolve(pub, 'manifest.webmanifest'), 'utf8'));

  it('makes an installable standalone app scoped to the site folder', () => {
    expect(manifest).toMatchObject({ start_url: './', scope: './', display: 'standalone' });
    expect(manifest.name).toBe('SNES Tracker');
    const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose);
    expect(purposes).toContain('maskable');
  });

  it('lists icons that exist at their stated sizes', () => {
    for (const icon of manifest.icons) {
      const data = readFileSync(resolve(pub, icon.src));
      if (icon.type !== 'image/png') continue;
      // PNG: the IHDR chunk holds width and height.
      expect(data.subarray(1, 4).toString()).toBe('PNG');
      expect(`${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`).toBe(icon.sizes);
    }
    const touch = readFileSync(resolve(pub, 'apple-touch-icon.png'));
    expect([touch.readUInt32BE(16), touch.readUInt32BE(20)]).toEqual([180, 180]);
  });

  it('is linked from the tracker and the manual', () => {
    for (const page of ['index.html', 'manual.html']) {
      const html = readFileSync(resolve(import.meta.dirname, '../..', page), 'utf8');
      expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
      expect(html).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />');
    }
  });
});
