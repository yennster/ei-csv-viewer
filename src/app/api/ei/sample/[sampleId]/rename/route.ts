// src/app/api/ei/sample/[sampleId]/rename/route.ts — relabel a sample.
//
// POST proxy for /{projectId}/raw-data/{sampleId}/rename with body { newLabel }.

import { NextResponse } from "next/server";
import {
  EIRequestError,
  getSession,
  studioFetch,
} from "@/lib/ei-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RenameBody {
  newLabel?: unknown;
}

function parseSampleId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const id = Math.trunc(n);
  return id >= 1 ? id : null;
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

  let body: RenameBody;
  try {
    body = (await req.json()) as RenameBody;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const newLabel =
    typeof body.newLabel === "string" ? body.newLabel.trim() : "";
  if (!newLabel) {
    return NextResponse.json(
      { success: false, error: "newLabel is required" },
      { status: 400 },
    );
  }

  try {
    await studioFetch(
      session,
      `/${session.projectId}/raw-data/${sampleId}/rename`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newLabel }),
      },
    );
    return NextResponse.json({ success: true, sampleId, newLabel });
  } catch (err) {
    const status = err instanceof EIRequestError ? err.status : 502;
    const message =
      err instanceof Error ? err.message : "Failed to rename sample";
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
