// src/app/api/ei/session/route.ts — connect / status / disconnect.
//
// POST   validates the apiKey by fetching project info, then sets the httpOnly
//        `ei_session` cookie (sameSite:"none", secure, path:"/").
// GET    returns connection status WITHOUT exposing the apiKey.
// DELETE clears the cookie.

import { NextResponse } from "next/server";
import type { EISession } from "@/lib/types";
import {
  SESSION_COOKIE,
  EIRequestError,
  getSession,
  normalizeHost,
  serializeSession,
  studioBase,
  studioFetch,
} from "@/lib/ei-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConnectBody {
  apiKey?: string;
  projectId?: number | string;
  studioHost?: string;
  ingestionHost?: string;
}

interface EIProjectInfoResponse {
  success: boolean;
  error?: string;
  project?: { id: number; name?: string };
}

/** One week, so the session survives reloads/navigations inside the Studio iframe. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const COOKIE_BASE = {
  httpOnly: true,
  secure: true,
  sameSite: "none" as const,
  path: "/",
  // A finite lifetime makes embedded sessions persistent (not a browser-session
  // cookie that some browsers evict between Studio navigations).
  maxAge: SESSION_MAX_AGE_SECONDS,
  // CHIPS: partition the cookie per top-level site so modern browsers keep it in
  // the cross-site Studio iframe under stricter third-party-cookie policies.
  partitioned: true,
};

export async function POST(req: Request): Promise<NextResponse> {
  let body: ConnectBody;
  try {
    body = (await req.json()) as ConnectBody;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!/^ei_/.test(apiKey)) {
    return NextResponse.json(
      { success: false, error: "An Edge Impulse API key (ei_...) is required" },
      { status: 400 },
    );
  }

  const rawProjectId =
    typeof body.projectId === "string"
      ? Number(body.projectId)
      : body.projectId;
  const projectId =
    typeof rawProjectId === "number" && Number.isFinite(rawProjectId)
      ? Math.trunc(rawProjectId)
      : undefined;

  const studioHost = normalizeHost(body.studioHost);
  const ingestionHost = normalizeHost(body.ingestionHost);

  // Build a provisional session to validate against the Studio API.
  const provisional: EISession = {
    apiKey,
    projectId: projectId ?? 0,
    studioHost,
    ingestionHost,
  };

  try {
    let resolvedProjectId = projectId;
    let projectName: string | undefined;

    if (projectId && projectId >= 1) {
      // Validate the explicit project id.
      const info = await studioFetch<EIProjectInfoResponse>(
        provisional,
        `/${projectId}/`,
      );
      resolvedProjectId = info.project?.id ?? projectId;
      projectName = info.project?.name;
    } else {
      // No project id provided — resolve it from the key's project list.
      const listed = await studioFetch<{
        success: boolean;
        projects?: { id: number; name?: string }[];
      }>(provisional, `/projects`);
      const first = listed.projects?.[0];
      if (!first) {
        return NextResponse.json(
          {
            success: false,
            error: "No Edge Impulse projects are accessible with this API key",
          },
          { status: 400 },
        );
      }
      resolvedProjectId = first.id;
      projectName = first.name;
    }

    if (!resolvedProjectId || resolvedProjectId < 1) {
      return NextResponse.json(
        { success: false, error: "Could not resolve a project id" },
        { status: 400 },
      );
    }

    const session: EISession = {
      apiKey,
      projectId: resolvedProjectId,
      studioHost,
      ingestionHost,
    };

    const res = NextResponse.json({
      success: true,
      projectId: resolvedProjectId,
      projectName,
      studioHost: studioBase(session),
    });
    res.cookies.set(SESSION_COOKIE, serializeSession(session), COOKIE_BASE);
    return res;
  } catch (err) {
    const status = err instanceof EIRequestError ? err.status : 502;
    const message =
      err instanceof Error ? err.message : "Failed to validate the API key";
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ success: true, connected: false });
  }
  // Never leak the apiKey.
  return NextResponse.json({
    success: true,
    connected: true,
    projectId: session.projectId,
    studioHost: studioBase(session),
  });
}

export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ success: true, connected: false });
  res.cookies.set(SESSION_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  return res;
}
