// src/lib/labels.ts — pure helpers for Edge Impulse time-series multi-label
// (structured-labels) data.
//
// Edge Impulse represents multi-label time-series data with a list of segments
// over the sample's index space: each segment is { startIndex, endIndex, label }
// with INCLUSIVE bounds. The segments of a sample must be CONTINUOUS and
// NON-OVERLAPPING over the full length of the sample. On upload they travel in a
// sidecar `structured_labels.labels` JSON file:
//
//   { "version": 1, "type": "structured-labels",
//     "structuredLabels": { "<data-file-name>": [ {startIndex,endIndex,label}, … ] } }
//
// See https://docs.edgeimpulse.com/studio/projects/data-acquisition/dataset/multi-label
// and the labels acquisition format reference.
//
// Everything here is pure and deterministic (no Date.now / Math.random) so the
// label engine is fully unit-testable and reproducible.

import type { StructuredLabel, StructuredLabelsFile } from "@/lib/types";

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/**
 * Deterministic, distinct palette for label segments. A label name always maps
 * to the same color regardless of how the labels are ordered, so a segment's
 * band/legend color never jumps as the user edits.
 */
export const LABEL_PALETTE: readonly string[] = [
  "#2563eb", // blue
  "#16a34a", // green
  "#d97706", // amber
  "#9333ea", // purple
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
  "#ea580c", // orange
  "#0d9488", // teal
  "#4f46e5", // indigo
  "#ca8a04", // yellow
  "#dc2626", // red
];

/**
 * Stable color for a label NAME. Hash the name to an index into the palette so
 * the same label is always the same color (independent of segment order or how
 * many distinct labels exist).
 */
export function labelColor(label: string): string {
  const name = (label ?? "").trim();
  if (name === "") return LABEL_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const idx = ((hash % LABEL_PALETTE.length) + LABEL_PALETTE.length) %
    LABEL_PALETTE.length;
  return LABEL_PALETTE[idx];
}

/** Distinct label names in first-seen order. */
export function distinctLabels(labels: StructuredLabel[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of labels) {
    if (!seen.has(l.label)) {
      seen.add(l.label);
      out.push(l.label);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Round + clamp a single segment's bounds to valid integers within length. */
function clampSegment(
  seg: StructuredLabel,
  length: number,
): StructuredLabel | null {
  const hi = length > 0 ? length - 1 : 0;
  let start = Math.round(seg.startIndex);
  let end = Math.round(seg.endIndex);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end) [start, end] = [end, start];
  start = Math.max(0, Math.min(start, hi));
  end = Math.max(0, Math.min(end, hi));
  if (end < start) return null;
  return { startIndex: start, endIndex: end, label: String(seg.label ?? "") };
}

/**
 * Normalize a list of segments: clamp to [0, length-1], drop degenerate ones,
 * and sort ascending by startIndex. Does NOT fill gaps or merge — it only makes
 * the list well-formed. When `length <= 0` the input is returned sorted/cleaned
 * against an open upper bound (used before a length is known).
 */
export function normalizeLabels(
  labels: StructuredLabel[] | undefined | null,
  length = 0,
): StructuredLabel[] {
  if (!labels || labels.length === 0) return [];
  const bound = length > 0 ? length : Number.MAX_SAFE_INTEGER;
  const out: StructuredLabel[] = [];
  for (const seg of labels) {
    const c = clampSegment(seg, length > 0 ? bound : bound + 1);
    if (c) out.push(c);
  }
  out.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
  return out;
}

/** Merge adjacent/touching segments that carry the SAME label. */
export function mergeAdjacent(labels: StructuredLabel[]): StructuredLabel[] {
  const sorted = [...labels].sort(
    (a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex,
  );
  const out: StructuredLabel[] = [];
  for (const seg of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.label === seg.label &&
      seg.startIndex <= prev.endIndex + 1
    ) {
      prev.endIndex = Math.max(prev.endIndex, seg.endIndex);
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Insert a labeled segment over the inclusive range [start, end], carving it out
 * of any existing segments so the result stays non-overlapping. Existing
 * segments that the new range fully covers are removed; partially-covered ones
 * are trimmed (and split when the new range falls inside them). Returns a
 * normalized, gap-merged list. `length` clamps the range.
 */
export function addLabelSegment(
  labels: StructuredLabel[],
  start: number,
  end: number,
  label: string,
  length: number,
): StructuredLabel[] {
  const inserted = clampSegment(
    { startIndex: start, endIndex: end, label },
    length,
  );
  if (!inserted) return mergeAdjacent(normalizeLabels(labels, length));

  const out: StructuredLabel[] = [];
  for (const seg of normalizeLabels(labels, length)) {
    // No overlap with the inserted range -> keep as-is.
    if (seg.endIndex < inserted.startIndex || seg.startIndex > inserted.endIndex) {
      out.push(seg);
      continue;
    }
    // Left remainder (the part of seg before the inserted range).
    if (seg.startIndex < inserted.startIndex) {
      out.push({
        startIndex: seg.startIndex,
        endIndex: inserted.startIndex - 1,
        label: seg.label,
      });
    }
    // Right remainder (the part of seg after the inserted range).
    if (seg.endIndex > inserted.endIndex) {
      out.push({
        startIndex: inserted.endIndex + 1,
        endIndex: seg.endIndex,
        label: seg.label,
      });
    }
  }
  out.push(inserted);
  return mergeAdjacent(normalizeLabels(out, length));
}

/** Remove the segment at `index` (no gap-filling). */
export function removeLabelAt(
  labels: StructuredLabel[],
  index: number,
): StructuredLabel[] {
  return labels.filter((_, i) => i !== index);
}

/** Rename the segment at `index`, merging with neighbours that now match. */
export function renameLabelAt(
  labels: StructuredLabel[],
  index: number,
  label: string,
): StructuredLabel[] {
  const next = labels.map((seg, i) =>
    i === index ? { ...seg, label } : seg,
  );
  return mergeAdjacent(next);
}

/**
 * Fill every uncovered index in [0, length-1] with `fillLabel` so the segments
 * become continuous over the full length (the shape Edge Impulse requires).
 * Existing segments are preserved; only the gaps (and any head/tail) are filled.
 */
export function fillGaps(
  labels: StructuredLabel[],
  length: number,
  fillLabel: string,
): StructuredLabel[] {
  if (length <= 0) return mergeAdjacent(normalizeLabels(labels, length));
  const sorted = normalizeLabels(labels, length);
  const out: StructuredLabel[] = [];
  let cursor = 0;
  for (const seg of sorted) {
    if (seg.startIndex > cursor) {
      out.push({
        startIndex: cursor,
        endIndex: seg.startIndex - 1,
        label: fillLabel,
      });
    }
    out.push(seg);
    cursor = Math.max(cursor, seg.endIndex + 1);
  }
  if (cursor <= length - 1) {
    out.push({ startIndex: cursor, endIndex: length - 1, label: fillLabel });
  }
  return mergeAdjacent(normalizeLabels(out, length));
}

/**
 * Re-index segments after the dataset is cropped to the inclusive window
 * [lo, hi]: shift every segment left by `lo`, clamp to the new [0, hi-lo] range,
 * and drop segments that fall entirely outside the window. Mirrors cropDataset.
 */
export function cropLabels(
  labels: StructuredLabel[] | undefined,
  lo: number,
  hi: number,
): StructuredLabel[] {
  if (!labels || labels.length === 0) return [];
  const low = Math.min(lo, hi);
  const high = Math.max(lo, hi);
  const newLength = high - low + 1;
  const out: StructuredLabel[] = [];
  for (const seg of labels) {
    const s = Math.max(seg.startIndex, low);
    const e = Math.min(seg.endIndex, high);
    if (e < s) continue; // segment is outside the kept window
    out.push({
      startIndex: s - low,
      endIndex: e - low,
      label: seg.label,
    });
  }
  return mergeAdjacent(normalizeLabels(out, newLength));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface LabelValidation {
  /** No two segments overlap. */
  nonOverlapping: boolean;
  /** No uncovered index between the first segment's start and the last's end. */
  continuous: boolean;
  /** Segments cover the whole [0, length-1] range with no head/tail gap. */
  fullLength: boolean;
  /** Uncovered inclusive ranges within [0, length-1]. */
  gaps: { startIndex: number; endIndex: number }[];
  /** Overlapping inclusive ranges. */
  overlaps: { startIndex: number; endIndex: number }[];
  /** True when the labels are upload-ready (non-overlapping + full length). */
  ok: boolean;
}

/**
 * Validate a set of segments against the Edge Impulse multi-label contract:
 * continuous + non-overlapping over the full sample length. Empty labels are
 * considered valid (a single-label / unlabeled sample).
 */
export function validateLabels(
  labels: StructuredLabel[],
  length: number,
): LabelValidation {
  const sorted = [...labels].sort(
    (a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex,
  );
  const overlaps: { startIndex: number; endIndex: number }[] = [];
  const gaps: { startIndex: number; endIndex: number }[] = [];

  let prevEnd = -1;
  let cursor = 0;
  for (const seg of sorted) {
    if (seg.startIndex <= prevEnd) {
      overlaps.push({
        startIndex: seg.startIndex,
        endIndex: Math.min(prevEnd, seg.endIndex),
      });
    } else if (seg.startIndex > cursor) {
      gaps.push({ startIndex: cursor, endIndex: seg.startIndex - 1 });
    }
    prevEnd = Math.max(prevEnd, seg.endIndex);
    cursor = Math.max(cursor, seg.endIndex + 1);
  }
  if (length > 0 && cursor <= length - 1 && sorted.length > 0) {
    gaps.push({ startIndex: cursor, endIndex: length - 1 });
  }

  const nonOverlapping = overlaps.length === 0;
  const continuous = gaps.length === 0;
  const fullLength =
    sorted.length > 0 &&
    sorted[0].startIndex === 0 &&
    cursor >= length &&
    continuous;
  const empty = sorted.length === 0;

  return {
    nonOverlapping,
    continuous: empty ? true : continuous,
    fullLength: empty ? false : fullLength,
    gaps,
    overlaps,
    ok: empty || (nonOverlapping && fullLength),
  };
}

// ---------------------------------------------------------------------------
// structured_labels.labels file (de)serialization
// ---------------------------------------------------------------------------

/** The standard name for the structured-labels sidecar file. */
export const STRUCTURED_LABELS_FILENAME = "structured_labels.labels";

/**
 * Build the `structured_labels.labels` file object that maps `dataFileName` to
 * its segments. The data file name MUST match the name of the uploaded data
 * file (Edge Impulse keys the labels by file name).
 */
export function buildStructuredLabelsFile(
  dataFileName: string,
  labels: StructuredLabel[],
): StructuredLabelsFile {
  return {
    version: 1,
    type: "structured-labels",
    structuredLabels: {
      [dataFileName]: labels.map((l) => ({
        startIndex: l.startIndex,
        endIndex: l.endIndex,
        label: l.label,
      })),
    },
  };
}

/** Pretty-print the structured-labels file as JSON text. */
export function serializeStructuredLabels(
  dataFileName: string,
  labels: StructuredLabel[],
): string {
  return JSON.stringify(buildStructuredLabelsFile(dataFileName, labels), null, 2);
}

/**
 * Parse a `structured_labels.labels` file (string or object) into a flat
 * segment list. When `fileName` is given its entry is preferred; otherwise the
 * first file's segments are returned. Returns [] on any malformed input.
 */
export function parseStructuredLabels(
  input: string | unknown,
  fileName?: string,
): StructuredLabel[] {
  let obj: unknown = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== "object") return [];
  const map = (obj as Partial<StructuredLabelsFile>).structuredLabels;
  if (!map || typeof map !== "object") return [];
  const entries = Object.entries(map as Record<string, unknown>);
  if (entries.length === 0) return [];
  let chosen: unknown =
    fileName && fileName in map
      ? (map as Record<string, unknown>)[fileName]
      : entries[0][1];
  if (!Array.isArray(chosen)) return [];
  const out: StructuredLabel[] = [];
  for (const seg of chosen as unknown[]) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Partial<StructuredLabel>;
    if (
      typeof s.startIndex === "number" &&
      typeof s.endIndex === "number" &&
      typeof s.label === "string"
    ) {
      out.push({
        startIndex: s.startIndex,
        endIndex: s.endIndex,
        label: s.label,
      });
    }
  }
  return normalizeLabels(out);
}
