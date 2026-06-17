// src/app/api/ei/sample/[sampleId]/route.ts — load one sample's full payload.
//
// GET proxy for /{projectId}/raw-data/{sampleId}. Returns
// { sample, payload, totalPayloadLength } so the client can build channels
// from payload.sensors (names/units) + payload.values (one row per timestep).

import { NextResponse } from "next/server";
import type { EISampleResponse } from "@/lib/types";
import {
  EIRequestError,
  getSession,
  studioFetch,
} from "@/lib/ei-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  try {
    const body = await studioFetch<EISampleResponse>(
      session,
      `/${session.projectId}/raw-data/${sampleId}`,
    );
    return NextResponse.json({
      success: true,
      sample: body.sample,
      payload: body.payload,
      totalPayloadLength: body.totalPayloadLength,
    });
  } catch (err) {
    const status = err instanceof EIRequestError ? err.status : 502;
    const message =
      err instanceof Error ? err.message : "Failed to load sample";
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
