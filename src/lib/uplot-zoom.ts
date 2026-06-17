/**
 * uplot-zoom.ts — framework-agnostic wheel-zoom / drag-pan / box-zoom controller
 * for the Edge Impulse CSV Editor lane charts.
 *
 * WHY a plain controller (not a uPlot plugin object): the gesture must drive a
 * SET of sibling uPlot instances in lockstep (every lane + the shared axis
 * footer) at the CANVAS layer, with ZERO React re-renders, and only commit the
 * settled x-window to the store on gesture end. A uPlot `plugin` hook is scoped
 * to one instance; we instead attach native listeners to the source chart's
 * `over` element and fan-out `setScale` to a getter-provided list of targets.
 *
 * Design (mirrors the binding ZOOM spec):
 *  - WHEEL          => cursor-centered x-only zoom (factor default 0.75),
 *                      clamped to the data bounds with a minimum-span floor.
 *  - RIGHT / MIDDLE / SPACE+LEFT drag => pan the x-window (no React commit).
 *  - LEFT drag      => left to uPlot's native box-zoom (setSelect) — NOT handled
 *                      here; the chart's existing setSelect hook commits it.
 *  - DOUBLE-CLICK   => reset to full extent (chart's existing dblclick handler).
 *  - rAF COALESCING => many wheel ticks / mousemoves within a frame collapse to
 *                      ONE canvas update pass.
 *  - SETTLE COMMIT  => a trailing debounce (settleMs) after the last wheel tick,
 *                      or mouseup for a pan, fires ONE onCommit(window|null) —
 *                      the only React render of the whole gesture.
 *
 * The load-bearing detail (verified in uPlot 1.6 source): a bare
 * `u.setScale("x", …)` does NOT re-invoke a lane's y `range` callback, because
 * y is configured `auto:false` with a range FUNCTION (uPlot wraps `sc.auto` as
 * `() => false`). So every x mutation must be PAIRED, per mirrored instance,
 * with an explicit y re-fit (`setScale(yKey, {min:null, max:null})`) inside a
 * `u.batch`. AND the y range fn must read the LIVE gesture window, which the
 * host supplies via `setLiveWindow` (a board-level ref) so every sibling re-fits
 * to the SAME window during the gesture, not its stale per-instance ref.
 */

import type uPlot from "uplot";

export interface ZoomWindow {
  min: number;
  max: number;
}

export interface ZoomControllerOptions {
  /** the source chart whose `over` element receives the native listeners */
  u: uPlot;
  /**
   * Every live uPlot instance to mirror (incl. THIS one and the axis footer).
   * Passed as a getter to avoid stale closures as lanes mount/unmount.
   */
  getSyncTargets: () => uPlot[];
  /** current full x-axis array; data bounds are xs[0]..xs[last] */
  getXs: () => number[];
  /**
   * Publish the live gesture window to the host so EVERY lane's y range fn can
   * re-fit to the same window during the gesture. Called with null on settle so
   * lanes fall back to the committed store window.
   */
  setLiveWindow?: (win: ZoomWindow | null) => void;
  /** trailing-edge settle: fires ONCE with the final window (null = full). */
  onCommit: (win: ZoomWindow | null) => void;
  /** zoom multiplier per wheel notch (smaller = more aggressive). default 0.75 */
  wheelZoomFactor?: number;
  /** trailing debounce in ms before committing to the store. default 140 */
  settleMs?: number;
}

const DEFAULT_FACTOR = 0.75;
const DEFAULT_SETTLE_MS = 140;
/** minimum window span = this many average sample steps (anti zero-width zoom) */
const MIN_SPAN_STEPS = 3;

/** Clamp helper. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Full data bounds from the xs array; [0,1] fallback for an empty array. */
function dataBounds(xs: number[]): { lo: number; hi: number } {
  if (xs.length === 0) return { lo: 0, hi: 1 };
  const lo = xs[0];
  const hi = xs[xs.length - 1];
  // x may be descending in pathological inputs; normalize so lo <= hi.
  return lo <= hi ? { lo, hi } : { lo: hi, hi: lo };
}

/** A reasonable minimum span so users can't zoom into a zero-width window. */
function minSpan(xs: number[]): number {
  const { lo, hi } = dataBounds(xs);
  const full = hi - lo;
  if (!(full > 0)) return 1e-9;
  const steps = Math.max(1, xs.length - 1);
  return Math.max((full / steps) * MIN_SPAN_STEPS, full * 1e-6);
}

/**
 * Normalize a desired window against the data bounds + minimum span. Returns
 * null when the window covers (or exceeds) the full extent, so "fully zoomed
 * out" stays a single canonical state (matches the store's normalizeWindow).
 */
export function normalizeZoomWindow(
  win: ZoomWindow | null,
  xs: number[],
): ZoomWindow | null {
  const { lo, hi } = dataBounds(xs);
  if (!win) return null;
  let min = win.min;
  let max = win.max;
  if (max < min) {
    const t = min;
    min = max;
    max = t;
  }
  min = clamp(min, lo, hi);
  max = clamp(max, lo, hi);
  // enforce a minimum span without escaping the data bounds
  const span = max - min;
  const floor = minSpan(xs);
  if (span < floor) {
    const mid = (min + max) / 2;
    min = mid - floor / 2;
    max = mid + floor / 2;
    if (min < lo) {
      min = lo;
      max = Math.min(hi, lo + floor);
    } else if (max > hi) {
      max = hi;
      min = Math.max(lo, hi - floor);
    }
  }
  // covers full extent (within epsilon) => canonical null
  const eps = (hi - lo) * 1e-9;
  if (min <= lo + eps && max >= hi - eps) return null;
  return { min, max };
}

/** Resolve the current window from a uPlot instance's live x scale. */
function currentWindow(u: uPlot): ZoomWindow {
  const sc = u.scales.x;
  const min = sc?.min;
  const max = sc?.max;
  if (typeof min === "number" && typeof max === "number") return { min, max };
  return { min: 0, max: 1 };
}

/** Non-x scale keys on an instance (the y scales that need an explicit re-fit). */
function yScaleKeys(u: uPlot): string[] {
  const out: string[] = [];
  for (const k of Object.keys(u.scales)) if (k !== "x") out.push(k);
  return out;
}

export interface ZoomController {
  /** detach all native listeners + cancel timers/rAF. Idempotent. */
  destroy: () => void;
}

/**
 * Attach the wheel/drag zoom-pan controller to a source uPlot instance.
 *
 * Returns a controller whose `destroy()` removes every listener and cancels any
 * pending rAF / settle timer. Safe to call in a React effect cleanup.
 */
export function attachZoomController(
  opts: ZoomControllerOptions,
): ZoomController {
  const { u, getSyncTargets, getXs, setLiveWindow, onCommit } = opts;
  const factor = opts.wheelZoomFactor ?? DEFAULT_FACTOR;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;

  const over = u.over;

  // ---- gesture state ----
  // The window we want to render on the next animation frame.
  let pendingWin: ZoomWindow | null = null;
  let rafHandle = 0;
  let settleTimer: ReturnType<typeof setTimeout> | 0 = 0;
  // null when no gesture is active; "wheel" | "pan" otherwise. Used so a stray
  // trailing wheel-settle never overwrites a fresh box-zoom (which commits
  // synchronously through the chart's own setSelect path).
  let gestureKind: "wheel" | "pan" | null = null;
  // Space key arms left-drag panning (trackpad-friendly, discoverable).
  let spaceHeld = false;
  // active pan bookkeeping
  let panning = false;
  let panStartClientX = 0;
  let panStartWin: ZoomWindow = { min: 0, max: 1 };

  /** Apply the pending window to EVERY sync target with the paired y-refit. */
  function applyPending() {
    rafHandle = 0;
    const win = pendingWin;
    if (!win) return;
    // Publish to the host FIRST so each lane's y range fn reads the live window
    // when the y-refit below re-invokes it.
    setLiveWindow?.(win);
    const targets = getSyncTargets();
    for (const t of targets) {
      try {
        // Re-fit each y to the new window. Two uPlot 1.6 facts (verified live)
        // make an explicit recompute necessary:
        //  1. setScale('y', {min:null,max:null}) does NOT re-invoke a y `range`
        //     fn under auto:false — y keeps the full-data range and lines flatten.
        //  2. setScale is DEFERRED, so self.scales.x is stale right after
        //     setScale('x') — the y range fn (which reads self.scales.x) would
        //     compute over the OLD window.
        // So point each x scale at the window SYNCHRONOUSLY, compute the windowed
        // y from its range fn, then commit x + the recomputed y. (rAF-coalesced.)
        t.scales.x.min = win.min;
        t.scales.x.max = win.max;
        const yfit: Array<[string, number, number]> = [];
        for (const sk of yScaleKeys(t)) {
          const sc = t.scales[sk];
          const rangeFn = sc.range;
          if (typeof rangeFn === "function") {
            const r = rangeFn(t, sc.min ?? 0, sc.max ?? 1, sk);
            const lo = r[0];
            const hi = r[1];
            if (
              lo != null &&
              hi != null &&
              Number.isFinite(lo) &&
              Number.isFinite(hi)
            ) {
              yfit.push([sk, lo, hi]);
            }
          }
        }
        t.setScale("x", { min: win.min, max: win.max });
        for (const [sk, lo, hi] of yfit) {
          t.setScale(sk, { min: lo, max: hi });
        }
      } catch {
        /* a sibling may be mid-teardown; skip it */
      }
    }
  }

  /** Queue a window for the next frame; coalesces multiple events per frame. */
  function schedule(win: ZoomWindow) {
    pendingWin = win;
    if (rafHandle === 0) {
      rafHandle =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(applyPending)
          : (setTimeout(applyPending, 16) as unknown as number);
    }
  }

  /** Cancel any queued frame. */
  function cancelRaf() {
    if (rafHandle !== 0) {
      if (typeof cancelAnimationFrame === "function")
        cancelAnimationFrame(rafHandle);
      else clearTimeout(rafHandle as unknown as ReturnType<typeof setTimeout>);
      rafHandle = 0;
    }
  }

  /** Schedule the single trailing-edge store commit. */
  function scheduleSettle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      // ignore if a different gesture took over in the meantime
      if (gestureKind !== "wheel") return;
      commitNow();
    }, settleMs);
  }

  /** Flush the live window to the store and clear the live-window override. */
  function commitNow() {
    const xs = getXs();
    const finalWin = pendingWin ?? currentWindow(u);
    const normalized = normalizeZoomWindow(finalWin, xs);
    gestureKind = null;
    pendingWin = null;
    setLiveWindow?.(null);
    onCommit(normalized);
  }

  // ---------------------------------------------------------------- wheel ----
  function onWheel(e: WheelEvent) {
    // must preventDefault (page would scroll); requires passive:false listener.
    e.preventDefault();
    const xs = getXs();
    if (xs.length === 0) return;

    gestureKind = "wheel";

    // current window (live during a gesture, else the committed scale)
    const cur = pendingWin ?? currentWindow(u);
    const { lo, hi } = dataBounds(xs);
    const curMin = Number.isFinite(cur.min) ? cur.min : lo;
    const curMax = Number.isFinite(cur.max) ? cur.max : hi;

    // cursor-centered: anchor the zoom at the x value under the pointer.
    const rect = over.getBoundingClientRect();
    const leftPx = e.clientX - rect.left;
    const width = rect.width || 1;
    const leftPct = clamp(leftPx / width, 0, 1);
    const anchor = curMin + (curMax - curMin) * leftPct;

    // deltaY < 0 (scroll up / pinch out) => zoom IN (shrink window).
    const zoomIn = e.deltaY < 0;
    const scale = zoomIn ? factor : 1 / factor;

    const newMin = anchor - (anchor - curMin) * scale;
    const newMax = anchor + (curMax - anchor) * scale;

    const normalized = normalizeZoomWindow({ min: newMin, max: newMax }, xs);
    // For the live canvas we want a concrete window even at full extent; only
    // the COMMIT collapses to null. Use the clamped extent when normalized null.
    const live: ZoomWindow = normalized ?? { min: lo, max: hi };
    schedule(live);
    scheduleSettle();
  }

  // ------------------------------------------------------------------ pan ----
  function isPanTrigger(e: MouseEvent): boolean {
    // right button OR middle button OR space-held left button
    return (
      e.button === 2 ||
      e.button === 1 ||
      (e.button === 0 && spaceHeld)
    );
  }

  function onMouseDown(e: MouseEvent) {
    if (!isPanTrigger(e)) return;
    const xs = getXs();
    if (xs.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    panning = true;
    gestureKind = "pan";
    panStartClientX = e.clientX;
    panStartWin = pendingWin ?? currentWindow(u);
    over.style.cursor = "grabbing";
    // also stop the settle timer so a stray wheel-settle can't fire mid-pan
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = 0;
    }
    window.addEventListener("mousemove", onPanMove, true);
    window.addEventListener("mouseup", onPanUp, true);
  }

  function onPanMove(e: MouseEvent) {
    if (!panning) return;
    const xs = getXs();
    if (xs.length === 0) return;
    const rect = over.getBoundingClientRect();
    const width = rect.width || 1;
    const span = panStartWin.max - panStartWin.min;
    // pixels dragged -> domain units; drag right reveals earlier x (pan left).
    const dxPx = e.clientX - panStartClientX;
    const dxVal = (-dxPx / width) * span;
    let min = panStartWin.min + dxVal;
    let max = panStartWin.max + dxVal;
    // keep the span fixed; clamp the WHOLE window inside the data bounds.
    const { lo, hi } = dataBounds(xs);
    if (min < lo) {
      max += lo - min;
      min = lo;
    }
    if (max > hi) {
      min -= max - hi;
      max = hi;
    }
    min = clamp(min, lo, hi);
    max = clamp(max, lo, hi);
    schedule({ min, max });
  }

  function onPanUp() {
    if (!panning) return;
    panning = false;
    over.style.cursor = spaceHeld ? "grab" : "";
    window.removeEventListener("mousemove", onPanMove, true);
    window.removeEventListener("mouseup", onPanUp, true);
    // commit the settled pan window once
    const xs = getXs();
    const finalWin = pendingWin ?? currentWindow(u);
    const normalized = normalizeZoomWindow(finalWin, xs);
    gestureKind = null;
    pendingWin = null;
    setLiveWindow?.(null);
    onCommit(normalized);
  }

  /** Right-drag pan needs the context menu suppressed over the canvas. */
  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
  }

  // ---- space-to-pan affordance (window-level so it works before hover) ----
  function onKeyDown(e: KeyboardEvent) {
    if (e.code === "Space" && !spaceHeld) {
      spaceHeld = true;
      if (!panning) over.style.cursor = "grab";
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    if (e.code === "Space") {
      spaceHeld = false;
      if (!panning) over.style.cursor = "";
    }
  }

  // ---- attach ----
  over.addEventListener("wheel", onWheel, { passive: false });
  over.addEventListener("mousedown", onMouseDown, true);
  over.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return {
    destroy() {
      over.removeEventListener("wheel", onWheel);
      over.removeEventListener("mousedown", onMouseDown, true);
      over.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onPanMove, true);
      window.removeEventListener("mouseup", onPanUp, true);
      cancelRaf();
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
      over.style.cursor = "";
    },
  };
}

/**
 * Compute a centered zoom window for the +/- footer buttons.
 *
 * `current` is the active window (null = full extent). Zooming IN shrinks by
 * `factor`; zooming OUT expands by `1/factor`, both centered on the window's
 * midpoint. Returns a normalized window (null when it reaches full extent).
 */
export function centeredZoom(
  current: ZoomWindow | null,
  xs: number[],
  direction: "in" | "out",
  factor = DEFAULT_FACTOR,
): ZoomWindow | null {
  const { lo, hi } = dataBounds(xs);
  const cur = current ?? { min: lo, max: hi };
  const mid = (cur.min + cur.max) / 2;
  const half = (cur.max - cur.min) / 2;
  const scale = direction === "in" ? factor : 1 / factor;
  const newHalf = half * scale;
  return normalizeZoomWindow({ min: mid - newHalf, max: mid + newHalf }, xs);
}
