import { afterEach, describe, expect, it, vi } from 'vitest';
import { analytics, trackingCode } from '../../src/analytics/plugin';
import { TRACK_EVENT, track } from '../../src/analytics/track';

const SNIPPET =
  '<script defer src="https://stats.example/a.js" data-site="x"></script>\n<script>window.ok = 1;</script>';

describe('tracking code', () => {
  const page = '<html><head><title>x</title></head><body></body></html>';
  const transform = (p: ReturnType<typeof analytics>) =>
    (p.transformIndexHtml as unknown as { handler: (html: string) => string }).handler(page);

  it('is off unless the variable is set', () => {
    expect(trackingCode({})).toBeNull();
    expect(trackingCode({ TRACKING_CODE: '  \n' })).toBeNull();
    expect(trackingCode({ TRACKING_CODE: ` ${SNIPPET}\n` })).toBe(SNIPPET);
  });

  it('puts the snippet as it is into <head>, only when set', () => {
    expect(transform(analytics(null))).toBe(page);
    const html = transform(analytics(SNIPPET));
    expect(html).toContain(`${SNIPPET}\n  </head>`);
    expect(html.indexOf(SNIPPET)).toBeLessThan(html.indexOf('<body>'));
  });
});

describe('track', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('dispatches a window event', () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    target.addEventListener(TRACK_EVENT, (e) => seen.push((e as CustomEvent).detail));
    vi.stubGlobal('window', target);
    track('export', { format: 'xm' });
    track('stop');
    expect(seen).toEqual([{ name: 'export', data: { format: 'xm' } }, { name: 'stop', data: undefined }]);
  });

  it('never throws', () => {
    vi.stubGlobal('window', {
      dispatchEvent: () => {
        throw new Error('blocked');
      },
    });
    expect(() => track('play')).not.toThrow();
  });
});
