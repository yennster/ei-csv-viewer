// src/app/api/ei/upload/route.ts — upload an edited dataset to Edge Impulse.
//
// POST accepts an edited dataset (sensors + values + category + label + name +
// interval_ms + iat), builds the Edge Impulse ingestion JSON body
// (protected/signature/payload), and POSTs it to the Ingestion API at
// {ingestionBase}/{training|testing|anomaly}/data with the
// x-api-key / x-label / x-file-name headers. The apiKey never reaches the client.

import { NextResponse } from "next/server";
import type { EICategory, EIIngestionBody, StructuredLabel } from "@/lib/types";
import {
  EIRequestError,
  getSession,
  ingestionBase,
} from "@/lib/ei-server";
import {
  STRUCTURED_LABELS_FILENAME,
  normalizeLabels,
  serializeStructuredLabels,
  validateLabels,
} from "@/lib/labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Large datasets take time to serialize + ship to the Ingestion API. Raise the
// serverless function ceiling above the 10s platform default so a big upload
// isn't killed mid-flight.
export const maxDuration = 60;

const CATEGORIES: readonly EICategory[] = ["training", "testing", "anomaly"];

interface UploadBody {
  category?: unknown;
  label?: unknown;
  name?: unknown;
  deviceName?: unknown;
  deviceType?: unknown;
  intervalMs?: unknown;
  iat?: unknown;
  sensors?: unknown;
  values?: unknown;
  labels?: unknown;
}

interface SensorDef {
  name: string;
  units: string;
}

function parseCategory(raw: unknown): EICategory | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (CATEGORIES as readonly string[]).includes(v)
    ? (v as EICategory)
    : null;
}

function parseSensors(raw: unknown): SensorDef[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: SensorDef[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") return null;
    const obj = s as { name?: unknown; units?: unknown };
    if (typeof obj.name !== "string" || !obj.name) return null;
    out.push({
      name: obj.name,
      units: typeof obj.units === "string" && obj.units ? obj.units : "N/A",
    });
  }
  return out;
}

/** Validate the values matrix: non-empty rows, each row length === sensorCount, all finite. */
function parseValues(raw: unknown, sensorCount: number): number[][] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: number[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== sensorCount) return null;
    const r: number[] = [];
    for (const v of row) {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      r.push(v);
    }
    out.push(r);
  }
  return out;
}

/**
 * Validate optional structured-label segments. Returns null when absent.
 * Throws-by-return on malformed segments so the caller can 400. Bounds are
 * validated against the row count of the uploaded values.
 */
function parseLabels(
  raw: unknown,
  rowCount: number,
): { ok: true; labels: StructuredLabel[] } | { ok: false; error: string } | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return { ok: false, error: "labels must be an array" };
  if (raw.length === 0) return null;
  const segs: StructuredLabel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "each label must be an object" };
    }
    const o = item as { startIndex?: unknown; endIndex?: unknown; label?: unknown };
    if (
      typeof o.startIndex !== "number" ||
      !Number.isFinite(o.startIndex) ||
      typeof o.endIndex !== "number" ||
      !Number.isFinite(o.endIndex) ||
      typeof o.label !== "string" ||
      !o.label.trim()
    ) {
      return {
        ok: false,
        error: "each label needs numeric startIndex/endIndex and a non-empty label",
      };
    }
    segs.push({
      startIndex: o.startIndex,
      endIndex: o.endIndex,
      label: o.label,
    });
  }
  const normalized = normalizeLabels(segs, rowCount);
  const v = validateLabels(normalized, rowCount);
  if (!v.ok) {
    return {
      ok: false,
      error:
        "structured labels must be continuous and non-overlapping over the full sample length",
    };
  }
  return { ok: true, labels: normalized };
}

/** A safe-ish filename for the x-file-name header. */
function sanitizeFileName(name: string, fallback: string): string {
  const base = (name || fallback).trim().replace(/[^\w.\- ]+/g, "_");
  const trimmed = base.slice(0, 120) || fallback;
  return trimmed.toLowerCase().endsWith(".json") ? trimmed : `${trimmed}.json`;
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Not connected to Edge Impulse" },
      { status: 401 },
    );
  }

  let body: UploadBody;
  try {
    body = (await req.json()) as UploadBody;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const category = parseCategory(body.category) ?? "training";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    return NextResponse.json(
      { success: false, error: "A label is required" },
      { status: 400 },
    );
  }

  const sensors = parseSensors(body.sensors);
  if (!sensors) {
    return NextResponse.json(
      { success: false, error: "At least one sensor with a name is required" },
      { status: 400 },
    );
  }

  const values = parseValues(body.values, sensors.length);
  if (!values) {
    return NextResponse.json(
      {
        success: false,
        error:
          "values must be a non-empty matrix of finite numbers with one column per sensor",
      },
      { status: 400 },
    );
  }

  const intervalMs =
    typeof body.intervalMs === "number" && Number.isFinite(body.intervalMs)
      ? body.intervalMs
      : 0;
  if (!(intervalMs > 0)) {
    return NextResponse.json(
      { success: false, error: "intervalMs must be a positive number" },
      { status: 400 },
    );
  }

  // Optional time-series multi-label segments. When present they must form a
  // continuous, non-overlapping cover of the sample length (Edge Impulse's
  // structured-labels contract) and the upload routes through /files instead of
  // /data with a structured_labels.labels sidecar.
  const labelsResult = parseLabels(body.labels, values.length);
  if (labelsResult && !labelsResult.ok) {
    return NextResponse.json(
      { success: false, error: labelsResult.error },
      { status: 400 },
    );
  }
  const labels = labelsResult?.ok ? labelsResult.labels : null;

  // The client supplies iat (the protected envelope timestamp); fall back to the
  // request Date header, then to the server's own clock. Never 0/1970 — a real
  // unix-seconds timestamp is always available server-side.
  let iat: number;
  if (typeof body.iat === "number" && Number.isFinite(body.iat)) {
    iat = Math.floor(body.iat);
  } else {
    const dateHeader = req.headers.get("date");
    const fromHeader = dateHeader ? new Date(dateHeader).getTime() : NaN;
    iat = Number.isFinite(fromHeader)
      ? Math.floor(fromHeader / 1000)
      : Math.floor(Date.now() / 1000);
  }

  const deviceName =
    typeof body.deviceName === "string" && body.deviceName.trim()
      ? body.deviceName.trim()
      : "ei-csv-editor";
  const deviceType =
    typeof body.deviceType === "string" && body.deviceType.trim()
      ? body.deviceType.trim()
      : "ei-csv-editor";

  const ingestionBody: EIIngestionBody = {
    protected: { ver: "v1", alg: "none", iat },
    signature: "empty",
    payload: {
      device_name: deviceName,
      device_type: deviceType,
      interval_ms: intervalMs,
      sensors,
      values,
    },
  };

  const fileName = sanitizeFileName(
    typeof body.name === "string" ? body.name : "",
    `${label}-${Date.now()}`,
  );

  // Single-label samples post the acquisition JSON straight to /data with an
  // x-label header. Multi-label samples post a multipart form to /files: the
  // data file plus a structured_labels.labels sidecar that keys its segments by
  // the data file name. Both files use the form field name "data".
  const multiLabel = !!labels && labels.length > 0;
  const url = multiLabel
    ? `${ingestionBase(session)}/${category}/files`
    : `${ingestionBase(session)}/${category}/data`;

  try {
    let res: Response;
    if (multiLabel) {
      const form = new FormData();
      form.append(
        "data",
        new Blob([JSON.stringify(ingestionBody)], {
          type: "application/json",
        }),
        fileName,
      );
      form.append(
        "data",
        new Blob([serializeStructuredLabels(fileName, labels!)], {
          type: "application/json",
        }),
        STRUCTURED_LABELS_FILENAME,
      );
      res = await fetch(url, {
        method: "POST",
        // Do NOT set Content-Type: fetch derives the multipart boundary itself.
        headers: { "x-api-key": session.apiKey },
        body: form,
        cache: "no-store",
      });
    } else {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": session.apiKey,
          // HTTP header values are ISO-8859-1 and forbid control chars. Edge
          // Impulse labels can contain emoji / accented / CJK / newline chars,
          // which would make undici throw "invalid header value" before the
          // request is even sent. Percent-encode so any label is header-safe;
          // the ingestion API URL-decodes x-label.
          "x-label": encodeURIComponent(label),
          "x-file-name": fileName,
        },
        body: JSON.stringify(ingestionBody),
        cache: "no-store",
      });
    }

    // Ingestion responses are not always JSON; read text and try to parse.
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    const parsedObj =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const parsedError =
      parsedObj && typeof parsedObj.error === "string"
        ? (parsedObj.error as string)
        : null;

    if (!res.ok) {
      const errMsg =
        parsedError || text || `Ingestion request failed (${res.status})`;
      return NextResponse.json(
        { success: false, error: errMsg },
        { status: res.status >= 400 && res.status < 600 ? res.status : 502 },
      );
    }

    // A 200 can still carry a JSON envelope describing a logical failure; honor
    // success:false rather than reporting an upload that didn't actually land.
    if (parsedObj && parsedObj.success === false) {
      return NextResponse.json(
        { success: false, error: parsedError || "Ingestion reported a failure" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      category,
      label,
      fileName,
      sampleCount: values.length,
      labelCount: labels ? labels.length : 0,
      response: parsed ?? null,
    });
  } catch (err) {
    const status = err instanceof EIRequestError ? err.status : 502;
    const message =
      err instanceof Error ? err.message : "Failed to upload to Edge Impulse";
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
