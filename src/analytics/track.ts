export type TrackData = Record<string, string | number | boolean>;

/** The window event that carries every tracked action, see track(). */
export const TRACK_EVENT = 'snes-tracker:track';

/**
 * Reports a user action as a `snes-tracker:track` window event with
 * `{ name, data }` as its detail. The tracker itself sends nothing anywhere:
 * an analytics snippet added at build time (see src/analytics/plugin.ts) can
 * listen for these events and forward them. Never throws.
 */
export function track(name: string, data?: TrackData) {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(TRACK_EVENT, { detail: { name, data } }));
  } catch {
    // Analytics must never break the tracker.
  }
}
