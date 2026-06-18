// src/lib/ei-client.ts — BROWSER-SIDE Edge Impulse helpers.
//
// Thin, typed wrappers over the same-origin /api/ei/* route handlers. These run
// in the browser and NEVER touch the API key (it lives only in the httpOnly
// `ei_session` cookie, which the same-origin fetch sends automatically).
//
// Also converts an Edge Impulse sample payload (sensors + values, one row per
// timestep) into the shared Dataset/Channel model.
//
// Two naming sets are exported so callers can use whichever fits:
//   - store-facing:  connectSession / disconnectSession / loadSample /
//                    uploadSample / cropSample / listSamples (returns array)
//   - descriptive:   connect / disconnect / loadDataset / uploadDataset /
//                    getSample / renameSample
// Both back onto the same route handlers.

import type {
  Channel,
  Dataset,
  EICategory,
  EISampleMeta,
  EISamplePayload,
} from "@/lib/types";
import { normalizeLabels } from "@/lib/labels";

// ---- ids + colors (self-contained; no external deps) ----------------------

/** Generate a stable, collision-resistant id for a channel/lane. */
function genId(prefix: string): string {
  const rnd =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${rnd}`;
}

/**
 * Deterministic palette (theme-friendly hex). Colors are assigned by channel
 * index at load and are stable for the life of the dataset.
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

function colorForIndex(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

// ---- response shapes from our own routes ----------------------------------

export interface ConnectResult {
  success: boolean;
  error?: string;
  projectId?: number;
  projectName?: string;
  studioHost?: string;
}

export interface SessionStatus {
  success: true;
  connected: boolean;
  projectId?: number;
  studioHost?: string;
}

export interface RenameResult {
  success: true;
  sampleId: number;
  newLabel: string;
}

export interface UploadResult {
  success: true;
  category: EICategory;
  label: string;
  fileName: string;
  sampleCount: number;
  response: unknown;
}

export interface CropResult {
  success: true;
  sample?: EISampleMeta;
}

/** Thrown for any non-success response from our /api/ei/* routes. */
export class EIClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EIClientError";
  }
}

// ---- low-level fetch helpers ----------------------------------------------

/**
 * Fetch JSON and enforce the {success} envelope, THROWING on failure.
 * Used by helpers that surface errors as exceptions.
 */
async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const { ok, status, body } = await rawJson(input, init);
  const env = body as { success?: boolean; error?: string } | null;
  if (!ok || !env || env.success !== true) {
    const msg =
      (env && typeof env.error === "string" && env.error) ||
      `Request failed (${status})`;
    throw new EIClientError(msg, status);
  }
  return body as T;
}

/** Fetch JSON WITHOUT throwing on {success:false}; returns the parsed envelope. */
async function rawJson(
  input: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(input, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = { success: false, error: `Non-JSON response from ${input}` };
  }
  return { ok: res.ok, status: res.status, body };
}

// ---- session --------------------------------------------------------------

export interface ConnectInput {
  apiKey: string;
  projectId?: number;
  studioHost?: string;
  ingestionHost?: string;
}

/**
 * Validate + persist a session (POST /api/ei/session). Does NOT throw on a
 * rejected key/project — returns `{ success:false, error }` so the caller (the
 * store) can surface the message inline.
 */
export async function connectSession(
  input: ConnectInput,
): Promise<ConnectResult> {
  const { body } = await rawJson("/api/ei/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const env = (body ?? {}) as ConnectResult;
  return {
    success: env.success === true,
    error: typeof env.error === "string" ? env.error : undefined,
    projectId: typeof env.projectId === "number" ? env.projectId : undefined,
    projectName:
      typeof env.projectName === "string" ? env.projectName : undefined,
    studioHost:
      typeof env.studioHost === "string" ? env.studioHost : undefined,
  };
}

/** Alias: descriptive name for connectSession. */
export const connect = connectSession;

/** Read connection status without exposing the apiKey (GET /api/ei/session). */
export async function getSessionStatus(): Promise<SessionStatus> {
  return requestJson<SessionStatus>("/api/ei/session", { method: "GET" });
}

/** Clear the session (DELETE /api/ei/session). */
export async function disconnectSession(): Promise<void> {
  await requestJson<{ success: true }>("/api/ei/session", {
    method: "DELETE",
  });
}

/** Alias: descriptive name for disconnectSession. */
export const disconnect = disconnectSession;

// ---- samples --------------------------------------------------------------

export interface ListSamplesInput {
  category?: EICategory;
  labels?: string[];
  limit?: number;
  offset?: number;
}

interface ListSamplesResponse {
  success: true;
  samples: EISampleMeta[];
  totalCount: number;
  limit: number;
  offset: number;
  category: EICategory | null;
}

/**
 * List sample metadata for the connected project (GET /api/ei/samples).
 * Returns the samples array directly (the store stores it as-is).
 */
export async function listSamples(
  input: ListSamplesInput = {},
): Promise<EISampleMeta[]> {
  const qs = new URLSearchParams();
  if (input.category) qs.set("category", input.category);
  if (typeof input.limit === "number") qs.set("limit", String(input.limit));
  if (typeof input.offset === "number") qs.set("offset", String(input.offset));
  if (input.labels && input.labels.length) {
    qs.set("labels", input.labels.join(","));
  }
  const q = qs.toString();
  const res = await requestJson<ListSamplesResponse>(
    `/api/ei/samples${q ? `?${q}` : ""}`,
    { method: "GET" },
  );
  return res.samples ?? [];
}

export interface GetSampleResult {
  success: true;
  sample: EISampleMeta;
  payload: EISamplePayload;
  totalPayloadLength: number;
}

/** Load one sample's full payload (GET /api/ei/sample/{id}). */
export async function getSample(sampleId: number): Promise<GetSampleResult> {
  return requestJson<GetSampleResult>(
    `/api/ei/sample/${encodeURIComponent(String(sampleId))}`,
    { method: "GET" },
  );
}

/**
 * Load a sample by id and return a ready-to-edit Dataset (channels built from
 * payload.sensors + payload.values). The store calls this directly.
 */
export async function loadSample(sampleId: number): Promise<Dataset> {
  const { sample, payload } = await getSample(sampleId);
  return datasetFromSample(sample, payload);
}

/** Alias: descriptive name for loadSample. */
export const loadDataset = loadSample;

/** Relabel a sample (POST /api/ei/sample/{id}/rename). */
export async function renameSample(
  sampleId: number,
  newLabel: string,
): Promise<RenameResult> {
  return requestJson<RenameResult>(
    `/api/ei/sample/${encodeURIComponent(String(sampleId))}/rename`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newLabel }),
    },
  );
}

/**
 * Server-side crop of an Edge Impulse sample (POST /api/ei/sample/{id}/crop).
 * cropStart/cropEnd are INDEX-space. The route handler that backs this is owned
 * by the crop integration; this client wrapper targets the documented path.
 */
export async function cropSample(
  sampleId: number,
  cropStart: number,
  cropEnd: number,
): Promise<CropResult> {
  return requestJson<CropResult>(
    `/api/ei/sample/${encodeURIComponent(String(sampleId))}/crop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cropStart, cropEnd }),
    },
  );
}

/** URL of the original-file download proxy (GET /api/ei/sample/{id}/original). */
export function originalFileUrl(sampleId: number): string {
  return `/api/ei/sample/${encodeURIComponent(String(sampleId))}/original`;
}

// ---- payload -> Dataset conversion ----------------------------------------

/**
 * Column-extract an EI payload into Channels: channel i = values.map(r => r[i]),
 * name/units from payload.sensors[i]. Non-finite cells become 0.
 */
export function channelsFromPayload(payload: EISamplePayload): Channel[] {
  const sensors = payload.sensors ?? [];
  const rows = payload.values ?? [];
  return sensors.map((sensor, i) => {
    const values = new Array<number>(rows.length);
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r]?.[i];
      values[r] = typeof v === "number" && Number.isFinite(v) ? v : 0;
    }
    return {
      id: genId("ch"),
      name: sensor.name,
      units: sensor.units,
      values,
      color: colorForIndex(i),
      visible: true,
    } satisfies Channel;
  });
}

/**
 * Build a complete Dataset from a loaded EI sample.
 *
 * Lanes are intentionally left EMPTY so the editor store's loadDataset()
 * auto-groups the channels by magnitude on load — exactly like the CSV import
 * path. This is the whole point of the product: a 0..1000 channel and a 0..1
 * channel must NOT share one y-axis (which is the Studio behaviour we replace).
 * Returning a single populated lane here would suppress auto-grouping and
 * re-introduce the magnitude-domination problem. Full-resolution values are
 * retained for export/crop. The "all in one lane" baseline stays reachable via
 * the toolbar preset for an honest comparison.
 */
export function datasetFromSample(
  sample: EISampleMeta,
  payload: EISamplePayload,
): Dataset {
  const channels = channelsFromPayload(payload);
  const intervalMs = payload.intervalMs ?? sample.intervalMs ?? undefined;
  const frequencyHz =
    payload.frequencyHz ??
    (sample.frequency && sample.frequency > 0 ? sample.frequency : undefined);

  // Multi-label samples carry structured-label segments on the sample object;
  // normalize them against the loaded sample length so the editor can render +
  // edit them. Single-label samples leave `labels` empty.
  const length = channels.reduce((m, c) => Math.max(m, c.values.length), 0);
  const labels = normalizeLabels(sample.structuredLabels, length);

  return {
    channels,
    lanes: [],
    intervalMs,
    frequencyHz,
    source: "edge-impulse",
    name: sample.filename || sample.label || `sample-${sample.id}`,
    sampleId: sample.id,
    labels: labels.length > 0 ? labels : undefined,
  };
}

// ---- upload ---------------------------------------------------------------

export interface UploadSampleInput {
  dataset: Dataset;
  category: EICategory;
  label: string;
  /** Used for the x-file-name header / generated filename. */
  fileName?: string;
  deviceName?: string;
  deviceType?: string;
}

/**
 * Upload an edited Dataset back to Edge Impulse via the ingestion proxy
 * (POST /api/ei/upload).
 *
 * Reads FULL-resolution Channel.values (not any downsampled render copy),
 * builds the sensors + values matrix (one row per timestep), and posts. The
 * unix-seconds `iat` is computed here (client clock) and sent to the server,
 * which cannot reliably read wall-clock time.
 */
export async function uploadSample(
  input: UploadSampleInput,
): Promise<UploadResult> {
  const { dataset } = input;

  // Only visible channels are exported; order preserved.
  const channels = dataset.channels.filter((c) => c.visible);
  if (channels.length === 0) {
    throw new EIClientError("No visible channels to upload", 400);
  }

  const sensors = channels.map((c) => ({
    name: c.name,
    units: c.units && c.units.trim() ? c.units : "N/A",
  }));

  const length = channels.reduce(
    (max, c) => Math.max(max, c.values.length),
    0,
  );
  const values: number[][] = new Array(length);
  for (let r = 0; r < length; r++) {
    const row = new Array<number>(channels.length);
    for (let c = 0; c < channels.length; c++) {
      const v = channels[c].values[r];
      row[c] = typeof v === "number" && Number.isFinite(v) ? v : 0;
    }
    values[r] = row;
  }

  const intervalMs = intervalMsFor(dataset);

  // Multi-label upload: when the dataset carries structured-label segments, ship
  // them so the server routes through the multipart /files endpoint with a
  // structured_labels.labels sidecar. Normalize against the exported length so
  // the indices line up with the rows actually uploaded.
  const labels =
    dataset.labels && dataset.labels.length > 0
      ? normalizeLabels(dataset.labels, length)
      : undefined;

  const payload = {
    category: input.category,
    label: input.label,
    name: input.fileName ?? dataset.name,
    deviceName: input.deviceName,
    deviceType: input.deviceType,
    intervalMs,
    iat: Math.floor(Date.now() / 1000),
    sensors,
    values,
    labels,
  };

  return requestJson<UploadResult>("/api/ei/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Alias: descriptive name for uploadSample. */
export const uploadDataset = uploadSample;

/** Resolve a positive interval_ms from intervalMs | frequencyHz | time[] | default. */
export function intervalMsFor(dataset: Dataset): number {
  if (dataset.intervalMs && dataset.intervalMs > 0) return dataset.intervalMs;
  if (dataset.frequencyHz && dataset.frequencyHz > 0) {
    return 1000 / dataset.frequencyHz;
  }
  const t = dataset.time;
  if (t && t.length >= 2) {
    const d = t[1] - t[0];
    // Heuristic: time[] in seconds -> convert to ms; if already ms-scale keep.
    if (Number.isFinite(d) && d > 0) return d < 10 ? d * 1000 : d;
  }
  return 1; // safe positive fallback (1 ms)
}
