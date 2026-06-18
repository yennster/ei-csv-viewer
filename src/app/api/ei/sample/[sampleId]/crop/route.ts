// src/app/api/ei/sample/[sampleId]/crop/route.ts — server-side crop.
//
// POST proxy for /{projectId}/raw-data/{sampleId}/crop with body
// { cropStart, cropEnd } in INDEX space. The browser records the crop selection
// as sample indices (even when seconds are displayed) so the Studio endpoint
// receives the indices it expects.

import { NextResponse } from "next/server";
import { EIRequestError, getSession, studioFetch } from "@/lib/ei-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cropping a large sample round-trips through Studio; lift the function ceiling
// above the 10s platform default.
export const maxDuration = 60;

interface CropBody {
  cropStart?: unknown;
  cropEnd?: unknown;
}

function parseSampleId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const id = Math.trunc(n);
  return id >= 1 ? id : null;
}

function parseIndex(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= 0 ? i : null;
}

export async function POST(
  req: Request,
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

  let body: CropBody;
  try {
    body = (await req.json()) as CropBody;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const cropStart = parseIndex(body.cropStart);
  const cropEnd = parseIndex(body.cropEnd);
  if (cropStart == null || cropEnd == null || cropEnd <= cropStart) {
    return NextResponse.json(
      {
        success: false,
        error: "cropStart and cropEnd must be non-negative indices, end > start",
      },
      { status: 400 },
    );
  }

  try {
    const res = await studioFetch<{
      success: boolean;
      sample?: unknown;
    }>(session, `/${session.projectId}/raw-data/${sampleId}/crop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cropStart, cropEnd }),
    });
    return NextResponse.json({
      success: true,
      sampleId,
      cropStart,
      cropEnd,
      sample: res.sample,
    });
  } catch (err) {
    const status = err instanceof EIRequestError ? err.status : 502;
    const message =
      err instanceof Error ? err.message : "Failed to crop sample";
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
