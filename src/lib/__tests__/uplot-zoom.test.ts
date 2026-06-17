import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type uPlot from "uplot";
import {
  normalizeZoomWindow,
  centeredZoom,
  attachZoomController,
  type ZoomWindow,
} from "@/lib/uplot-zoom";

// xs spanning [0, 100] with 101 samples (step = 1).
const XS = Array.from({ length: 101 }, (_, i) => i);

describe("normalizeZoomWindow", () => {
  it("returns null for a null window (full extent)", () => {
    expect(normalizeZoomWindow(null, XS)).toBeNull();
  });

  it("collapses a window covering the full extent to null", () => {
    expect(normalizeZoomWindow({ min: 0, max: 100 }, XS)).toBeNull();
    // slightly beyond bounds also clamps to full -> null
    expect(normalizeZoomWindow({ min: -10, max: 200 }, XS)).toBeNull();
  });

  it("clamps a window to the data bounds", () => {
    const w = normalizeZoomWindow({ min: -20, max: 50 }, XS);
    expect(w).not.toBeNull();
    expect(w!.min).toBe(0);
    expect(w!.max).toBe(50);
  });

  it("keeps a valid interior window unchanged", () => {
    const w = normalizeZoomWindow({ min: 25, max: 75 }, XS);
    expect(w).toEqual({ min: 25, max: 75 });
  });

  it("swaps inverted bounds", () => {
    const w = normalizeZoomWindow({ min: 75, max: 25 }, XS);
    expect(w).toEqual({ min: 25, max: 75 });
  });

  it("enforces a minimum span (no zero-width zoom)", () => {
    const w = normalizeZoomWindow({ min: 50, max: 50 }, XS);
    expect(w).not.toBeNull();
    expect(w!.max - w!.min).toBeGreaterThan(0);
  });

  it("keeps the min-span window inside the data bounds at an edge", () => {
    const w = normalizeZoomWindow({ min: 100, max: 100 }, XS);
    expect(w).not.toBeNull();
    expect(w!.max).toBeLessThanOrEqual(100);
    expect(w!.min).toBeGreaterThanOrEqual(0);
  });

  it("handles an empty xs array without throwing", () => {
    expect(normalizeZoomWindow({ min: 1, max: 2 }, [])).toBeNull();
  });
});

describe("centeredZoom", () => {
  it("zooms in by shrinking around the midpoint", () => {
    // full extent, zoom in by 0.5 -> half width centered on 50
    const w = centeredZoom(null, XS, "in", 0.5);
    expect(w).toEqual({ min: 25, max: 75 });
  });

  it("zooms out by expanding around the midpoint", () => {
    const w = centeredZoom({ min: 40, max: 60 }, XS, "out", 0.5);
    // half=10, scale=1/0.5=2 -> newHalf=20, mid=50 -> [30,70]
    expect(w).toEqual({ min: 30, max: 70 });
  });

  it("zooming out from a near-full window collapses to null", () => {
    const w = centeredZoom({ min: 10, max: 90 }, XS, "out", 0.5);
    expect(w).toBeNull();
  });

  it("respects the data bounds when expanding past them", () => {
    const w = centeredZoom({ min: 5, max: 15 }, XS, "out", 0.25);
    // mid=10, half=5, scale=4 -> newHalf=20 -> [-10,30] clamps to [0,30]
    expect(w).not.toBeNull();
    expect(w!.min).toBe(0);
    expect(w!.max).toBe(30);
  });
});

// ---- controller integration (stubbed uPlot + DOM events) ----

/** Minimal uPlot-like stub exposing only what the controller touches. */
function makeStubUplot() {
  // The y scale carries a `range` fn (as the real lane charts do) that derives
  // its extent from the LIVE x scale — so the test can verify the controller
  // re-fits y to the zoomed window. Here y simply mirrors x.
  type StubScale = {
    min: number | null;
    max: number | null;
    range?: (self: { scales: Record<string, StubScale> }) => [number, number];
  };
  const scaleState: Record<string, StubScale> = {
    x: { min: 0, max: 100 },
    y: {
      min: 0,
      max: 1,
      range: (self) => [self.scales.x.min ?? 0, self.scales.x.max ?? 1],
    },
  };
  const over = document.createElement("div");
  // jsdom gives 0x0 rects; stub a 800px-wide plot rect.
  over.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 200, right: 800, bottom: 200 }) as DOMRect;
  const setScaleCalls: Array<{ key: string; min: number | null; max: number | null }> =
    [];
  const u = {
    over,
    scales: scaleState,
    batch(fn: () => void) {
      fn();
    },
    setScale(key: string, lim: { min: number | null; max: number | null }) {
      setScaleCalls.push({ key, min: lim.min, max: lim.max });
      scaleState[key] = { min: lim.min, max: lim.max };
    },
  };
  return { u: u as unknown as uPlot, over, setScaleCalls };
}

describe("attachZoomController", () => {
  beforeEach(() => {
    // fake only the settle-debounce timer; leave rAF real so our synchronous
    // stub below drives the canvas pass deterministically.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // run rAF callbacks synchronously and immediately
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("wheel zoom-in narrows the x window across all sync targets", () => {
    const a = makeStubUplot();
    const b = makeStubUplot();
    const commit = vi.fn();
    const live: ZoomWindow[] = [];
    const ctrl = attachZoomController({
      u: a.u,
      getSyncTargets: () => [a.u, b.u],
      getXs: () => XS,
      setLiveWindow: (w) => {
        if (w) live.push(w);
      },
      onCommit: commit,
      settleMs: 140,
    });

    // wheel up at the left edge (clientX=0) => zoom IN centered near x=0
    const ev = new WheelEvent("wheel", {
      deltaY: -100,
      clientX: 0,
      clientY: 50,
      cancelable: true,
    });
    a.over.dispatchEvent(ev);

    // both instances had their x scale narrowed
    const aX = a.u.scales.x;
    const bX = b.u.scales.x;
    expect(aX.max! - aX.min!).toBeLessThan(100);
    expect(bX.max! - bX.min!).toBeLessThan(100);
    // each got an EXPLICIT y re-fit computed from the new window. uPlot ignores
    // setScale('y', {min:null}) under auto:false, so the controller calls the y
    // range fn (which reads the live x) and sets concrete values — here y
    // mirrors x, so the committed y equals the narrowed x window.
    expect(
      a.setScaleCalls.some((c) => c.key === "y" && typeof c.min === "number"),
    ).toBe(true);
    expect(a.u.scales.y.min).toBe(aX.min);
    expect(a.u.scales.y.max).toBe(aX.max);

    // no store commit yet (debounced)
    expect(commit).not.toHaveBeenCalled();
    // a live window was published for the y-refit
    expect(live.length).toBeGreaterThan(0);

    // settle fires exactly one commit with the final window
    vi.advanceTimersByTime(140);
    expect(commit).toHaveBeenCalledTimes(1);
    const win = commit.mock.calls[0][0] as ZoomWindow | null;
    expect(win).not.toBeNull();
    expect(win!.max - win!.min).toBeLessThan(100);

    ctrl.destroy();
  });

  it("right-drag pans the window and commits on mouseup", () => {
    const a = makeStubUplot();
    const commit = vi.fn();
    const ctrl = attachZoomController({
      u: a.u,
      getSyncTargets: () => [a.u],
      getXs: () => XS,
      onCommit: commit,
    });

    // start with a zoomed window so a pan has room to move
    a.u.setScale("x", { min: 20, max: 60 });

    const down = new MouseEvent("mousedown", {
      button: 2,
      clientX: 400,
      cancelable: true,
      bubbles: true,
    });
    a.over.dispatchEvent(down);
    // drag right by 400px on an 800px plot => pan left by half the 40-wide span
    const move = new MouseEvent("mousemove", { clientX: 800, bubbles: true });
    window.dispatchEvent(move);

    const x = a.u.scales.x;
    // panning right reveals EARLIER x: window shifts toward 0
    expect(x.min!).toBeLessThan(20);

    const up = new MouseEvent("mouseup", { bubbles: true });
    window.dispatchEvent(up);
    expect(commit).toHaveBeenCalledTimes(1);

    ctrl.destroy();
  });

  it("wheel zoom-out from full extent commits null (canonical reset)", () => {
    const a = makeStubUplot();
    const commit = vi.fn();
    const ctrl = attachZoomController({
      u: a.u,
      getSyncTargets: () => [a.u],
      getXs: () => XS,
      onCommit: commit,
      settleMs: 50,
    });
    // already full extent; wheel down (zoom out) stays full -> commit null
    const ev = new WheelEvent("wheel", {
      deltaY: 100,
      clientX: 400,
      cancelable: true,
    });
    a.over.dispatchEvent(ev);
    vi.advanceTimersByTime(50);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toBeNull();
    ctrl.destroy();
  });

  it("destroy() removes listeners (no commit after teardown)", () => {
    const a = makeStubUplot();
    const commit = vi.fn();
    const ctrl = attachZoomController({
      u: a.u,
      getSyncTargets: () => [a.u],
      getXs: () => XS,
      onCommit: commit,
      settleMs: 30,
    });
    ctrl.destroy();
    a.over.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, clientX: 0, cancelable: true }),
    );
    vi.advanceTimersByTime(60);
    expect(commit).not.toHaveBeenCalled();
  });
});
