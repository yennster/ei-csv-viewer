// src/app/api/ei/__tests__/upload-route.test.ts
//
// Route-handler tests for POST /api/ei/upload — the ingestion proxy.
//
// The headline assertion: the body POSTed to the Edge Impulse Ingestion API is a
// well-formed ingestion envelope — protected{ver,alg,iat} + signature + payload
// with interval_ms (NOT intervalMs), the sensors list, and the per-timestep
// values matrix — and the request carries x-api-key + x-label + x-file-name
// while the apiKey never appears in the response sent back to the browser.

// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

import { POST } from "@/app/api/ei/upload/route";
import { SESSION_COOKIE, serializeSession } from "@/lib/ei-server";
import type { EIIngestionBody } from "@/lib/types";

const fetchMock = vi.fn();

beforeEach(() => {
  cookieJar.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function connect() {
  cookieJar.set(
    SESSION_COOKIE,
    serializeSession({ apiKey: "ei_upkey", projectId: 5 }),
  );
}

function uploadRequest(body: unknown): Request {
  return new Request("https://app.example/api/ei/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  category: "training",
  label: "wave",
  name: "edited.json",
  intervalMs: 10,
  iat: 1_700_000_000,
  sensors: [
    { name: "accX", units: "m/s2" },
    { name: "accY", units: "m/s2" },
  ],
  values: [
    [0.1, 0.2],
    [0.3, 0.4],
    [0.5, 0.6],
  ],
};

function ingestionOk() {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("POST /api/ei/upload — ingestion body", () => {
  it("builds interval_ms + sensors + values in the protected/signature/payload envelope", async () => {
    connect();
    ingestionOk();

    const res = await POST(uploadRequest(VALID_BODY));
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://ingestion.edgeimpulse.com/api/training/data",
    );

    const sent = JSON.parse(init.body as string) as EIIngestionBody;
    // Envelope shape.
    expect(sent.protected).toEqual({ ver: "v1", alg: "none", iat: 1_700_000_000 });
    expect(sent.signature).toBe("empty");
    // interval_ms is snake_case in the EI body (NOT intervalMs).
    expect(sent.payload.interval_ms).toBe(10);
    expect("intervalMs" in sent.payload).toBe(false);
    // Sensors + per-timestep values pass through intact.
    expect(sent.payload.sensors).toEqual([
      { name: "accX", units: "m/s2" },
      { name: "accY", units: "m/s2" },
    ]);
    expect(sent.payload.values).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
      [0.5, 0.6],
    ]);
  });

  it("sends x-api-key, url-encoded x-label, and a .json x-file-name", async () => {
    connect();
    ingestionOk();

    await POST(
      uploadRequest({ ...VALID_BODY, label: "café ☕", name: "my sample" }),
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("ei_upkey");
    // Labels can contain non-latin chars; they are percent-encoded for the header.
    expect(headers.get("x-label")).toBe(encodeURIComponent("café ☕"));
    expect(headers.get("x-file-name")).toMatch(/\.json$/);
  });

  it("targets the chosen category endpoint (anomaly)", async () => {
    connect();
    ingestionOk();
    await POST(uploadRequest({ ...VALID_BODY, category: "anomaly" }));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://ingestion.edgeimpulse.com/api/anomaly/data",
    );
  });

  it("defaults a positive device_name/device_type and reports sampleCount", async () => {
    connect();
    ingestionOk();
    const res = await POST(uploadRequest(VALID_BODY));
    const sent = JSON.parse(
      fetchMock.mock.calls[0][1].body as string,
    ) as EIIngestionBody;
    expect(sent.payload.device_name).toBeTruthy();
    expect(sent.payload.device_type).toBeTruthy();
    const json = (await res.json()) as { sampleCount: number };
    expect(json.sampleCount).toBe(3);
  });

  it("never returns the apiKey to the browser", async () => {
    connect();
    ingestionOk();
    const res = await POST(uploadRequest(VALID_BODY));
    const text = await res.text();
    expect(text).not.toContain("ei_upkey");
  });

  it("rejects when not connected (401, no upstream fetch)", async () => {
    // no cookie set
    const res = await POST(uploadRequest(VALID_BODY));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing label (400)", async () => {
    connect();
    const res = await POST(uploadRequest({ ...VALID_BODY, label: "" }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-positive interval_ms (400)", async () => {
    connect();
    const res = await POST(uploadRequest({ ...VALID_BODY, intervalMs: 0 }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a ragged values matrix that does not match the sensor count (400)", async () => {
    connect();
    const res = await POST(
      uploadRequest({ ...VALID_BODY, values: [[1, 2], [3]] }),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes multi-label uploads to /files as multipart with a structured_labels.labels sidecar", async () => {
    connect();
    ingestionOk();

    const res = await POST(
      uploadRequest({
        ...VALID_BODY,
        labels: [
          { startIndex: 0, endIndex: 1, label: "a" },
          { startIndex: 2, endIndex: 2, label: "b" },
        ],
      }),
    );
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Multi-label posts to the /files endpoint, not /data.
    expect(url).toBe("https://ingestion.edgeimpulse.com/api/training/files");

    // Body is multipart FormData with TWO "data" parts (the data file + the
    // structured_labels.labels sidecar). fetch derives the boundary, so no
    // explicit Content-Type header is set.
    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("x-api-key")).toBe("ei_upkey");

    const parts = body.getAll("data");
    expect(parts).toHaveLength(2);
    const names = parts.map((p) => (p as File).name);
    expect(names).toContain("structured_labels.labels");

    const sidecar = parts.find(
      (p) => (p as File).name === "structured_labels.labels",
    ) as File;
    const sidecarJson = JSON.parse(await sidecar.text());
    expect(sidecarJson.type).toBe("structured-labels");
    expect(sidecarJson.version).toBe(1);
    // The labels are keyed by the data file name.
    const dataName = names.find((n) => n !== "structured_labels.labels")!;
    expect(sidecarJson.structuredLabels[dataName]).toEqual([
      { startIndex: 0, endIndex: 1, label: "a" },
      { startIndex: 2, endIndex: 2, label: "b" },
    ]);

    const json = (await res.json()) as { labelCount: number };
    expect(json.labelCount).toBe(2);
  });

  it("rejects multi-label uploads whose segments are not continuous over the full length (400)", async () => {
    connect();
    // Gap at index 1 (length 3): not a full continuous cover -> rejected.
    const res = await POST(
      uploadRequest({
        ...VALID_BODY,
        labels: [{ startIndex: 0, endIndex: 0, label: "a" }],
      }),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a logical success:false from a 200 ingestion response as an error", async () => {
    connect();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: "quota" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await POST(uploadRequest(VALID_BODY));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain("quota");
  });
});
