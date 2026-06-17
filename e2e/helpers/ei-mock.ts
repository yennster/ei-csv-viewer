// e2e/helpers/ei-mock.ts
//
// Network mocking for the Edge Impulse same-origin proxy (/api/ei/*). Every E2E
// spec installs these routes so the app runs with NO real API key and NO real
// network: page.route intercepts each /api/ei/* call and fulfills a canned JSON
// response. The mocked session "connect" deliberately does NOT try to set a
// Secure; SameSite=None cookie — plain-http CI cannot persist one — so we mock
// the connection at the app layer and assert the real cookie attributes in the
// vitest route tests instead (see src/app/api/ei/__tests__/session-route.test.ts).

import type { Page, Route } from "@playwright/test";

export interface MockSample {
  id: number;
  filename: string;
  label: string;
  category: "training" | "testing" | "anomaly";
  sensors: { name: string; units?: string }[];
  frequency?: number;
}

/** Two samples with deliberately distinct magnitudes so the editor shows lanes. */
export const MOCK_SAMPLES: MockSample[] = [
  {
    id: 101,
    filename: "walk-01.csv",
    label: "walk",
    category: "training",
    sensors: [
      { name: "accX", units: "m/s2" },
      { name: "accY", units: "m/s2" },
      { name: "accZ", units: "m/s2" },
    ],
    frequency: 100,
  },
  {
    id: 202,
    filename: "run-02.csv",
    label: "run",
    category: "training",
    sensors: [
      { name: "accX", units: "m/s2" },
      { name: "accY", units: "m/s2" },
    ],
    frequency: 100,
  },
];

/** Build a payload for a sample id: a few sensors, distinct magnitudes per axis. */
export function payloadFor(sampleId: number) {
  const sample = MOCK_SAMPLES.find((s) => s.id === sampleId) ?? MOCK_SAMPLES[0];
  const sensors = sample.sensors;
  const rows: number[][] = [];
  for (let r = 0; r < 64; r++) {
    const row = sensors.map((_, axis) => {
      // Axis 0 small (~±1), axis 1 mid (~±50), axis 2 large (~±1000): distinct
      // ranges so per-lane auto-scaling is visible across the lanes.
      const scale = axis === 0 ? 1 : axis === 1 ? 50 : 1000;
      return scale * Math.sin((r / 64) * Math.PI * 2 + axis);
    });
    rows.push(row);
  }
  return {
    sensors: sensors.map((s) => ({ name: s.name, units: s.units ?? "N/A" })),
    values: rows,
    intervalMs: 10,
    frequencyHz: sample.frequency,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export interface MockOptions {
  /** Initial session status returned by GET /api/ei/session. */
  connected?: boolean;
  projectId?: number;
  projectName?: string;
  samples?: MockSample[];
}

/**
 * Install all /api/ei/* mocks on the page. Connect/disconnect mutate an
 * in-closure `connected` flag so GET status reflects a prior POST, mirroring the
 * real cookie-backed flow without any real cookie.
 */
export async function mockEdgeImpulse(
  page: Page,
  opts: MockOptions = {},
): Promise<void> {
  let connected = opts.connected ?? false;
  const projectId = opts.projectId ?? 12345;
  const projectName = opts.projectName ?? "Demo Project";
  const samples = opts.samples ?? MOCK_SAMPLES;

  await page.route("**/api/ei/session", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      connected = true;
      return json(route, {
        success: true,
        connected: true,
        projectId,
        projectName,
        studioHost: "https://studio.edgeimpulse.com/v1/api",
      });
    }
    if (method === "DELETE") {
      connected = false;
      return json(route, { success: true, connected: false });
    }
    // GET status
    return json(route, {
      success: true,
      connected,
      projectId: connected ? projectId : undefined,
      studioHost: "https://studio.edgeimpulse.com/v1/api",
    });
  });

  await page.route("**/api/ei/samples**", async (route) => {
    return json(route, {
      success: true,
      samples,
      totalCount: samples.length,
      limit: 200,
      offset: 0,
      category: "training",
    });
  });

  // GET /api/ei/sample/{id}
  await page.route(/\/api\/ei\/sample\/\d+(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/api\/ei\/sample\/(\d+)$/);
    const id = m ? Number(m[1]) : MOCK_SAMPLES[0].id;
    const sample = samples.find((s) => s.id === id) ?? samples[0];
    return json(route, {
      success: true,
      sample,
      payload: payloadFor(id),
      totalPayloadLength: 64,
    });
  });

  // Write-back proxies — succeed without touching a real backend.
  await page.route(/\/api\/ei\/sample\/\d+\/(rename|crop)$/, async (route) => {
    return json(route, { success: true });
  });
  await page.route("**/api/ei/upload", async (route) => {
    return json(route, {
      success: true,
      category: "training",
      label: "edited",
      fileName: "edited.json",
      sampleCount: 64,
      response: null,
    });
  });
}
