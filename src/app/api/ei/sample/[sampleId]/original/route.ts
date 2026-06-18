// src/app/api/ei/sample/[sampleId]/original/route.ts — download original file.
//
// GET proxy for /{projectId}/raw-data/{sampleId}/raw — streams the original
// uploaded file (binary) back to the browser with its content-type intact.

import { NextResponse } from "next/server";
import {
  EIRequestError,
  getSession,
  studioMedia,
} from "@/lib/ei-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Streaming a large original file can exceed the 10s platform default.
export const maxDuration = 60;

function parseSampleId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const id = Math.trunc(n);
  return id >= 1 ? id : null;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ sampleId: string }> },
): Promise<Response> {
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
    const upstream = await studioMedia(
      session,
      `/${session.projectId}/raw-data/${sampleId}/raw`,
    );

    // Pass through body + relevant headers so the browser can save the file.
    const headers = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    const cl = upstream.headers.get("content-length");
    if (cl) headers.set("content-length", cl);
    const cd = upstream.headers.get("content-disposition");
    headers.set(
      "content-disposition",
      cd ?? `attachment; filename="sample-${sampleId}"`,
    );
    headers.set("cache-control", "no-store");

    return new Response(upstream.body, {
      status: 200,
      headers,
    });
  } catch (err) {
    const status = err instanceof EIRequestError ? err.status : 502;
    const message =
      err instanceof Error ? err.message : "Failed to download original file";
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
