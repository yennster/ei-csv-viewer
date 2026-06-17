"use client";

// src/components/editor.tsx — the main editor screen.
//
// Layout: a slim "dataset toolbar" (export CSV, upload to EI, close) on top, and
// the lane board (feat:lane-board) filling the rest. The lane board owns the DnD
// context, the per-lane uPlot charts (independent y-axes + one shared x-axis and
// synchronized cursor), the lane preset/add-lane/crop toolbar, the Unassigned
// channel tray, and the "+ new lane" dropzone — all driven from the store.
//
// In embedded mode (embed=1) the app header is stripped by the route and the
// lane board hides its own toolbar; here we keep a minimal export/upload bar so
// the core operations remain reachable inside the iframe.

import * as React from "react";
import {
  Download,
  Eye,
  FunctionSquare,
  ListTree,
  PanelLeftOpen,
  Upload,
} from "lucide-react";
import type { AppParams, EICategory } from "@/lib/types";
import { useEditorStore } from "@/lib/store";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Dialog } from "@/components/ui/Dialog";
// feat:lane-board: self-contained board (reads the store directly).
import { LaneBoard } from "@/components/lane-board";
import {
  SampleSidebar,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from "@/components/sample-sidebar";
import { FormulaPanel } from "@/components/formula-panel";

// ---------------------------------------------------------------------------
// Upload-to-Edge-Impulse dialog
// ---------------------------------------------------------------------------

function UploadDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dataset = useEditorStore((s) => s.dataset);
  const uploadToEdgeImpulse = useEditorStore((s) => s.uploadToEdgeImpulse);
  const busy = useEditorStore((s) => s.ui.busy);
  const message = useEditorStore((s) => s.ui.message);

  const [label, setLabel] = React.useState("");
  const [category, setCategory] = React.useState<EICategory>("training");
  const [fileName, setFileName] = React.useState("");

  React.useEffect(() => {
    if (open && dataset) {
      setFileName(dataset.name || "edited");
      setLabel((prev) => prev || dataset.name?.split(".")[0] || "edited");
    }
  }, [open, dataset]);

  async function submit() {
    const ok = await uploadToEdgeImpulse({
      label: label.trim() || "edited",
      category,
      fileName: fileName.trim() || undefined,
    });
    if (ok) onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title="Upload to Edge Impulse">
      <div className="grid gap-3">
        <label className="grid gap-1">
          <span className="text-xs font-medium text-fg-muted">Label</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="grid gap-1">
          <span className="text-xs font-medium text-fg-muted">Category</span>
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as EICategory)}
          >
            <option value="training">training</option>
            <option value="testing">testing</option>
            <option value="anomaly">anomaly</option>
          </Select>
        </label>
        <label className="grid gap-1">
          <span className="text-xs font-medium text-fg-muted">File name</span>
          <Input
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
          />
        </label>
        {message && busy === "error" && (
          <p className="text-xs text-danger" role="alert">
            {message}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy === "saving"}>
            {busy === "saving" ? "Uploading…" : "Upload"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dataset toolbar (export / upload / close)
// ---------------------------------------------------------------------------

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function DatasetToolbar({ embed }: { embed: boolean }) {
  const dataset = useEditorStore((s) => s.dataset);
  const exportCsv = useEditorStore((s) => s.exportCsv);
  const connected = useEditorStore((s) => s.connection.status === "connected");
  const resetDataset = useEditorStore((s) => s.resetDataset);
  const readOnly = useEditorStore((s) => s.ui.mode === "viewer");

  const [uploadOpen, setUploadOpen] = React.useState(false);

  function onExport() {
    const csv = exportCsv();
    if (csv == null) return;
    const base = (dataset?.name || "edited").replace(/\.csv$/i, "");
    downloadText(`${base}.csv`, csv);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
      {dataset && (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          <ListTree className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{dataset.name}</span>
          {dataset.source === "edge-impulse" && dataset.sampleId != null && (
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5">
              EI #{dataset.sampleId}
            </span>
          )}
        </span>
      )}

      {readOnly && (
        <span
          className="flex shrink-0 items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-fg-muted"
          title="Viewer mode — data-mutating actions are hidden"
        >
          <Eye className="h-3 w-3" aria-hidden />
          Read-only
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* Export is a non-destructive read of the current view; always shown. */}
        <Button size="sm" variant="outline" onClick={onExport}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
        {/* Upload writes back to Edge Impulse — hidden in read-only viewer mode. */}
        {!readOnly && (
          <Button
            size="sm"
            onClick={() => setUploadOpen(true)}
            disabled={!connected}
            title={
              connected
                ? "Upload the edited dataset as a new Edge Impulse sample"
                : "Connect to Edge Impulse to upload"
            }
          >
            <Upload className="h-4 w-4" /> Upload
          </Button>
        )}
        {!embed && (
          <Button size="sm" variant="ghost" onClick={resetDataset}>
            Close
          </Button>
        )}
      </div>

      {!readOnly && (
        <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor screen
// ---------------------------------------------------------------------------

export function Editor({ params }: { params?: AppParams }) {
  const dataset = useEditorStore((s) => s.dataset);
  const embed = useEditorStore((s) => s.ui.embed);
  const connected = useEditorStore((s) => s.connection.status === "connected");
  const loadFromEdgeImpulse = useEditorStore((s) => s.loadFromEdgeImpulse);

  // Auto-open a deep-linked ?sample= once connected. Lives here (not in the
  // sidebar) so it also fires in embed mode, where the sidebar is hidden.
  const autoOpened = React.useRef(false);
  React.useEffect(() => {
    if (autoOpened.current) return;
    if (connected && params?.sample != null && !dataset) {
      autoOpened.current = true;
      void loadFromEdgeImpulse(params.sample);
    }
  }, [connected, params?.sample, dataset, loadFromEdgeImpulse]);

  // Browse + switch samples from a persistent sidebar whenever connected to
  // Edge Impulse (hidden in embed mode, where the view is deep-linked). The
  // sidebar is collapsible to a thin rail to reclaim width for the charts.
  const showSidebar = connected && !embed;
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  // Drag-resizable width, persisted across reloads.
  const [sidebarWidth, setSidebarWidth] = React.useState(SIDEBAR_DEFAULT_WIDTH);
  React.useEffect(() => {
    const saved = Number(
      typeof window !== "undefined"
        ? window.localStorage.getItem("ei-sidebar-width")
        : NaN,
    );
    if (saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH) {
      setSidebarWidth(saved);
    }
  }, []);
  const handleSidebarResize = React.useCallback((w: number) => {
    setSidebarWidth(w);
    try {
      window.localStorage.setItem("ei-sidebar-width", String(w));
    } catch {
      /* private mode / quota — width just isn't persisted */
    }
  }, []);

  // Connected with no sample yet still renders the editor shell (+ sidebar);
  // a locally-imported CSV renders without the EI sidebar.
  if (!dataset && !connected) return null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      {showSidebar &&
        (sidebarOpen ? (
          <SampleSidebar
            defaultCategory={params?.category}
            defaultLabels={params?.labels}
            limit={params?.limit ?? 200}
            offset={params?.offset ?? 0}
            onCollapse={() => setSidebarOpen(false)}
            width={sidebarWidth}
            onResize={handleSidebarResize}
          />
        ) : (
          <div className="flex h-full w-10 shrink-0 flex-col items-center border-r border-border bg-surface py-2">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setSidebarOpen(true)}
              aria-label="Show samples sidebar"
              title="Show samples"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          </div>
        ))}
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {dataset && <DatasetToolbar embed={embed} />}
        {/* Formula engine: derive + filter are non-destructive analysis, so it
            is available in BOTH editor and viewer mode. */}
        {dataset && <FormulaBar />}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {dataset ? <LaneBoard embed={embed} /> : <EmptyState />}
        </div>
      </div>
    </div>
  );
}

/** Collapsible host for the formula authoring panel (derive + filter). */
function FormulaBar() {
  const [open, setOpen] = React.useState(false);
  const activeFilter = useEditorStore((s) => s.ui.filter);
  return (
    <div className="border-b border-border bg-surface">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-fg hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <FunctionSquare className="h-4 w-4 text-fg-muted" aria-hidden />
          Formula
          <span className="text-fg-muted">{open ? "▾" : "▸"}</span>
        </button>
        {!open && activeFilter ? (
          <span className="text-[11px] text-fg-muted">
            filter active —{" "}
            <span className="font-mono text-fg">{activeFilter.expr}</span> (
            {activeFilter.count}/{activeFilter.total})
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="px-3 pb-3">
          <FormulaPanel />
        </div>
      ) : null}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <p className="max-w-xs text-sm text-fg-muted">
        Pick a sample from the sidebar to open it in the editor.
      </p>
    </div>
  );
}
