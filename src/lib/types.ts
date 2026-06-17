// src/lib/types.ts — the single shared data model, imported everywhere.

/** A hex color string, e.g. "#3b82f6". */
export type HexColor = string;

/** Which Edge Impulse dataset bucket a sample belongs to. */
export type EICategory = "training" | "testing" | "anomaly";

/** UI theme. */
export type Theme = "dark" | "light";

/**
 * App mode. `editor` (default) exposes every data-mutating action; `viewer` is a
 * read-only analysis surface that hides write-back controls (crop apply/trim,
 * channel/sample rename, Edge Impulse upload) while keeping all view + analysis
 * (lanes, drag-to-regroup, zoom/pan, the formula engine, and CSV export).
 */
export type Mode = "editor" | "viewer";

/** Lane membership preset names (UI-facing). */
export type LanePreset = "one-per-channel" | "all-in-one" | "auto-group";

/** Internal preset state in the store; "custom" once the user drags. */
export type UrlPreset = "auto" | "one" | "all" | "custom";

/**
 * One sensor axis / data series. `values` is ALWAYS the full-resolution data
 * (never the downsampled render copy). `id` is a stable internal id (nanoid),
 * independent of `name` so renames never break lane membership or DnD.
 */
export interface Channel {
  id: string;
  name: string;
  units?: string;
  values: number[];
  color: HexColor;
  visible: boolean;
  /** true for a formula-derived channel (otherwise behaves like any channel). */
  derived?: boolean;
  /** the source expression that produced `values` (derived channels only). */
  expr?: string;
}

/**
 * A horizontal lane = one uPlot chart with its OWN y-axis. `channelIds` is an
 * ordered list (order = legend/stack order). All lanes share the dataset x-axis
 * and a synchronized cursor. y auto-scales unless yAuto is false, in which case
 * yMin/yMax pin the scale.
 */
export interface Lane {
  id: string;
  title: string;
  channelIds: string[];
  yAuto: boolean;
  yMin?: number;
  yMax?: number;
  ySymmetric?: boolean;
  heightPx?: number;
}

/**
 * The full editor document. `time` is the explicit x-axis (seconds or sample
 * index); when absent the x-axis is derived from intervalMs/frequencyHz or a
 * 0..n-1 index. Channels hold full data; lanes are pure view groupings.
 */
export interface Dataset {
  channels: Channel[];
  lanes: Lane[];
  time?: number[];
  intervalMs?: number;
  frequencyHz?: number;
  source: "csv" | "edge-impulse";
  name: string;
  sampleId?: number;
}

/** Server-side session, persisted only in the httpOnly `ei_session` cookie. */
export interface EISession {
  apiKey: string;
  projectId: number;
  studioHost?: string;
  ingestionHost?: string;
}

// ---- Edge Impulse wire shapes (validated at the proxy boundary) ----

/** Studio {success,error} envelope wrapping every JSON response. */
export interface EIEnvelope {
  success: boolean;
  error?: string;
}

/** A row in GET /{projectId}/raw-data (sample list metadata). */
export interface EISampleMeta {
  id: number;
  filename: string;
  label: string;
  category: EICategory;
  sensors: { name: string; units?: string }[];
  frequency?: number;
  intervalMs?: number;
  totalLengthMs?: number;
  valuesCount?: number;
}

/** Alias kept for callers that refer to a sample row simply as EISample. */
export type EISample = EISampleMeta;

/** payload object from GET /{projectId}/raw-data/{sampleId}. */
export interface EISamplePayload {
  device_type?: string;
  sensors: { name: string; units?: string }[];
  /** one inner array PER TIMESTEP, one number per sensor axis. */
  values: number[][];
  intervalMs?: number;
  frequencyHz?: number;
  cropStart?: number;
  cropEnd?: number;
}

/** GET /{projectId}/raw-data/{sampleId} full body. */
export interface EISampleResponse extends EIEnvelope {
  sample: EISampleMeta;
  payload: EISamplePayload;
  totalPayloadLength: number;
}

/** Edge Impulse JSON body posted to the ingestion API (note interval_ms). */
export interface EIIngestionBody {
  protected: { ver: "v1"; alg: "none"; iat: number };
  signature: "empty";
  payload: {
    device_name: string;
    device_type: string;
    interval_ms: number;
    sensors: { name: string; units: string }[];
    values: number[][];
  };
}

// ---- URL params (parsed once at load, never throws) ----

export interface AppParams {
  apiKey?: string; // matches /^ei_/, moved to cookie then stripped from URL
  category?: EICategory;
  labels?: string[]; // comma list
  sample?: number; // alias sampleId, int >= 1 — auto-open in editor
  limit: number; // 1..1000, default 200
  offset: number; // >= 0, default 0
  theme?: Theme;
  embed: boolean; // hides chrome inside iframe
  mode: Mode; // viewer | editor (default editor); viewer hides write-back controls
  studioHost?: string;
  ingestionHost?: string;
}

// ---- Helpers (signatures only; impls live in their modules) ----

/** Decimate for rendering only; returns indices into the full series. */
export type Downsampler = (
  xs: number[],
  ys: number[],
  maxPoints: number,
) => {
  x: number[];
  y: number[];
  idx: number[];
};
