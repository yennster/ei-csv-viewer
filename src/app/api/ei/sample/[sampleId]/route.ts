// src/app/api/ei/sample/[sampleId]/route.ts — load one sample's full payload.
//
// GET proxy for /{projectId}/raw-data/{sampleId}. The upstream body already has
// the exact shape the client needs ({ success, sample, payload,
// totalPayloadLength }), so we STREAM it straight through instead of parsing the
// (potentially multi-megabyte) JSON into JS objects and re-serializing it. For a
// large sample that double-handling was the bulk of the request time — the work
// that pushed big samples past the platform's default function timeout.

import { NextResponse } from "next/server";
import {
  authHeaders,
  EIRequestError,
  getSession,
  studioBase,
} from "@/lib/ei-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Large samples are big JSON downloads from Studio; lift the function ceiling
// above the 10s platform default so they aren't killed mid-stream.
export const maxDuration = 60;

/** Parse and validate the sampleId path segment (positive integer). */
function parseSampleId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const id = Math.trunc(n);
  return id >= 1 ? id : null;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ sampleId: string }> },
): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Not connected to Edge Impulse" },
      { status: 401 },
    );
  }

  const { sampleId: rawId } = await ctx.params;
  const sampleId = parseSampleId(rawId);
  if (sampleId == null) {
    return NextResponse.json(
      { success: false, error: "Invalid sample id" },
      { status: 400 },
    );
  }

  const url = `${studioBase(session)}/${session.projectId}/raw-data/${sampleId}`;

  try {
    const upstream = await fetch(url, {
      headers: authHeaders(session),
      cache: "no-store",
    });

    if (!upstream.ok) {
      // Read the (small) error body so the real reason reaches the client.
      let detail = "";
      try {
        detail = (await upstream.text()).trim();
      } catch {
        detail = "";
      }
      let message = detail || `Failed to load sample (${upstream.status})`;
      try {
        const env = detail ? JSON.parse(detail) : null;
        if (env && typeof env.error === "string" && env.error) message = env.error;
      } catch {
        // keep raw text
      }
      return NextResponse.json(
        { success: false, error: message },
        { status: upstream.status },
      );
    }

    // Stream the upstream JSON body through verbatim — its shape already matches
    // the client contract ({ success, sample, payload, totalPayloadLength }), so
    // there's nothing to reshape and no reason to buffer + re-encode it.
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const status = err instanceof EIRequestError ? err.status : 502;
    const message =
      err instanceof Error ? err.message : "Failed to load sample";
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
