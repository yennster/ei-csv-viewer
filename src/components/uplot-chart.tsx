"use client";

/**
 * uplot-chart.tsx — a thin, typed React wrapper around uPlot.
 *
 * Responsibilities (and ONLY these):
 *  - create a uPlot instance on mount, destroy it on unmount
 *  - update data / size when the relevant props change (no full re-init unless
 *    the series identity changes — that decision lives in the parent <Lane>)
 *  - register into a shared cursor sync group via `cursor.sync.key` so the
 *    crosshair tracks across every lane (x ONLY — never y)
 *  - downsample large series via @/lib/timeseries before drawing
 *  - resize itself to its container (ResizeObserver)
 *
 * It is deliberately dnd-agnostic: the parent makes the wrapper a droppable.
 */

import * as React from "react";
import uPlot from "uplot";
import { downsample } from "@/lib/timeseries";
import { formatTick } from "./lane-format";
import { useEditorStore } from "@/lib/store";
import { attachZoomController, type ZoomController } from "@/lib/uplot-zoom";

/** A single drawable series handed to the chart (already filtered to visible). */
export interface UplotSeriesSpec {
  /** stable channel id (used for the series-identity signature) */
  id: string;
  label: string;
  /** css hex color, resolved from the channel */
  color: string;
  /** FULL-resolution values; the chart downsamples for drawing only */
  values: number[];
}

/** Range function compatible with uPlot's scale.range callback. */
export type RangeFn = (
  self: uPlot,
  initMin: number,
  initMax: number,
) => [number, number];

export interface UplotChartProps {
  /** shared x-axis array (sample index or seconds). Same array for every lane. */
  xs: number[];
  /** visible series for this lane, in stable order */
  series: UplotSeriesSpec[];
  /** sync-group key shared by every lane so the crosshair is synchronized */
  syncKey: string;
  /** current shared x-window in x-domain units; null = full extent */
  xWindow: { min: number; max: number } | null;
  /** y-scale: auto (range computed from visible/in-window envelope) or manual */
  yRange: RangeFn;
  /** show the x-axis on this chart (false for lanes; the footer owns the ruler) */
  showXAxis?: boolean;
  /** fixed y-gutter width in px so every lane's plot rect is pixel-aligned */
  gutterPx?: number;
  /** chart height in px (width comes from the container) */
  height: number;
  /** when true, drag selects a crop band instead of zooming */
  cropMode?: boolean;
  /** current crop selection (sample indices) to paint as a translucent band */
  cropSel?: { startIdx: number; endIdx: number } | null;
  /**
   * Active formula filter mask (length-N). When present, the non-matching
   * sample ranges are shaded so the matching regions stand out. Non-destructive:
   * the data is untouched; this is purely a visual overlay.
   */
  filterMask?: boolean[] | null;
  /** max points drawn per series (defaults to ~2x typical plot width) */
  maxRenderPoints?: number;
  /** called once the uPlot instance is ready (parent keeps a ref map) */
  onReady?: (u: uPlot) => void;
  /** called right before the instance is destroyed */
  onDestroy?: (u: uPlot) => void;
  /** drag-zoom finished: emits the new x-window (domain units) or null to reset */
  onZoom?: (window: { min: number; max: number } | null) => void;
  /** crop selection finished: emits start/end sample indices */
  onCrop?: (sel: { startIdx: number; endIdx: number } | null) => void;
  /** cursor moved: emits the hovered sample index (or null off-plot) */
  onCursor?: (idx: number | null) => void;
  /**
   * Every sibling lane uPlot instance (incl. the AxisFooter) for in-canvas
   * lockstep x broadcast WITHOUT a React commit. Passed as a getter so the set
   * stays fresh as lanes mount/unmount. When omitted, wheel/pan zoom is
   * effectively single-instance (still functional, just unsynced).
   */
  getSyncTargets?: () => uPlot[];
  /**
   * Read the LIVE gesture x-window (board-level ref) so this lane's y range fn
   * re-fits to the SAME window every sibling is showing during a gesture. When
   * it returns null (no active gesture) the lane falls back to the committed
   * `xWindow`. Without this, sibling y-axes would re-fit to a stale per-instance
   * window until the gesture settles.
   */
  getLiveWindow?: () => { min: number; max: number } | null;
  /**
   * Publish the live gesture x-window to the board (the companion of
   * getLiveWindow). The zoom controller calls this on every rAF step and clears
   * it (null) on settle.
   */
  setLiveWindow?: (win: { min: number; max: number } | null) => void;
  /**
   * Called on gesture SETTLE (debounced wheel / mouseup pan) with the final
   * x-window or null (full extent). This is the ONLY React commit of a gesture.
   * The board wires this to the same store action as onZoom (e.g. commitXWindow).
   */
  onZoomCommit?: (window: { min: number; max: number } | null) => void;
  /** wheel zoom multiplier per notch (smaller = more aggressive). default 0.75 */
  wheelZoomFactor?: number;
  /** trailing debounce in ms before the store commit. default 140 */
  settleMs?: number;
}

/** Read a themed color from a CSS variable, with a safe fallback. */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

/**
 * Apply an alpha to a hex (#rgb/#rrggbb) or already-rgb()/named color for the
 * crop-band fill. Falls back to the canvas's globalAlpha-style rgba wrapping for
 * non-hex inputs by just returning the color (the band still draws, opaque).
 */
function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (m) {
    let r: number;
    let g: number;
    let b: number;
    if (m[1].length === 3) {
      r = parseInt(m[1][0] + m[1][0], 16);
      g = parseInt(m[1][1] + m[1][1], 16);
      b = parseInt(m[1][2] + m[1][2], 16);
    } else {
      r = parseInt(m[1].slice(0, 2), 16);
      g = parseInt(m[1].slice(2, 4), 16);
      b = parseInt(m[1].slice(4, 6), 16);
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

/**
 * Build a stable signature of the series identity (ids + order). When this
 * changes the parent should remount the chart; when only values change we can
 * call setData cheaply.
 */
export function seriesSignature(series: UplotSeriesSpec[]): string {
  return series.map((s) => s.id).join("|");
}

export function UplotChart({
  xs,
  series,
  syncKey,
  xWindow,
  yRange,
  showXAxis = false,
  gutterPx = 56,
  height,
  cropMode = false,
  cropSel = null,
  filterMask = null,
  maxRenderPoints,
  onReady,
  onDestroy,
  onZoom,
  onCursor,
  onCrop,
  getSyncTargets,
  getLiveWindow,
  setLiveWindow,
  onZoomCommit,
  wheelZoomFactor,
  settleMs,
}: UplotChartProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const uplotRef = React.useRef<uPlot | null>(null);
  // Re-resolve axis/grid/cursor colors from CSS variables when the theme flips
  // (otherwise existing charts keep stale colors until a re-init).
  const theme = useEditorStore((s) => s.ui.theme);

  // Refs so the long-lived uPlot hooks always read fresh values without
  // forcing a re-init when a callback identity changes.
  const xWindowRef = React.useRef(xWindow);
  const yRangeRef = React.useRef(yRange);
  const onZoomRef = React.useRef(onZoom);
  const onCursorRef = React.useRef(onCursor);
  const onCropRef = React.useRef(onCrop);
  const cropModeRef = React.useRef(cropMode);
  const cropSelRef = React.useRef(cropSel);
  const filterMaskRef = React.useRef(filterMask);
  const seriesRef = React.useRef(series);
  const xsRef = React.useRef(xs);
  // Zoom/pan controller plumbing — read fresh through refs so a callback
  // identity change never forces a chart re-init.
  const getSyncTargetsRef = React.useRef(getSyncTargets);
  const getLiveWindowRef = React.useRef(getLiveWindow);
  const setLiveWindowRef = React.useRef(setLiveWindow);
  const onZoomCommitRef = React.useRef(onZoomCommit);
  const wheelZoomFactorRef = React.useRef(wheelZoomFactor);
  const settleMsRef = React.useRef(settleMs);
  /** indices into the full series produced by the last downsample pass */
  const drawIdxRef = React.useRef<number[]>([]);
  /** guard so store-driven setScale('x') doesn't echo back as a zoom event */
  const programmaticRef = React.useRef(false);
  /**
   * True only while THIS instance is the drag source. uPlot's cursor.sync
   * broadcasts the released selection to every synced lane, each of which then
   * fires its own setSelect; without this guard a single zoom drag would write
   * the (identical) x-window N times. We set it on mousedown over this chart and
   * clear it after the local setSelect handler runs, so synced (non-source)
   * setSelect events are suppressed.
   */
  const isDragSourceRef = React.useRef(false);

  xWindowRef.current = xWindow;
  yRangeRef.current = yRange;
  onZoomRef.current = onZoom;
  onCursorRef.current = onCursor;
  onCropRef.current = onCrop;
  cropModeRef.current = cropMode;
  cropSelRef.current = cropSel;
  filterMaskRef.current = filterMask;
  seriesRef.current = series;
  xsRef.current = xs;
  getSyncTargetsRef.current = getSyncTargets;
  getLiveWindowRef.current = getLiveWindow;
  setLiveWindowRef.current = setLiveWindow;
  onZoomCommitRef.current = onZoomCommit;
  wheelZoomFactorRef.current = wheelZoomFactor;
  settleMsRef.current = settleMs;

  const sig = seriesSignature(series);

  /** Build the [x, ...ys] aligned-data array, downsampled for rendering. */
  const buildData = React.useCallback(
    (width: number): uPlot.AlignedData => {
      const max =
        maxRenderPoints ?? Math.max(600, Math.round((width || 600) * 2));
      const ds = downsampleSeries(xsRef.current, seriesRef.current, max);
      drawIdxRef.current = ds.idx;
      return [ds.x, ...ds.ys] as unknown as uPlot.AlignedData;
    },
    [maxRenderPoints],
  );

  // ---- create / destroy the instance whenever series identity changes ----
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Measure the laid-out width. getBoundingClientRect reads the current layout,
    // so it is robust to a just-committed subtree; fall back to 600 only when the
    // element is genuinely unsized (then corrected post-layout by the rAF and the
    // ResizeObserver below).
    const measureWidth = () =>
      Math.round(el.getBoundingClientRect().width) || el.clientWidth || 0;
    const width = measureWidth() || 600;
    const gridColor = cssVar("--chart-grid", "#e2e8f0");
    const axisColor = cssVar("--chart-axis", "#94a3b8");
    const labelColor = cssVar("--fg-muted", "#64748b");
    const accentColor = cssVar("--accent", "#2563eb");

    const seriesOpts: uPlot.Series[] = [
      {},
      ...seriesRef.current.map((s) => ({
        label: s.label,
        stroke: s.color,
        width: 1.5,
        points: { show: false },
      })),
    ];

    const opts: uPlot.Options = {
      width,
      height,
      // never wall-clock: x is elapsed seconds or a sample index
      scales: {
        x: {
          time: false,
          range: (): [number, number] => {
            // Prefer the LIVE gesture window (set during an in-canvas zoom/pan
            // before any React render) so this chart's x — and crucially its
            // y-refit, which re-runs against the same window — stays correct
            // mid-gesture. Falls back to the committed store window.
            const live = getLiveWindowRef.current?.();
            const w = live ?? xWindowRef.current;
            const arr = xsRef.current;
            if (w) return [w.min, w.max];
            return [arr[0] ?? 0, arr[arr.length - 1] ?? 1];
          },
        },
        y: {
          auto: false,
          range: ((self, a, b) =>
            yRangeRef.current(self, a, b)) as uPlot.Scale.Range,
        },
      },
      axes: [
        {
          show: showXAxis,
          stroke: labelColor,
          grid: { show: showXAxis, stroke: gridColor, width: 1 },
          ticks: { stroke: axisColor, width: 1 },
          size: 28,
        },
        {
          show: true,
          stroke: labelColor,
          grid: { show: true, stroke: gridColor, width: 1 },
          ticks: { stroke: axisColor, width: 1 },
          // FIXED width so plot rectangles align across lanes regardless of
          // y-label width ("-1000" vs "0.5"). This is the #1 correctness move.
          size: gutterPx,
          // Fixed-width SI formatter (1.0k / 1.0M / 1.0G; exponential for tiny
          // values) so high/low-magnitude lanes keep labels inside the gutter
          // instead of printing 1000000000 and overflowing.
          values: (_u: uPlot, splits: number[]) => splits.map(formatTick),
        },
      ],
      // identical left/right padding so every plot rect starts/ends at the
      // same x pixel -> the synchronized crosshair never drifts.
      padding: [8, 12, 8, 0],
      legend: { show: false },
      cursor: {
        // Draw ONLY the vertical (time) crosshair; no per-lane horizontal y
        // crosshair line (it lingered after interactions and read as noise).
        x: true,
        y: false,
        // x ONLY in the sync scales — never y, or lane y-axes would couple
        // and the per-lane independent scaling (the whole point) breaks.
        sync: { key: syncKey, setSeries: false, scales: ["x", null] },
        drag: { x: !cropModeRef.current, y: false, setScale: false },
        points: { show: true },
      },
      series: seriesOpts,
      hooks: {
        setSelect: [
          (self: uPlot) => {
            const left = self.select.left;
            const right = left + self.select.width;
            if (self.select.width <= 0) return;
            const min = self.posToVal(left, "x");
            const max = self.posToVal(right, "x");
            // Only the lane where the drag started emits; synced (broadcast)
            // setSelect events on the other lanes are ignored to avoid N
            // redundant store writes per zoom/crop.
            const isSource = isDragSourceRef.current;
            isDragSourceRef.current = false;
            if (!isSource) {
              self.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
              return;
            }
            if (cropModeRef.current) {
              const startIdx = nearestIdx(xsRef.current, min);
              const endIdx = nearestIdx(xsRef.current, max);
              onCropRef.current?.({
                startIdx: Math.min(startIdx, endIdx),
                endIdx: Math.max(startIdx, endIdx),
              });
            } else if (!programmaticRef.current) {
              onZoomRef.current?.({
                min: Math.min(min, max),
                max: Math.max(min, max),
              });
            }
            // clear the visual selection; the real range lives in the store
            self.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          },
        ],
        setCursor: [
          (self: uPlot) => {
            const idx = self.cursor.idx;
            const orig =
              idx == null ? null : (drawIdxRef.current[idx] ?? null);
            onCursorRef.current?.(orig);
          },
        ],
        // Paint the crop selection as a translucent band. Reads cropSel from a
        // ref (never a closure) so it stays correct after lanes regroup. The
        // band spans the FULL-resolution sample indices mapped through xs to the
        // x scale, so it lines up across every lane.
        draw: [
          (self: uPlot) => {
            // 1) formula filter highlight: shade the NON-matching ranges so the
            // matching samples stand out. Non-destructive — a pure overlay.
            drawFilterShade(self, filterMaskRef.current, xsRef.current);

            // 2) crop band (editor crop selection).
            const sel = cropSelRef.current;
            if (!sel) return;
            const arr = xsRef.current;
            if (arr.length === 0) return;
            const lo = Math.max(0, Math.min(sel.startIdx, sel.endIdx));
            const hi = Math.min(
              arr.length - 1,
              Math.max(sel.startIdx, sel.endIdx),
            );
            if (hi <= lo) return;
            const xLo = arr[lo];
            const xHi = arr[hi];
            const left = self.valToPos(xLo, "x", true);
            const right = self.valToPos(xHi, "x", true);
            const ctx = self.ctx;
            const top = self.bbox.top;
            const h = self.bbox.height;
            // Read the accent fresh so the band is themed correctly even after a
            // light/dark switch (the band is only drawn during crop).
            const accent = cssVar("--accent", accentColor);
            ctx.save();
            ctx.fillStyle = withAlpha(accent, 0.14);
            ctx.fillRect(
              Math.min(left, right),
              top,
              Math.abs(right - left),
              h,
            );
            ctx.strokeStyle = withAlpha(accent, 0.6);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(left) + 0.5, top);
            ctx.lineTo(Math.round(left) + 0.5, top + h);
            ctx.moveTo(Math.round(right) + 0.5, top);
            ctx.lineTo(Math.round(right) + 0.5, top + h);
            ctx.stroke();
            ctx.restore();
          },
        ],
      },
    };

    const data = buildData(width);
    const u = new uPlot(opts, data, el);
    uplotRef.current = u;
    onReady?.(u);

    // A freshly-mounted chart (a NEW lane created via derive/drag remounts the
    // chart area) can read a 0/stale container width above — before the browser
    // lays out the remounted subtree — so uPlot builds a ~0-width plot rect and
    // the SERIES PATH has no room to draw even though the fixed-gutter y-axis
    // still renders its (correct) scale. That is the "blank lane with a correct
    // axis" bug. Re-measure on the next frame and resize if the real width now
    // differs, so the line always paints. (The ResizeObserver's w!==u.width gate
    // can otherwise miss this when the stale width never subsequently changes.)
    let sizeRaf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => {
            sizeRaf = 0;
            if (uplotRef.current !== u) return;
            const w = measureWidth();
            if (w > 0 && w !== u.width) u.setSize({ width: w, height });
          })
        : 0;

    // double-click resets the shared x-window to full extent
    const onDblClick = () => onZoomRef.current?.(null);
    u.over.addEventListener("dblclick", onDblClick);

    // mark this instance as the drag source so only it emits onZoom/onCrop when
    // uPlot's cursor.sync broadcasts the released selection to every lane.
    const onMouseDown = () => {
      isDragSourceRef.current = true;
    };
    u.over.addEventListener("mousedown", onMouseDown);

    // ---- wheel-zoom + drag-pan controller (in-canvas, rAF-coalesced) ----
    // Drives every sync target's x scale directly (zero React) and commits the
    // settled window once via onZoomCommit. Left-drag box-zoom (setSelect) and
    // dblclick reset above are untouched; this only adds wheel + right/middle/
    // space-drag pan. Reads all tuning + callbacks through refs.
    let zoom: ZoomController | null = null;
    try {
      zoom = attachZoomController({
        u,
        getSyncTargets: () => getSyncTargetsRef.current?.() ?? [u],
        getXs: () => xsRef.current,
        setLiveWindow: (w) => setLiveWindowRef.current?.(w),
        onCommit: (w) => {
          // route to onZoomCommit when wired, else fall back to onZoom so the
          // store still receives the settled window.
          const cb = onZoomCommitRef.current ?? onZoomRef.current;
          cb?.(w);
        },
        wheelZoomFactor: wheelZoomFactorRef.current,
        settleMs: settleMsRef.current,
      });
    } catch {
      /* never let a zoom-wiring failure break the chart */
    }

    return () => {
      if (sizeRaf && typeof cancelAnimationFrame === "function")
        cancelAnimationFrame(sizeRaf);
      u.over.removeEventListener("dblclick", onDblClick);
      u.over.removeEventListener("mousedown", onMouseDown);
      zoom?.destroy();
      onDestroy?.(u);
      u.destroy();
      uplotRef.current = null;
    };
    // Re-init ONLY when series identity (sig) or static layout props change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, syncKey, showXAxis, gutterPx]);

  // ---- cheap data refresh when values change but identity does not ----
  React.useEffect(() => {
    const u = uplotRef.current;
    const el = containerRef.current;
    if (!u || !el) return;
    u.setData(buildData(el.clientWidth || u.width), false);
    // sig in deps so this fires after a re-init too (no-op there, harmless)
  }, [series, xs, buildData, sig]);

  // ---- drive the shared x-window onto this chart (guarded against echo) ----
  React.useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    const arr = xsRef.current;
    const min = xWindow ? xWindow.min : (arr[0] ?? 0);
    const max = xWindow ? xWindow.max : (arr[arr.length - 1] ?? 1);
    programmaticRef.current = true;
    try {
      // Commit the x-window with a BARE setScale. Pre-setting u.scales.x.min/max
      // FIRST and then calling setScale with those SAME values makes uPlot's
      // change detection see "no change" and SKIP committing the internal
      // _min/_max that position the series — which leaves a blank lane with a
      // correct-looking axis (the series can't be placed without _min/_max). The
      // AxisFooter renders correctly precisely because it does a bare setScale.
      u.setScale("x", { min, max });
      // uPlot does NOT re-run a lane's y `range` fn on a bare setScale('x') under
      // auto:false, so re-fit y explicitly. setScale commits x synchronously
      // (outside a batch), so yRange — which reads self.scales.x — now sees the
      // new window. (Wheel/drag gestures are re-fit by the zoom controller; this
      // covers the committed window, +/- buttons, reset.)
      const [lo, hi] = yRangeRef.current(u, 0, 0);
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        u.setScale("y", { min: lo, max: hi });
      }
    } finally {
      programmaticRef.current = false;
    }
    // sig: re-commit x when the chart is RE-CREATED on a sample change. The
    // window can stay null across samples (full extent -> full extent), so
    // keying only on xWindow would skip the commit on the fresh instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xWindow, sig]);

  // ---- toggle crop vs zoom drag mode without re-init ----
  React.useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    u.cursor.drag = { x: !cropMode, y: false, setScale: false };
  }, [cropMode]);

  // ---- repaint the crop band when the selection changes (no re-init) ----
  React.useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    u.redraw();
  }, [cropSel]);

  // ---- repaint the filter shade when the mask changes (no re-init) ----
  React.useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    u.redraw();
  }, [filterMask]);

  // ---- refresh axis/grid/cursor colors on theme change (no re-init) ----
  React.useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    const gridColor = cssVar("--chart-grid", "#e2e8f0");
    const axisColor = cssVar("--chart-axis", "#94a3b8");
    const labelColor = cssVar("--fg-muted", "#64748b");
    for (const ax of u.axes) {
      // uPlot normalizes stroke/grid/ticks colors to FUNCTIONS at init and calls
      // them on every redraw (e.g. `axis.stroke(self, i)`). Assigning a raw
      // STRING here makes the NEXT redraw throw "axis.stroke is not a function"
      // and blanks the chart — which surfaced as intermittently empty lanes.
      // Wrap each color in a function so redraws stay safe.
      (ax as { stroke?: unknown }).stroke = () => labelColor;
      if (ax.grid) (ax.grid as { stroke?: unknown }).stroke = () => gridColor;
      if (ax.ticks) (ax.ticks as { stroke?: unknown }).stroke = () => axisColor;
    }
    u.redraw();
  }, [theme]);

  // ---- height changes resize without re-init ----
  React.useEffect(() => {
    const u = uplotRef.current;
    const el = containerRef.current;
    if (!u || !el) return;
    u.setSize({ width: el.clientWidth || u.width, height });
  }, [height]);

  // ---- ResizeObserver: keep width in sync with the container ----
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const u = uplotRef.current;
      if (!u) return;
      const w = el.clientWidth;
      if (w > 0 && w !== u.width) u.setSize({ width: w, height });
    });
    ro.observe(el);
    // Self-heal once synchronously on attach: if the instance was created against
    // a stale width during a remount, correct it now instead of waiting for a
    // size CHANGE the observer might never see.
    const u0 = uplotRef.current;
    const w0 = Math.round(el.getBoundingClientRect().width);
    if (u0 && w0 > 0 && w0 !== u0.width) u0.setSize({ width: w0, height });
    return () => ro.disconnect();
  }, [height]);

  return (
    <div
      ref={containerRef}
      className="w-full"
      style={{ height }}
      data-uplot-host=""
    />
  );
}

/**
 * Multi-series render downsample built on the per-series `downsample` helper.
 *
 * uPlot needs ONE shared x array with each series index-aligned to it. We pick
 * a shared set of kept indices = the union of each visible series' min/max
 * decimated indices (so every series' true peaks survive), sort it, then sample
 * x and every series on that set. Falls back to a stride when there are no
 * series. The returned `idx` maps each drawn point back to the full-resolution
 * sample index (used to resolve the synchronized cursor).
 */
function downsampleSeries(
  xs: number[],
  series: UplotSeriesSpec[],
  maxPoints: number,
): { x: number[]; ys: number[][]; idx: number[] } {
  const n = xs.length;
  if (n === 0) return { x: [], ys: series.map(() => []), idx: [] };

  if (series.length === 0) {
    // no series -> just decimate x by stride for a clean empty axis
    const stride = Math.max(1, Math.ceil(n / Math.max(1, maxPoints)));
    const idx: number[] = [];
    for (let i = 0; i < n; i += stride) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    return { x: idx.map((i) => xs[i]), ys: [], idx };
  }

  if (n <= maxPoints) {
    const idx = xs.map((_, i) => i);
    return {
      x: xs,
      ys: series.map((s) => alignValues(s.values, idx)),
      idx,
    };
  }

  // Budget per series so the union stays near maxPoints.
  const per = Math.max(2, Math.floor(maxPoints / series.length) * 2);
  const keep = new Set<number>();
  keep.add(0);
  keep.add(n - 1);
  for (const s of series) {
    const d = downsample(s.values, per);
    for (const i of d.indices) if (i >= 0 && i < n) keep.add(i);
  }
  const idx = Array.from(keep).sort((a, b) => a - b);
  return {
    x: idx.map((i) => xs[i]),
    ys: series.map((s) => alignValues(s.values, idx)),
    idx,
  };
}

/** Sample a full-resolution value array at the given indices (null off-end). */
function alignValues(values: number[], idx: number[]): number[] {
  const out = new Array<number>(idx.length);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    out[k] = i < values.length ? values[i] : NaN;
  }
  return out;
}

/**
 * Shade the NON-matching ranges of a formula filter mask so the matching
 * samples stand out. The mask is length-N over the full-resolution samples; we
 * map contiguous non-matching runs through the shared `xs` to x-pixel rects.
 * Drawn translucently and clamped to the plot bbox. Pure visual overlay.
 */
function drawFilterShade(
  self: uPlot,
  mask: boolean[] | null | undefined,
  xs: number[],
): void {
  if (!mask || mask.length === 0 || xs.length === 0) return;
  // Nothing to dim if every sample matches.
  let anyUnmatched = false;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) {
      anyUnmatched = true;
      break;
    }
  }
  if (!anyUnmatched) return;

  const ctx = self.ctx;
  const top = self.bbox.top;
  const h = self.bbox.height;
  const left = self.bbox.left;
  const width = self.bbox.width;
  const dim = cssVar("--fg", "#0f172a");
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, h);
  ctx.clip();
  ctx.fillStyle = withAlpha(dim, 0.16);

  const n = Math.min(mask.length, xs.length);
  let runStart = -1;
  const paint = (lo: number, hi: number) => {
    // shade [lo, hi] inclusive sample range
    const xLo = self.valToPos(xs[lo], "x", true);
    const xHi = self.valToPos(xs[hi], "x", true);
    const a = Math.min(xLo, xHi);
    const b = Math.max(xLo, xHi);
    ctx.fillRect(a, top, Math.max(1, b - a), h);
  };
  for (let i = 0; i < n; i++) {
    const unmatched = !mask[i];
    if (unmatched && runStart === -1) runStart = i;
    if (!unmatched && runStart !== -1) {
      paint(runStart, i - 1);
      runStart = -1;
    }
  }
  if (runStart !== -1) paint(runStart, n - 1);
  ctx.restore();
}

/** Nearest index in a (monotonic-ish) x array to a domain value. */
function nearestIdx(xs: number[], val: number): number {
  if (xs.length === 0) return 0;
  // binary search for sorted-ascending typical x; fall back to linear scan
  let lo = 0;
  let hi = xs.length - 1;
  if (xs[lo] <= xs[hi]) {
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < val) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(xs[lo - 1] - val) <= Math.abs(xs[lo] - val))
      return lo - 1;
    return lo;
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - val);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
