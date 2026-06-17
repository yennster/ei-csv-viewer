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
      followSystem={!params.theme}
    >
      <div className="flex h-dvh min-h-0 flex-col bg-bg text-fg">
        {!effectiveEmbed && <AppHeader />}
        {connected || dataset ? (
          <Editor params={params} />
        ) : (
          <main className="min-h-0 flex-1 overflow-auto p-4 sm:p-8">
            <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6">
              {!effectiveEmbed && (
                <div className="text-center">
                  <h2 className="text-xl font-semibold tracking-tight">
                    See every channel, not just the loudest
                  </h2>
                  <p className="mt-2 text-sm text-fg-muted">
                    In Studio, the biggest signal flattens the rest. Here each
                    channel gets its own auto-scaled lane on a shared timeline —
                    so a 0–1000 axis and a 0–1 axis are both readable. Drag
                    channels between lanes to compare them.
                  </p>
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
