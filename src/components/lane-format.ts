/**
 * lane-format.ts — tiny number formatters local to the lane board components.
 *
 * Intentionally minimal and self-contained so the lane board has no hard
 * dependency on the (separately-owned) `@/lib/format` module. If that module
 * later supersedes these, callers can switch with a one-line import change.
 */

/** Compact, fixed-ish precision value for chip readouts and tooltips. */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) {
    return v.toExponential(2);
  }
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** Fixed-width SI-ish y-tick formatter so labels stay inside the 56px gutter. */
export function formatTick(v: number): string {
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + "G";
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + "k";
  if (abs === 0) return "0";
  if (abs < 1e-2) return v.toExponential(1);
  if (abs < 1) return v.toFixed(2);
  return v.toFixed(abs >= 100 ? 0 : 1);
}
