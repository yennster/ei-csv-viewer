"use client";

// src/components/app-root.tsx — the client bootstrap + top-level router.
//
// Parses the effective URL params ONCE (merging any inherited iframe params),
// seeds theme + embed flags, hydrates the EI session status, and then switches
// between the connect panel and the editor based on store state. Both the
// standalone (`/`) and embedded (`/embed`) routes render this; `embed` strips
// the app header chrome.

import * as React from "react";
import type { AppParams } from "@/lib/types";
import { parseCurrentParams } from "@/lib/url-params";
import { useEditorStore } from "@/lib/store";
import { ThemeProvider, resolveInitialTheme } from "@/components/theme";
import { AppHeader } from "@/components/app-header";
import { ConnectPanel } from "@/components/connect-panel";
import { Editor } from "@/components/editor";
import Link from "next/link";
import { FileText, Github } from "lucide-react";

/** Public source repository for this project. */
export const REPO_URL = "https://github.com/yennster/ei-csv-viewer";

export function AppRoot({ embed }: { embed: boolean }) {
  // Parse params exactly once. parseCurrentParams never throws and returns
  // defaults on the server, so this is stable across renders.
  const [params] = React.useState<AppParams>(() => parseCurrentParams());

  const setEmbed = useEditorStore((s) => s.setEmbed);
  const setMode = useEditorStore((s) => s.setMode);
  const hydrateConnection = useEditorStore((s) => s.hydrateConnection);
  const dataset = useEditorStore((s) => s.dataset);
  const connected = useEditorStore((s) => s.connection.status === "connected");

  // The route can force embed; otherwise honour the URL param.
  const effectiveEmbed = embed || params.embed;
  const initialTheme = React.useMemo(
    () => resolveInitialTheme(params.theme),
    [params.theme],
  );

  React.useEffect(() => {
    setEmbed(effectiveEmbed);
    setMode(params.mode);
    void hydrateConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveEmbed, params.mode]);

  return (
    <ThemeProvider
      initialTheme={initialTheme}
      followSystem={false}
    >
      <div className="flex h-dvh min-h-0 flex-col bg-bg text-fg">
        {!effectiveEmbed && <AppHeader />}
        {connected || dataset ? (
          <Editor params={params} />
        ) : (
          <main className="min-h-0 flex-1 overflow-auto p-4 sm:p-8">
            <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6">
              {!effectiveEmbed && (
                <div className="flex flex-col items-center text-center">
                  <LanesPreview />
                  <h2 className="mt-6 text-2xl font-semibold tracking-tight text-fg">
                    Auto-scaled lanes for time-series data
                  </h2>
                  <ul className="mt-5 flex flex-wrap items-center justify-center gap-2">
                    {[
                      "Drag to regroup",
                      "Formula engine",
                      "Crop & trim",
                      "Export CSV",
                      "Edge Impulse round-trip",
                    ].map((feature) => (
                      <li
                        key={feature}
                        className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-fg-muted"
                      >
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-6 flex items-center gap-3 text-xs text-fg-muted">
                    <Link
                      href="/url-parameters"
                      className="inline-flex items-center gap-1.5 transition-colors hover:text-fg"
                    >
                      <FileText className="h-3.5 w-3.5" aria-hidden />
                      URL parameters
                    </Link>
                    <span className="h-3 w-px bg-border" aria-hidden />
                    <a
                      href={REPO_URL}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 transition-colors hover:text-fg"
                    >
                      <Github className="h-3.5 w-3.5" aria-hidden />
                      GitHub
                    </a>
                  </div>
                </div>
              )}
              <ConnectPanel params={params} />
            </div>
          </main>
        )}
      </div>
    </ThemeProvider>
  );
}

// ---------------------------------------------------------------------------
// Landing glyph — three auto-scaled channel lanes sharing one synchronized
// cursor, drawn in the editor's real channel colors. An honest little preview
// of the core idea rather than decoration.
// ---------------------------------------------------------------------------

const LANE_A =
  "M10 18 L38 10 L66 24 L94 8 L122 20 L150 14 L178 12 L206 26 L234 10 L262 22 L290 16";
const LANE_B =
  "M10 54 L38 46 L66 60 L94 50 L122 64 L150 48 L178 56 L206 44 L234 62 L262 50 L290 58";
const LANE_C =
  "M10 90 L38 96 L66 82 L94 98 L122 84 L150 100 L178 88 L206 80 L234 96 L262 84 L290 92";

function LanesPreview() {
  const cursorX = 178;
  const lines: { d: string; color: string; cy: number }[] = [
    { d: LANE_A, color: "#3b82f6", cy: 12 },
    { d: LANE_B, color: "#ef4444", cy: 56 },
    { d: LANE_C, color: "#22c55e", cy: 88 },
  ];
  return (
    <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-3 shadow-sm">
      <svg
        viewBox="0 0 300 108"
        className="h-auto w-full"
        fill="none"
        role="img"
        aria-label="Three channel lanes, each auto-scaled, sharing one synchronized cursor"
      >
        {[36, 72].map((y) => (
          <line
            key={y}
            x1="0"
            y1={y}
            x2="300"
            y2={y}
            stroke="var(--border)"
            strokeWidth="1"
          />
        ))}
        <line
          x1={cursorX}
          y1="0"
          x2={cursorX}
          y2="108"
          stroke="var(--fg-muted)"
          strokeOpacity="0.35"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
        {lines.map((l) => (
          <path
            key={l.color}
            d={l.d}
            stroke={l.color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {lines.map((l) => (
          <circle key={l.color} cx={cursorX} cy={l.cy} r="2.5" fill={l.color} />
        ))}
      </svg>
    </div>
  );
}
