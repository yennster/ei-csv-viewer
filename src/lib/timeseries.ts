// src/lib/timeseries.ts — pure, deterministic time-series helpers.
//
// This is the analytical core of the Edge Impulse CSV Editor:
//   - channelRange / magnitudeBucket : value-range analysis
//   - autoGroupLanes                 : group channels whose ranges share an
//                                      order of magnitude into separate lanes,
//                                      so a 0..1000 signal and a 0..1 signal
//                                      each get their own readable y-axis
//   - presetOneLanePerChannel / presetSingleLane : the other lane presets
//   - cropDataset                    : trim every channel + time to [start,end]
//   - downsample                     : min/max bucketed decimation that
//                                      preserves visual extremes (for render)
//   - makeChannelColor               : stable, distinct color by index
//   - toEiPayload                    : column-orient values for ingestion
//
// All functions are pure and deterministic — no Date.now / Math.random. Any
// id generation is injectable so lane output is reproducible in tests.

import type { Channel, Dataset, Lane } from "@/lib/types";

// ---------------------------------------------------------------------------
// Range analysis
// ---------------------------------------------------------------------------

/** Inclusive numeric range of a channel's finite values. */
export interface Range {
  min: number;
  max: number;
}

/**
 * Compute the finite [min,max] of a channel's values. Non-finite values
 * (NaN, ±Infinity) are ignored. If a channel has no finite values, returns
 * { min: NaN, max: NaN } so callers can treat it as degenerate.
 */
export function channelRange(channel: Channel): Range {
  let min = Infinity;
  let max = -Infinity;
  const values = channel.values;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity || max === -Infinity) {
    return { min: NaN, max: NaN };
  }
  return { min, max };
}

/**
 * Map a value range to an integer order-of-magnitude bucket key.
 *
 * The bucket is `floor(log10(span))` where `span = max - min`. Channels whose
 * spans share a bucket land in the same lane.
 *
 * Edge cases:
 *   - A degenerate/flat range (NaN bounds, or span <= 0) returns the sentinel
 *     `FLAT_BUCKET` so constant / all-NaN channels never produce -Infinity or
 *     NaN bucket keys.
 */
export const FLAT_BUCKET = "flat" as const;
export type MagnitudeBucket = number | typeof FLAT_BUCKET;

export function magnitudeBucket(range: Range): MagnitudeBucket {
  const { min, max } = range;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return FLAT_BUCKET;
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) return FLAT_BUCKET;
  return Math.floor(Math.log10(span));
}

/**
 * Linear-interpolated quantile of a numeric series. Non-finite values are
 * ignored. `q` is clamped to [0,1]. Returns NaN for an empty/all-non-finite
 * input. Operates on a sorted copy (never mutates the input).
 */
export function quantile(values: number[], q: number): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return NaN;
  if (n === 1) return v[0];
  const p = Math.min(1, Math.max(0, q));
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return v[lo];
  const frac = pos - lo;
  return v[lo] + (v[hi] - v[lo]) * frac;
}

/**
 * Robust dynamic range of a series: the p99 - p1 percentile span. This resists
 * a single outlier spike that would otherwise inflate the raw max-min span and
 * mis-bucket a noisy real-sensor channel. Returns null for a degenerate series
 * (fewer than 2 finite samples).
 */
export function robustSpan(values: number[]): number | null {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return null;
  const p1 = quantile(finite, 0.01);
  const p99 = quantile(finite, 0.99);
  return p99 - p1;
}

/**
 * Order-of-magnitude bucket of a channel from its VALUES (the spec'd path used
 * by auto-grouping). Unlike magnitudeBucket(range) — which buckets on the raw
 * max-min span — this uses the robust p1/p99 span and a baseline-offset guard so
 * that:
 *   - a single spike in an otherwise 0..1 channel stays in bucket 0
 *     (the percentile span absorbs the outlier), and
 *   - a near-constant-but-offset signal (e.g. 100..101: small span, large
 *     baseline) does NOT merge with a 0..1 signal. The offsetGuard lifts the
 *     effective magnitude to the baseline |median| when the baseline dwarfs the
 *     span, so a channel living around 100 lands in a larger-magnitude bucket
 *     than one living around 0 — its lane auto-y reflects the baseline and the
 *     small-range signal is never crushed by it.
 *
 * A channel with NO variation (robust span 0) or fewer than 2 finite samples
 * returns FLAT_BUCKET (so a truly constant / all-NaN channel never yields
 * -Infinity/NaN and is parked in the trailing "Constant" lane). The baseline
 * guard only applies when there IS variation to plot.
 */
export function rangeBucket(
  values: number[],
  offsetGuard = true,
): MagnitudeBucket {
  const span = robustSpan(values);
  if (span === null) return FLAT_BUCKET;
  const absSpan = Math.abs(span);
  // No variation at all -> flat, regardless of baseline (nothing to scale).
  if (!(absSpan > 0)) return FLAT_BUCKET;

  let eff = absSpan;
  if (offsetGuard) {
    const med = Math.abs(quantile(values, 0.5));
    // When the baseline dwarfs the span, bucket by the baseline magnitude so an
    // offset signal separates from a zero-centered one.
    if (Number.isFinite(med)) eff = Math.max(eff, med);
  }
  if (!(eff > 0) || !Number.isFinite(eff)) return FLAT_BUCKET;
  return Math.floor(Math.log10(eff));
}

// ---------------------------------------------------------------------------
// Lane grouping + presets
// ---------------------------------------------------------------------------

export interface AutoGroupOptions {
  /** Deterministic lane id factory; receives the 0-based lane index. */
  idFactory?: (index: number) => string;
  /** Hard cap on the number of produced lanes (default 6). */
  maxLanes?: number;
  /** Guard near-constant-but-offset signals into their own bucket (default on). */
  offsetGuard?: boolean;
}

const defaultLaneId = (index: number): string => `lane_${index}`;

/**
 * Effective magnitude of a channel for lane grouping: the robust (p1..p99) span,
 * lifted to the baseline |median| when an offset dwarfs the span. Returns null
 * for a flat/degenerate series (no variation / fewer than 2 finite samples).
 */
function channelMagnitude(values: number[], offsetGuard: boolean): number | null {
  const span = robustSpan(values);
  if (span === null) return null;
  const absSpan = Math.abs(span);
  if (!(absSpan > 0)) return null;
  let eff = absSpan;
  if (offsetGuard) {
    const med = Math.abs(quantile(values, 0.5));
    if (Number.isFinite(med)) eff = Math.max(eff, med);
  }
  return eff > 0 && Number.isFinite(eff) ? eff : null;
}

/**
 * Channels share a lane only when their effective magnitudes are within this
 * factor of each other. Beyond it the smaller signal occupies too little of a
 * shared y-axis and is visually crushed (e.g. a ~1.8 axis beside a ~9.6 axis) —
 * the exact magnitude domination lanes exist to prevent. Whole-decade buckets
 * were too coarse: two channels ~5x apart still shared a single decade bucket.
 */
const LANE_MAGNITUDE_RATIO = 3;

/** Lane title: the channel name for a solo lane, else a magnitude label. */
function laneTitleFor(
  ids: string[],
  nameById: Map<string, string>,
  maxEff: number,
): string {
  if (ids.length === 1) {
    const n = nameById.get(ids[0]);
    if (n && n.trim()) return n;
  }
  const decade = Math.pow(10, Math.floor(Math.log10(maxEff)));
  return `~${formatMagnitude(decade)}`;
}

/** Compact magnitude label, e.g. 1000 -> "1k", 0.01 -> "0.01". */
function formatMagnitude(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1000) return `${value / 1000}k`;
  if (value >= 1) return String(value);
  // Sub-unit decades: show the actual decimal (0.1, 0.01, ...).
  return String(value);
}

/**
 * Auto-group channels into lanes by magnitude COMPATIBILITY. Two channels share
 * a lane only when their effective magnitudes are within LANE_MAGNITUDE_RATIO of
 * each other; beyond that the smaller signal is crushed on the shared y-axis.
 * Lanes are emitted in DESCENDING magnitude order (largest first), with
 * constant/flat channels parked in a trailing "Constant" lane.
 *
 * This is the core feature: a 0..1000 channel and a 0..1 channel — and, just as
 * importantly, a ~1.8 channel beside a ~9.6 channel (same decade, 5x apart) —
 * never share a y-axis, so no signal is hidden behind a larger-magnitude
 * neighbour. Whole-decade bucketing missed the latter case.
 *
 * Deterministic: lane ids come from `idFactory` (default `lane_<index>`),
 * channel order within a lane is restored to the input order.
 */
export function autoGroupLanes(
  channels: Channel[],
  options: AutoGroupOptions = {},
): Lane[] {
  const idFactory = options.idFactory ?? defaultLaneId;
  const maxLanes = options.maxLanes ?? 6;
  const offsetGuard = options.offsetGuard ?? true;
  if (channels.length === 0) return [];

  const nameById = new Map(channels.map((c) => [c.id, c.name]));
  const orderById = new Map(channels.map((c, i) => [c.id, i]));
  const byInputOrder = (a: string, b: string) =>
    (orderById.get(a) ?? 0) - (orderById.get(b) ?? 0);

  // 1. Effective magnitude per channel; flat/degenerate channels are set aside
  //    (the robust p1/p99 span keeps a lone spike from mis-sizing a channel).
  const sized: { id: string; eff: number }[] = [];
  const flatIds: string[] = [];
  for (const ch of channels) {
    const eff = channelMagnitude(ch.values, offsetGuard);
    if (eff === null) flatIds.push(ch.id);
    else sized.push({ id: ch.id, eff });
  }

  // 2. Greedy clustering: largest magnitude first, add the next channel to the
  //    current lane only while it stays within LANE_MAGNITUDE_RATIO of that
  //    lane's largest magnitude; otherwise open a new lane. Ties -> input order.
  const ordered = sized
    .map((s) => ({ ...s, ord: orderById.get(s.id) ?? 0 }))
    .sort((a, b) => b.eff - a.eff || a.ord - b.ord);

  let groups: { maxEff: number; ids: string[] }[] = [];
  for (const c of ordered) {
    const g = groups[groups.length - 1];
    if (g && c.eff > 0 && g.maxEff / c.eff <= LANE_MAGNITUDE_RATIO) {
      g.ids.push(c.id);
    } else {
      groups.push({ maxEff: c.eff, ids: [c.id] });
    }
  }

  // 3. Hard cap: while too many lanes, merge the adjacent pair whose magnitudes
  //    are closest (smallest ratio), keeping the most distinct magnitudes apart.
  while (groups.length > maxLanes) {
    let mergeAt = 0;
    let bestRatio = Infinity;
    for (let i = 0; i < groups.length - 1; i++) {
      const r =
        groups[i + 1].maxEff > 0
          ? groups[i].maxEff / groups[i + 1].maxEff
          : Infinity;
      if (r < bestRatio) {
        bestRatio = r;
        mergeAt = i;
      }
    }
    const a = groups[mergeAt];
    const b = groups[mergeAt + 1];
    groups.splice(mergeAt, 2, {
      maxEff: Math.max(a.maxEff, b.maxEff),
      ids: [...a.ids, ...b.ids],
    });
  }

  // 4. Restore input order within each lane.
  for (const g of groups) g.ids.sort(byInputOrder);

  // 5. Build lane specs; park constant/flat channels in a trailing lane.
  const laneSpecs = groups.map((g) => ({
    title: laneTitleFor(g.ids, nameById, g.maxEff),
    ids: g.ids,
  }));
  if (flatIds.length > 0) {
    laneSpecs.push({ title: "Constant", ids: [...flatIds].sort(byInputOrder) });
  }

  // 6. Emit lanes.
  return laneSpecs.map((g, index) => ({
    id: idFactory(index),
    title: g.title,
    channelIds: g.ids,
    yAuto: true,
  }));
}

/** One lane per channel; lane title = channel name. */
export function presetOneLanePerChannel(
  channels: Channel[],
  idFactory: (index: number) => string = defaultLaneId,
): Lane[] {
  return channels.map((ch, index) => ({
    id: idFactory(index),
    title: ch.name,
    channelIds: [ch.id],
    yAuto: true,
  }));
}

/**
 * All channels in a single shared lane. Intentionally reproduces the Edge
 * Impulse Studio "one shared axis" behaviour so users can compare.
 */
export function presetSingleLane(
  channels: Channel[],
  idFactory: (index: number) => string = defaultLaneId,
): Lane[] {
  if (channels.length === 0) return [];
  return [
    {
      id: idFactory(0),
      title: "All channels",
      channelIds: channels.map((c) => c.id),
      yAuto: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Crop
// ---------------------------------------------------------------------------

/**
 * Return a new Dataset whose channels (and time axis) are trimmed to the
 * inclusive index window [startIdx, endIdx]. Operates on full-resolution data.
 *
 * Bounds are clamped to valid indices and ordered, so out-of-range or reversed
 * inputs never throw. Channel ids/colors/metadata are preserved; lanes are
 * carried through unchanged (membership is by id, which is stable).
 */
export function cropDataset(
  dataset: Dataset,
  startIdx: number,
  endIdx: number,
): Dataset {
  // Length reference = the longest series (defensive against ragged data).
  let length = dataset.time?.length ?? 0;
  for (const ch of dataset.channels) {
    length = Math.max(length, ch.values.length);
  }

  if (length === 0) {
    return { ...dataset, channels: dataset.channels.map((c) => ({ ...c })) };
  }

  // Normalize + clamp bounds to [0, length-1], inclusive.
  let lo = Math.min(startIdx, endIdx);
  let hi = Math.max(startIdx, endIdx);
  lo = Math.max(0, Math.min(lo, length - 1));
  hi = Math.max(0, Math.min(hi, length - 1));

  const sliceEnd = hi + 1; // inclusive -> exclusive for Array.slice

  const channels: Channel[] = dataset.channels.map((ch) => ({
    ...ch,
    values: ch.values.slice(lo, sliceEnd),
  }));

  const time = dataset.time ? dataset.time.slice(lo, sliceEnd) : undefined;

  return {
    ...dataset,
    channels,
    time,
  };
}

// ---------------------------------------------------------------------------
// Downsampling (render-only; preserves visual extremes)
// ---------------------------------------------------------------------------

/**
 * Min/max bucketed decimation of a value series for rendering.
 *
 * The series is split into roughly `maxPoints / 2` contiguous buckets; each
 * bucket contributes its min and its max (in original index order), so peaks
 * and troughs are never dropped — unlike LTTB. Returns at most `maxPoints`
 * points. The full-resolution array is never mutated.
 *
 * Returns the decimated values plus the original indices they came from, so a
 * matching x-axis array can be sampled the same way.
 */
export interface Decimated {
  values: number[];
  /** Original index of each decimated value, ascending. */
  indices: number[];
}

export function downsample(values: number[], maxPoints: number): Decimated {
  const n = values.length;
  // Nothing to do: already small enough, or a nonsensical budget.
  if (maxPoints <= 0 || n === 0) {
    return { values: [], indices: [] };
  }
  if (n <= maxPoints) {
    return {
      values: values.slice(),
      indices: values.map((_, i) => i),
    };
  }

  // Each bucket yields up to 2 points (min, max), so size buckets accordingly.
  const bucketCount = Math.max(1, Math.floor(maxPoints / 2));
  const bucketSize = n / bucketCount;

  const outValues: number[] = [];
  const outIndices: number[] = [];

  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * bucketSize);
    let end = Math.floor((b + 1) * bucketSize);
    if (b === bucketCount - 1) end = n; // absorb rounding remainder
    if (start >= end) continue;

    let minIdx = -1;
    let maxIdx = -1;
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (let i = start; i < end; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (v < minVal) {
        minVal = v;
        minIdx = i;
      }
      if (v > maxVal) {
        maxVal = v;
        maxIdx = i;
      }
    }

    if (minIdx === -1) {
      // Bucket was entirely non-finite: emit the first index as NaN so the
      // gap is visible rather than silently bridged.
      outValues.push(values[start]);
      outIndices.push(start);
      continue;
    }

    // Emit min and max in original index order so the line draws correctly.
    const lowFirst = minIdx <= maxIdx;
    const firstIdx = lowFirst ? minIdx : maxIdx;
    const secondIdx = lowFirst ? maxIdx : minIdx;

    outValues.push(values[firstIdx]);
    outIndices.push(firstIdx);
    if (secondIdx !== firstIdx) {
      outValues.push(values[secondIdx]);
      outIndices.push(secondIdx);
    }
  }

  return { values: outValues, indices: outIndices };
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/**
 * Deterministic, distinct channel color palette. Stable by index: channel `i`
 * always gets the same color, so traces never jump color when lanes regroup.
 * The palette cycles (with a hue rotation) past its length so large channel
 * counts still get reasonably distinct colors.
 */
const PALETTE: readonly string[] = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#22c55e", // green
  "#f59e0b", // amber
  "#a855f7", // purple
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#14b8a6", // teal
  "#6366f1", // indigo
  "#eab308", // yellow
];

export function makeChannelColor(index: number): string {
  if (!Number.isInteger(index) || index < 0) return PALETTE[0];
  if (index < PALETTE.length) return PALETTE[index];
  // Beyond the base palette, rotate hue deterministically for fresh colors.
  const base = PALETTE[index % PALETTE.length];
  const cycle = Math.floor(index / PALETTE.length);
  return rotateHue(base, cycle * 37);
}

/** Rotate a hex color's hue by `degrees` (deterministic). */
function rotateHue(hex: string, degrees: number): string {
  const { r, g, b } = hexToRgb(hex);
  let { h, s, l } = rgbToHsl(r, g, b);
  h = (h + degrees) % 360;
  if (h < 0) h += 360;
  const rgb = hslToRgb(h, s, l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbToHsl(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h, s, l };
}

function hslToRgb(
  h: number,
  s: number,
  l: number,
): { r: number; g: number; b: number } {
  h /= 360;
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}

// ---------------------------------------------------------------------------
// Edge Impulse ingestion payload
// ---------------------------------------------------------------------------

export interface EiPayloadSensor {
  name: string;
  units: string;
}

export interface EiPayload {
  sensors: EiPayloadSensor[];
  /** One inner array PER TIMESTEP, one number per sensor axis. */
  values: number[][];
  /** Sample interval in milliseconds (derived from interval/frequency). */
  intervalMs: number;
}

/**
 * Build the column-oriented Edge Impulse ingestion payload from a Dataset.
 *
 * Edge Impulse expects `values` as one inner array PER TIMESTEP (row), one
 * number per sensor axis — the transpose of our per-channel storage. Only
 * VISIBLE channels are exported. Non-finite samples are coerced to 0 so the
 * ingestion API (which rejects NaN) accepts the body.
 *
 * intervalMs precedence: dataset.intervalMs -> 1000 / frequencyHz -> derived
 * from an explicit time[] axis (median delta in seconds) -> 0 (unknown).
 */
export function toEiPayload(dataset: Dataset): EiPayload {
  const channels = dataset.channels.filter((c) => c.visible !== false);

  const sensors: EiPayloadSensor[] = channels.map((c) => ({
    name: c.name,
    units: c.units ?? "N/A",
  }));

  // Row count = the longest exported channel.
  let rows = 0;
  for (const ch of channels) rows = Math.max(rows, ch.values.length);

  const values: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = new Array(channels.length);
    for (let c = 0; c < channels.length; c++) {
      const v = channels[c].values[r];
      row[c] = Number.isFinite(v) ? v : 0;
    }
    values.push(row);
  }

  return {
    sensors,
    values,
    intervalMs: deriveIntervalMs(dataset),
  };
}

/** Derive a millisecond sample interval from the dataset's timing metadata. */
function deriveIntervalMs(dataset: Dataset): number {
  if (dataset.intervalMs !== undefined && Number.isFinite(dataset.intervalMs)) {
    return dataset.intervalMs;
  }
  if (
    dataset.frequencyHz !== undefined &&
    Number.isFinite(dataset.frequencyHz) &&
    dataset.frequencyHz > 0
  ) {
    return 1000 / dataset.frequencyHz;
  }
  if (dataset.time && dataset.time.length >= 2) {
    // Median of finite consecutive deltas, treated as seconds -> ms.
    const deltas: number[] = [];
    for (let i = 1; i < dataset.time.length; i++) {
      const d = dataset.time[i] - dataset.time[i - 1];
      if (Number.isFinite(d) && d > 0) deltas.push(d);
    }
    if (deltas.length > 0) {
      deltas.sort((a, b) => a - b);
      const mid = Math.floor(deltas.length / 2);
      const median =
        deltas.length % 2 === 0
          ? (deltas[mid - 1] + deltas[mid]) / 2
          : deltas[mid];
      return median * 1000;
    }
  }
  return 0;
}
