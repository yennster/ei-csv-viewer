// src/app/api/ei/__tests__/samples-route.test.ts
//
// Route-handler tests for the read proxies:
//   GET /api/ei/samples            (raw-data list)
//   GET /api/ei/sample/[sampleId]  (one sample's payload)
//
// These assert the proxy injects x-api-key, targets the project-scoped Studio
// path, clamps paging, and never leaks the apiKey to the browser.

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

import { GET as listSamples } from "@/app/api/ei/samples/route";
import { GET as getSample } from "@/app/api/ei/sample/[sampleId]/route";
import { SESSION_COOKIE, serializeSession } from "@/lib/ei-server";

const fetchMock = vi.fn();

beforeEach(() => {
  cookieJar.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function connect(projectId = 5) {
  cookieJar.set(
    SESSION_COOKIE,
    serializeSession({ apiKey: "ei_listkey", projectId }),
  );
}

function studioJson(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("GET /api/ei/samples", () => {
  it("401s when not connected", async () => {
    const res = await listSamples(
      new Request("https://app.example/api/ei/samples"),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies to /{projectId}/raw-data with x-api-key and the clamped paging", async () => {
    connect(5);
    studioJson({ success: true, samples: [{ id: 1 }], totalCount: 1 });

    const res = await listSamples(
      new Request(
        "https://app.example/api/ei/samples?category=training&limit=50&offset=10&labels=a,b",
      ),
    );
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/5/raw-data");
    expect(url).toContain("category=training");
    expect(url).toContain("limit=50");
    expect(url).toContain("offset=10");
    expect(url).toContain("labels=a");
    expect(url).toContain("labels=b");

    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("ei_listkey");

    const json = (await res.json()) as { samples: { id: number }[] };
    expect(json.samples).toEqual([{ id: 1 }]);
  });

  it("clamps an over-large limit down to the 1000 ceiling", async () => {
    connect();
    studioJson({ success: true, samples: [] });
    await listSamples(
      new Request("https://app.example/api/ei/samples?limit=999999"),
    );
    expect(fetchMock.mock.calls[0][0]).toContain("limit=1000");
  });

  it("never leaks the apiKey in the response body", async () => {
    connect();
    studioJson({ success: true, samples: [{ id: 1 }] });
    const res = await listSamples(
      new Request("https://app.example/api/ei/samples"),
    );
    const text = await res.text();
    expect(text).not.toContain("ei_listkey");
  });
});

describe("GET /api/ei/sample/[sampleId]", () => {
  it("proxies to /{projectId}/raw-data/{id} and returns the payload", async () => {
    connect(7);
    studioJson({
      success: true,
      sample: { id: 3, filename: "s.csv", label: "wave", category: "training", sensors: [] },
      payload: { sensors: [{ name: "accX" }], values: [[1], [2]] },
      totalPayloadLength: 2,
    });

    const res = await getSample(
      new Request("https://app.example/api/ei/sample/3"),
      { params: Promise.resolve({ sampleId: "3" }) },
    );
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain("/7/raw-data/3");
    const json = (await res.json()) as {
      payload: { values: number[][] };
    };
    expect(json.payload.values).toEqual([[1], [2]]);
  });

  it("rejects a non-positive sample id (400) without calling Studio", async () => {
    connect();
    const res = await getSample(
      new Request("https://app.example/api/ei/sample/0"),
      { params: Promise.resolve({ sampleId: "0" }) },
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401s when not connected", async () => {
    const res = await getSample(
      new Request("https://app.example/api/ei/sample/3"),
      { params: Promise.resolve({ sampleId: "3" }) },
    );
    expect(res.status).toBe(401);
  });
});
