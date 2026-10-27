import type { Plugin } from 'vite';

/**
 * The analytics snippet of the live site: raw HTML (usually one or more
 * <script> tags) from the TRACKING_CODE environment variable, which the Pages
 * workflow sets from a repository variable. Without it (local, dev and CI
 * builds, forks) the site is built without any tracking.
 */
export function trackingCode(env: Record<string, string | undefined> = process.env): string | null {
  return env.TRACKING_CODE?.trim() || null;
}

/** Puts the snippet, as it is, at the end of <head> of every page of a production build. */
export function analytics(code = trackingCode()): Plugin {
  return {
    name: 'snes-tracker-analytics',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => (code ? html.replace('</head>', `${code}\n  </head>`) : html),
    },
  };
}
