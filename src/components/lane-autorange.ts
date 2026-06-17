/**
 * lane-autorange.ts — per-lane auto y-extent.
 *
 * Computes a padded [lo,hi] over ONLY the visible channels in a lane, restricted
 * to the samples inside the current x-window (so zooming into a quiet region
 * re-fills the lane — the killer feature vs Edge Impulse's single shared axis).
 *
 * It scans the FULL-resolution values (true min/max), so peaks are never
 * clipped. When the x-window covers the whole series it short-circuits via
 * timeseries' `channelRange`.
 */

import type { Channel } from "@/lib/types";
import { channelRange } from "@/lib/timeseries";

/**
 * @param channels visible channels assigned to the lane
 * @param xs       shared x-axis array (sample index or seconds)
 * @param window   current x-window in x-domain units, or null for full extent
 */
export function laneAutoRange(
  channels: Channel[],
  xs: number[],
  window: { min: number; max: number } | null,
): [number, number] {
  let min = Infinity;
  let max = -Infinity;

  // Resolve the inclusive sample-index window from the x-domain window.
  const [iStart, iEnd] = indexWindow(xs, window);

  const full = !window;

  for (const c of channels) {
    if (full) {
      const r = channelRange(c);
      if (Number.isFinite(r.min) && Number.isFinite(r.max)) {
        if (r.min < min) min = r.min;
        if (r.max > max) max = r.max;
      }
      continue;
    }
    const end = Math.min(iEnd, c.values.length - 1);
    for (let i = iStart; i <= end; i++) {
      const v = c.values[i];
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }

  // No finite data in window -> a safe unit window.
  if (min === Infinity || max === -Infinity) return [-1, 1];

  if (min === max) return [min - 1, max + 1];

  const pad = (max - min) * 0.06 || 1e-6;
  return [min - pad, max + pad];
}

/** Map an x-domain window to an inclusive [startIdx, endIdx] sample window. */
export function indexWindow(
  xs: number[],
  window: { min: number; max: number } | null,
): [number, number] {
  const n = xs.length;
  if (n === 0) return [0, -1];
  if (!window) return [0, n - 1];

  // typical case: xs ascending -> binary search the bounds
  const ascending = xs[0] <= xs[n - 1];
  if (ascending) {
    const lo = lowerBound(xs, window.min);
    const hi = upperBound(xs, window.max);
    const start = Math.max(0, lo - 1);
    const end = Math.min(n - 1, hi);
    return [Math.min(start, end), Math.max(start, end)];
  }

  // non-monotonic x -> linear scan
  let start = 0;
  let end = n - 1;
  for (let i = 0; i < n; i++) {
    if (xs[i] >= window.min) {
      start = i;
      break;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    if (xs[i] <= window.max) {
      end = i;
      break;
    }
  }
  return [Math.min(start, end), Math.max(start, end)];
}

/** First index with xs[i] >= v (ascending xs). */
function lowerBound(xs: number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Last index with xs[i] <= v (ascending xs). */
function upperBound(xs: number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
