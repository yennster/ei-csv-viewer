"use client";

// src/components/connect-panel.tsx — the entry screen.
//
// Two ways in:
//   (a) Connect to Edge Impulse: API key (+ optional host overrides) -> POST
//       /api/ei/session via the store -> pick a sample. The project is
//       auto-detected from the (project-scoped) API key.
//   (b) Import a local CSV file straight into the editor.
//
// URL params (apiKey / category / sample) pre-fill the form and can
// auto-run: when an `apiKey` is present in the URL we connect immediately and
// then STRIP the key from the address bar with history.replaceState so it never
// lingers in the visible URL, history, or referrer.

import * as React from "react";
import { FileUp, KeyRound, Loader2 } from "lucide-react";
import type { AppParams } from "@/lib/types";
import { useEditorStore } from "@/lib/store";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";

/** Remove the apiKey from the visible URL without a navigation. */
function stripApiKeyFromUrl() {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("apiKey")) {
      url.searchParams.delete("apiKey");
      window.history.replaceState(
        window.history.state,
        "",
        url.pathname + (url.search ? url.search : "") + url.hash,
      );
    }
  } catch {
    // best-effort
  }
}

export function ConnectPanel({ params }: { params: AppParams }) {
  const connection = useEditorStore((s) => s.connection);
  const connect = useEditorStore((s) => s.connect);
  const importCsv = useEditorStore((s) => s.importCsv);
  const busy = useEditorStore((s) => s.ui.busy);

  const [apiKey, setApiKey] = React.useState(params.apiKey ?? "");
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [studioHost, setStudioHost] = React.useState(params.studioHost ?? "");
  const [ingestionHost, setIngestionHost] = React.useState(
    params.ingestionHost ?? "",
  );
  const [importError, setImportError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const autoRan = React.useRef(false);

  const connecting = connection.status === "connecting";

  const doConnect = React.useCallback(
    async (key: string) => {
      const ok = await connect({
        apiKey: key.trim(),
        // A project API key is scoped to one project, so the server resolves
        // the project from the key. No project id is sent from the client.
        studioHost: studioHost.trim() || undefined,
        ingestionHost: ingestionHost.trim() || undefined,
      });
      return ok;
    },
    [connect, studioHost, ingestionHost],
  );

  // Auto-connect once if the URL carried a valid apiKey, then strip it.
  React.useEffect(() => {
    if (autoRan.current) return;
    if (params.apiKey && connection.status === "disconnected") {
      autoRan.current = true;
      void doConnect(params.apiKey).finally(stripApiKeyFromUrl);
    } else if (params.apiKey) {
      // Key was present but we are not in a disconnected state; still strip it.
      stripApiKeyFromUrl();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.apiKey]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await doConnect(apiKey);
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file) return;
    setImportError(null);
    try {
      await importCsv(file);
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : "Could not import that file",
      );
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-accent" />
            Connect to Edge Impulse
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-3">
            <label className="grid gap-1">
              <span className="text-xs font-medium text-fg-muted">
                API key
              </span>
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="ei_..."
                autoComplete="off"
                spellCheck={false}
                aria-invalid={connection.status === "error"}
              />
            </label>

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="justify-self-start text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            >
              {showAdvanced ? "Hide" : "Show"} host overrides
            </button>

            {showAdvanced && (
              <div className="grid gap-3 rounded-md border border-border bg-surface-2/40 p-3">
                <label className="grid gap-1">
                  <span className="text-xs font-medium text-fg-muted">
                    Studio host
                  </span>
                  <Input
                    value={studioHost}
                    onChange={(e) => setStudioHost(e.target.value)}
                    placeholder="https://studio.edgeimpulse.com/v1/api"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-xs font-medium text-fg-muted">
                    Ingestion host
                  </span>
                  <Input
                    value={ingestionHost}
                    onChange={(e) => setIngestionHost(e.target.value)}
                    placeholder="https://ingestion.edgeimpulse.com/api"
                  />
                </label>
              </div>
            )}

            {connection.status === "error" && connection.error && (
              <p className="text-xs text-danger" role="alert">
                {connection.error}
              </p>
            )}

            <Button type="submit" disabled={connecting || !apiKey.trim()}>
              {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3 text-xs text-fg-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileUp className="h-4 w-4 text-accent" />
            Import a CSV file
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-xs text-fg-muted">
            The first column may be a timestamp or sample index; the remaining
            columns become channels you can drag between lanes.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={onPickFile}
          />
          <Button
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={busy === "loading"}
          >
            {busy === "loading" && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Choose CSV file
          </Button>
          {importError && (
            <p className="text-xs text-danger" role="alert">
              {importError}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
