"use client";

// src/components/app-header.tsx — top app chrome.
//
// Branding ("Edge Impulse CSV Editor"), a live connection status badge, and the
// theme toggle. This header is rendered ONLY in standalone mode; the embedded
// route (embed=1) strips it so the lanes fill the iframe.

import { Activity, FileText, Github, Plug, Unplug } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/store";
import { Button } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/theme";

function ConnectionBadge() {
  const connection = useEditorStore((s) => s.connection);

  const map = {
    connected: {
      label: connection.projectName
        ? `Connected · ${connection.projectName}`
        : connection.projectId
          ? `Connected · #${connection.projectId}`
          : "Connected",
      cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      icon: <Plug className="h-3.5 w-3.5" />,
    },
    connecting: {
      label: "Connecting…",
      cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      icon: <Activity className="h-3.5 w-3.5 animate-pulse" />,
    },
    error: {
      label: "Connection error",
      cls: "bg-danger/10 text-danger",
      icon: <Unplug className="h-3.5 w-3.5" />,
    },
    disconnected: {
      label: "Not connected",
      cls: "bg-surface-2 text-fg-muted",
      icon: <Unplug className="h-3.5 w-3.5" />,
    },
  } as const;

  const s = map[connection.status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        s.cls,
      )}
      title={connection.error ?? s.label}
    >
      {s.icon}
      {s.label}
    </span>
  );
}

export function AppHeader() {
  const connection = useEditorStore((s) => s.connection);
  const disconnect = useEditorStore((s) => s.disconnect);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-4">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-fg">
          <Activity className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <h1 className="text-sm font-semibold tracking-tight">
            Edge Impulse CSV Editor
          </h1>
          <p className="hidden text-[11px] text-fg-muted sm:block">
            Per-lane y-axes · one shared time axis
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <ConnectionBadge />
        {connection.status === "connected" && (
          <Button size="sm" variant="ghost" onClick={() => disconnect()}>
            Disconnect
          </Button>
        )}
        <a
          href="/url-parameters"
          target="_blank"
          rel="noreferrer noopener"
          title="URL parameters reference"
          className="hidden items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-2 hover:text-fg sm:inline-flex"
        >
          <FileText className="h-3.5 w-3.5" />
          URL params
        </a>
        <a
          href="https://github.com/yennster/ei-csv-viewer"
          target="_blank"
          rel="noreferrer noopener"
          aria-label="View source on GitHub"
          title="View source on GitHub"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          <Github className="h-4 w-4" />
        </a>
        <ThemeToggle />
      </div>
    </header>
  );
}
