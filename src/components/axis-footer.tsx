"use client";

/**
 * axis-footer.tsx — the single shared x-axis ruler.
 *
 * Every lane chart hides its own x-axis (showXAxis=false) to save vertical
 * space, so the time / sample-index scale would otherwise be invisible. This
 * footer is a thin uPlot instance with NO data series whose only job is to draw
 * the x tick labels for the shared x-window. It uses the SAME fixed 56px left
 * gutter and identical padding [8,12,8,0] as the lanes so its ticks line up
 * exactly under the lane plot rectangles, and it joins the same cursor sync
 * group so the crosshair tracks here too.
 *
 * It registers into the board's uPlot ref map (under a reserved lane id) so the
 * board's x-window fan-out drives this ruler in lock-step with the lanes.
 * Double-clicking the footer resets the shared x-window to the full extent.
 */

import * as React from "react";
import uPlot from "uplot";
import { Minus, Plus, Maximize2 } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { centeredZoom } from "@/lib/uplot-zoom";

/** Reserved id under which the footer registers in the board's uPlot map. */
export const AXIS_FOOTER_ID = "__axis_footer__";

export interface AxisFooterProps {
  /** shared x-axis array (sample index or seconds) — same array as the lanes */
  xs: number[];
  /** current shared x-window in x-domain units; null = full extent */
  xWindow: { min: number; max: number } | null;
  /** sync-group key shared by every lane so the crosshair tracks here too */
  syncKey: string;
  /** fixed y-gutter width in px (must match the lanes for tick alignment) */
  gutterPx?: number;
  /** does the x-axis represent seconds (time[]) vs a bare sample index? */
  hasTime?: boolean;
  /** register into the board's uPlot ref map (keyed by AXIS_FOOTER_ID) */
  onReady?: (u: uPlot) => void;
  /** unregister on unmount */
  onDestroy?: (u: uPlot) => void;
  /** double-click (and the Reset button) reset the shared x-window to full */
  onResetWindow?: () => void;
  /**
   * Commit a new shared x-window (the +/- buttons compute a centered window
   * from the current xWindow and call this). Wire to the same store action as
   * the chart's zoom commit (e.g. commitXWindow / setXWindow). When omitted the
   * +/- and reset controls are hidden.
   */
  onSetWindow?: (win: { min: number; max: number } | null) => void;
}

/** Read a themed color from a CSS variable, with a safe fallback. */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

const FOOTER_HEIGHT = 28;

export function AxisFooter({
  xs,
  xWindow,
  syncKey,
  gutterPx = 56,
  hasTime = false,
  onReady,
  onDestroy,
  onResetWindow,
  onSetWindow,
}: AxisFooterProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const uplotRef = React.useRef<uPlot | null>(null);
  const theme = useEditorStore((s) => s.ui.theme);
  const xWindowRef = React.useRef(xWindow);
  const xsRef = React.useRef(xs);
  const onResetRef = React.useRef(onResetWindow);
  const programmaticRef = React.useRef(false);
  xWindowRef.current = xWindow;
  xsRef.current = xs;
  onResetRef.current = onResetWindow;

  // ---- footer zoom controls: compute a centered window and commit it ----
  const zoomBy = React.useCallback(
    (direction: "in" | "out") => {
      if (!onSetWindow) return;
      onSetWindow(centeredZoom(xWindow, xs, direction));
    },
    [onSetWindow, xWindow, xs],
  );
  const isZoomed = xWindow != null;
  const showControls = !!onSetWindow || !!onResetWindow;

  // ---- create / destroy ----
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const width = el.clientWidth || 600;
    const gridColor = cssVar("--chart-grid", "#e2e8f0");
    const axisColor = cssVar("--chart-axis", "#94a3b8");
    const labelColor = cssVar("--fg-muted", "#64748b");

    const opts: uPlot.Options = {
      width,
      height: FOOTER_HEIGHT,
      scales: {
        x: {
          time: false,
          range: (): [number, number] => {
            const w = xWindowRef.current;
            const arr = xsRef.current;
            if (w) return [w.min, w.max];
            return [arr[0] ?? 0, arr[arr.length - 1] ?? 1];
          },
        },
        y: { auto: false, range: (): [number, number] => [0, 1] },
      },
      axes: [
        {
          show: true,
          stroke: labelColor,
          grid: { show: true, stroke: gridColor, width: 1 },
          ticks: { stroke: axisColor, width: 1 },
          size: 24,
        },
        // hidden y-axis, but it still reserves the SAME gutter width so the
        // footer's plot rect lines up under the lane plot rects.
        { show: false, size: gutterPx },
      ],
      padding: [0, 12, 4, 0],
      legend: { show: false },
      cursor: {
        // x ONLY in the sync scales, identical to the lanes.
        sync: { key: syncKey, setSeries: false, scales: ["x", null] },
        drag: { x: false, y: false, setScale: false },
        points: { show: false },
      },
      series: [{}],
    };

    // a single empty y series so uPlot has valid AlignedData
    const data: uPlot.AlignedData = [xs, new Array(xs.length).fill(null)];
    const u = new uPlot(opts, data, el);
    uplotRef.current = u;
    onReady?.(u);

    const onDblClick = () => onResetRef.current?.();
    u.over.addEventListener("dblclick", onDblClick);

    return () => {
      u.over.removeEventListener("dblclick", onDblClick);
      onDestroy?.(u);
      u.destroy();
      uplotRef.current = null;
    };
    // Re-init only on the structural props (sync/gutter); data + window updates
    // are handled by the effects below without a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey, gutterPx]);

  // ---- refresh x data when xs changes (length/values) ----
  React.useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    u.setData([xs, new Array(xs.length).fill(null)] as uPlot.AlignedData, false);
  }, [xs]);

  // ---- drive the shared x-window (guarded against echo) ----
  React.useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    const arr = xsRef.current;
    const min = xWindow ? xWindow.min : (arr[0] ?? 0);
    const max = xWindow ? xWindow.max : (arr[arr.length - 1] ?? 1);
    programmaticRef.current = true;
    try {
      u.setScale("x", { min, max });
    } finally {
      programmaticRef.current = false;
    }
  }, [xWindow]);

  // ---- refresh axis/grid colors on theme change (no re-init) ----
  React.useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    const gridColor = cssVar("--chart-grid", "#e2e8f0");
    const axisColor = cssVar("--chart-axis", "#94a3b8");
    const labelColor = cssVar("--fg-muted", "#64748b");
    for (const ax of u.axes) {
      // Wrap colors in functions — uPlot calls axis.stroke/grid.stroke/
      // ticks.stroke as functions on every redraw; a raw string throws and
      // blanks the chart on the next redraw (see uplot-chart.tsx).
      (ax as { stroke?: unknown }).stroke = () => labelColor;
      if (ax.grid) (ax.grid as { stroke?: unknown }).stroke = () => gridColor;
      if (ax.ticks) (ax.ticks as { stroke?: unknown }).stroke = () => axisColor;
    }
    u.redraw();
  }, [theme]);

  // ---- ResizeObserver: keep width in sync with the container ----
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const u = uplotRef.current;
      if (!u) return;
      const w = el.clientWidth;
      if (w > 0 && w !== u.width) u.setSize({ width: w, height: FOOTER_HEIGHT });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="sticky bottom-0 z-10 border-t border-border bg-surface">
      <div className="px-0 pb-0.5 pt-0.5">
        <div className="mb-0.5 flex items-center gap-2 pl-1 pr-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-fg-muted">
            {hasTime ? "Time (s)" : "Sample index"}
          </span>
          {showControls ? (
            <div className="ml-auto flex items-center gap-0.5">
              {onSetWindow ? (
                <>
                  <ZoomButton
                    label="Zoom out"
                    onClick={() => zoomBy("out")}
                    disabled={!isZoomed}
                  >
                    <Minus className="h-3 w-3" aria-hidden />
                  </ZoomButton>
                  <ZoomButton label="Zoom in" onClick={() => zoomBy("in")}>
                    <Plus className="h-3 w-3" aria-hidden />
                  </ZoomButton>
                </>
              ) : null}
              {onResetWindow ? (
                <ZoomButton
                  label="Reset zoom"
                  onClick={() => onResetRef.current?.()}
                  disabled={!isZoomed}
                >
                  <Maximize2 className="h-3 w-3" aria-hidden />
                </ZoomButton>
              ) : null}
            </div>
          ) : null}
        </div>
        <div ref={containerRef} className="w-full" style={{ height: FOOTER_HEIGHT }} />
      </div>
    </div>
  );
}

/** Compact icon button used by the footer zoom controls. */
function ZoomButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-border hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
