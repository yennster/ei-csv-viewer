"use client";

// src/components/sample-sidebar.tsx — persistent left sidebar for browsing and
// switching Edge Impulse samples in place (replaces the old full-page picker).
//
// Lists samples for the connected project filtered by category / labels (with
// limit/offset paging), highlights the currently-open sample, and loads the
// chosen sample into the editor without leaving the analysis view. Auto-opening
// a `sample` URL param is handled by the Editor so it also works in embed mode.

import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  PanelLeftClose,
  RefreshCw,
} from "lucide-react";
import type { EICategory, EISampleMeta } from "@/lib/types";
import { useEditorStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

const CATEGORIES: EICategory[] = ["training", "testing", "anomaly"];

export interface SampleSidebarProps {
  defaultCategory?: EICategory;
  defaultLabels?: string[];
  limit: number;
  offset: number;
  /** Collapse the sidebar to a thin rail (omit to hide the collapse control). */
  onCollapse?: () => void;
  /** Current width in px (drag-resizable). Defaults to 256. */
  width?: number;
  /** Called as the user drags the right edge to resize (omit to disable). */
  onResize?: (width: number) => void;
}

/** Drag-resize bounds for the sidebar (px). */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 256;

export function SampleSidebar({
  defaultCategory,
  defaultLabels,
  limit,
  offset,
  onCollapse,
  width = SIDEBAR_DEFAULT_WIDTH,
  onResize,
}: SampleSidebarProps) {
  const samples = useEditorStore((s) => s.samples);
  const samplesStatus = useEditorStore((s) => s.samplesStatus);
  const fetchSamples = useEditorStore((s) => s.fetchSamples);
  const loadFromEdgeImpulse = useEditorStore((s) => s.loadFromEdgeImpulse);
  const activeSampleId = useEditorStore((s) => s.dataset?.sampleId ?? null);
  const busy = useEditorStore((s) => s.ui.busy);

  const [category, setCategory] = React.useState<EICategory>(
    defaultCategory ?? "training",
  );
  const [labels, setLabels] = React.useState(defaultLabels?.join(", ") ?? "");
  const [page, setPage] = React.useState(0);
  const [openingId, setOpeningId] = React.useState<number | null>(null);

  const pageOffset = offset + page * limit;

  const refresh = React.useCallback(() => {
    const labelList = labels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    void fetchSamples({
      category,
      labels: labelList.length ? labelList : undefined,
      limit,
      offset: pageOffset,
    });
  }, [fetchSamples, category, labels, limit, pageOffset]);

  // Fetch whenever the effective filters change.
  React.useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, limit, pageOffset]);

  const open = React.useCallback(
    async (id: number) => {
      setOpeningId(id);
      try {
        await loadFromEdgeImpulse(id);
      } finally {
        setOpeningId(null);
      }
    },
    [loadFromEdgeImpulse],
  );

  const loading = samplesStatus === "loading";

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-surface"
      style={{ width }}
    >
      <div className="flex items-center justify-between gap-1 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">Samples</span>
        <div className="flex items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            onClick={refresh}
            aria-label="Refresh samples"
            disabled={loading}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          {onCollapse && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onCollapse}
              aria-label="Collapse samples sidebar"
              title="Collapse"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-2 border-b border-border p-2">
        <Select
          value={category}
          aria-label="Category"
          onChange={(e) => {
            setPage(0);
            setCategory(e.target.value as EICategory);
          }}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Input
          value={labels}
          aria-label="Filter labels"
          onChange={(e) => setLabels(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setPage(0);
              refresh();
            }
          }}
          placeholder="filter labels…"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-sm text-fg-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : samplesStatus === "error" ? (
          <div className="px-3 py-6 text-center text-sm text-danger">
            Could not load samples. Check the project and try again.
          </div>
        ) : samples.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-fg-muted">
            No samples match these filters.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {samples.map((sample) => (
              <SampleRow
                key={sample.id}
                sample={sample}
                active={activeSampleId === sample.id}
                opening={openingId === sample.id}
                disabled={busy === "loading" && openingId !== sample.id}
                onOpen={() => open(sample.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between gap-1 border-t border-border px-2 py-1.5">
        <span className="text-[11px] text-fg-muted">offset {pageOffset}</span>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setPage((p) => p + 1)}
            disabled={samples.length < limit || loading}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {onResize ? <ResizeHandle width={width} onResize={onResize} /> : null}
    </aside>
  );
}

/** Drag handle on the sidebar's right edge to resize its width. */
function ResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize: (width: number) => void;
}) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, startW + (ev.clientX - startX)),
      );
      onResize(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const nudge = (delta: number) =>
    onResize(
      Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, width + delta),
      ),
    );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize samples sidebar"
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") nudge(-16);
        else if (e.key === "ArrowRight") nudge(16);
      }}
      className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
      style={{ touchAction: "none" }}
    />
  );
}

function SampleRow({
  sample,
  active,
  opening,
  disabled,
  onOpen,
}: {
  sample: EISampleMeta;
  active: boolean;
  opening: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const axisCount = sample.sensors?.length ?? 0;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled || opening}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left",
          "hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
          "disabled:cursor-not-allowed disabled:opacity-60",
          active && "bg-accent/10 ring-1 ring-inset ring-accent/40",
        )}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {sample.filename || `Sample ${sample.id}`}
          </span>
          <span className="block truncate text-xs text-fg-muted">
            #{sample.id} · {sample.label || "no label"} · {axisCount}{" "}
            {axisCount === 1 ? "axis" : "axes"}
            {sample.frequency ? ` · ${sample.frequency} Hz` : ""}
          </span>
        </span>
        {opening ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-fg-muted" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-fg-muted" />
        )}
      </button>
    </li>
  );
}
