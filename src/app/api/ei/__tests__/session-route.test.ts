// src/app/api/ei/__tests__/session-route.test.ts
//
// Route-handler tests for POST/GET/DELETE /api/ei/session.
//
// The headline assertion: the session Set-Cookie carries HttpOnly + Secure +
// SameSite=None (plus Partitioned). This is the cross-site cookie the embedded
// Studio iframe relies on — Playwright/HTTP CI cannot exercise a real Secure;
// SameSite=None cookie over plain http, so we pin those attributes HERE at the
// route-handler level instead (documented in the e2e specs too).

// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from "vitest";

// `server-only` throws if imported into a client bundle; in tests it is a no-op.
vi.mock("server-only", () => ({}));

// A controllable in-memory cookie jar standing in for next/headers cookies().
const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

import { POST, GET, DELETE } from "@/app/api/ei/session/route";
import { SESSION_COOKIE, serializeSession } from "@/lib/ei-server";

/** Parse a single Set-Cookie header into name + a lowercased attribute set. */
function parseSetCookie(header: string): {
  name: string;
  value: string;
  attrs: Set<string>;
  raw: string;
} {
  const parts = header.split(";").map((p) => p.trim());
  const [pair, ...rest] = parts;
  const eq = pair.indexOf("=");
  return {
    name: pair.slice(0, eq),
    value: pair.slice(eq + 1),
    attrs: new Set(rest.map((a) => a.toLowerCase())),
    raw: header,
  };
}

function jsonRequest(body: unknown): Request {
  return new Request("https://app.example/api/ei/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  cookieJar.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("POST /api/ei/session — connect", () => {
  it("sets the ei_session cookie with HttpOnly + Secure + SameSite=None", async () => {
    // Studio validates the explicit project id.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, project: { id: 42, name: "Demo" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await POST(
      jsonRequest({ apiKey: "ei_demo_key", projectId: 42 }),
    );
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const parsed = parseSetCookie(setCookie as string);

    expect(parsed.name).toBe(SESSION_COOKIE);
    // The required cross-site cookie attributes.
    expect(parsed.attrs.has("httponly")).toBe(true);
    expect(parsed.attrs.has("secure")).toBe(true);
    expect(parsed.attrs.has("samesite=none")).toBe(true);
    // Path + finite lifetime + CHIPS partitioning round out the contract.
    expect(parsed.attrs.has("path=/")).toBe(true);
    expect(parsed.attrs.has("partitioned")).toBe(true);
    expect([...parsed.attrs].some((a) => a.startsWith("max-age="))).toBe(true);
  });

  it("stores the validated session (apiKey + resolved projectId) in the cookie value", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, project: { id: 7, name: "P" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await POST(jsonRequest({ apiKey: "ei_abc", projectId: 7 }));
    const parsed = parseSetCookie(res.headers.get("set-cookie") as string);

    // The cookie value is the URL-encoded JSON session.
    const decoded = JSON.parse(decodeURIComponent(parsed.value));
    expect(decoded.apiKey).toBe("ei_abc");
    expect(decoded.projectId).toBe(7);
    // Sanity: it round-trips through serializeSession's encoding.
    expect(decodeURIComponent(parsed.value)).toBe(
      serializeSession({ apiKey: "ei_abc", projectId: 7 }),
    );

    const json = (await res.json()) as { success: boolean; projectId: number };
    expect(json.success).toBe(true);
    expect(json.projectId).toBe(7);
  });

  it("auto-resolves the first project when no projectId is supplied", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          projects: [{ id: 99, name: "First" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await POST(jsonRequest({ apiKey: "ei_nokeyid" }));
    expect(res.status).toBe(200);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/projects");
    const parsed = parseSetCookie(res.headers.get("set-cookie") as string);
    const decoded = JSON.parse(decodeURIComponent(parsed.value));
    expect(decoded.projectId).toBe(99);
  });

  it("rejects a body without an ei_ API key (400, no cookie, no fetch)", async () => {
    const res = await POST(jsonRequest({ apiKey: "not-an-ei-key" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates an upstream auth failure status without setting a cookie", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await POST(jsonRequest({ apiKey: "ei_bad", projectId: 1 }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sends the x-api-key header to Studio and never leaks it in the response body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, project: { id: 3 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await POST(jsonRequest({ apiKey: "ei_secret", projectId: 3 }));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("ei_secret");

    const text = await res.text();
    expect(text).not.toContain("ei_secret");
  });
});

describe("GET /api/ei/session — status", () => {
  it("reports disconnected when no cookie is present", async () => {
    const res = await GET();
    const json = (await res.json()) as { connected: boolean };
    expect(json.connected).toBe(false);
  });

  it("reports connected WITHOUT leaking the apiKey when a session cookie exists", async () => {
    cookieJar.set(
      SESSION_COOKIE,
      serializeSession({ apiKey: "ei_live", projectId: 12 }),
    );
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain("ei_live");
    const json = JSON.parse(text) as { connected: boolean; projectId: number };
    expect(json.connected).toBe(true);
    expect(json.projectId).toBe(12);
  });
});

describe("DELETE /api/ei/session — disconnect", () => {
  it("clears the cookie with Max-Age=0 (same attributes)", async () => {
    const res = await DELETE();
    const parsed = parseSetCookie(res.headers.get("set-cookie") as string);
    expect(parsed.name).toBe(SESSION_COOKIE);
    expect(parsed.attrs.has("max-age=0")).toBe(true);
    expect(parsed.attrs.has("httponly")).toBe(true);
    expect(parsed.attrs.has("secure")).toBe(true);
    expect(parsed.attrs.has("samesite=none")).toBe(true);
  });
});
