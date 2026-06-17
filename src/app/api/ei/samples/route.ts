// src/app/api/ei/samples/route.ts — list raw-data samples for the project.
//
// GET proxy for /{projectId}/raw-data?category&limit&offset&labels.
// Reads the httpOnly session cookie, injects x-api-key via studioFetch, and
// returns the sample metadata list. The apiKey never reaches the client.

import { NextResponse } from "next/server";
import type { EICategory, EISampleMeta } from "@/lib/types";
import {
  EIRequestError,
  getSession,
  studioFetch,
} from "@/lib/ei-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORIES: readonly EICategory[] = ["training", "testing", "anomaly"];

interface EISamplesListResponse {
  success: boolean;
  error?: string;
  samples?: EISampleMeta[];
  totalCount?: number;
}

function parseCategory(raw: string | null): EICategory | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  return (CATEGORIES as readonly string[]).includes(v)
    ? (v as EICategory)
    : undefined;
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function GET(req: Request): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Not connected to Edge Impulse" },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const category = parseCategory(url.searchParams.get("category"));
  const limit = clampInt(url.searchParams.get("limit"), 200, 1, 1000);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  // labels: comma-separated list; pass through as a repeated query param.
  const labels = (url.searchParams.get("labels") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const qs = new URLSearchParams();
  if (category) qs.set("category", category);
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  for (const label of labels) qs.append("labels", label);

  try {
    const body = await studioFetch<EISamplesListResponse>(
      session,
      `/${session.projectId}/raw-data?${qs.toString()}`,
    );
    return NextResponse.json({
      success: true,
      samples: body.samples ?? [],
      totalCount: body.totalCount ?? body.samples?.length ?? 0,
      limit,
      offset,
      category: category ?? null,
    });
  } catch (err) {
    const status = err instanceof EIRequestError ? err.status : 502;
    const message =
      err instanceof Error ? err.message : "Failed to list samples";
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
