// src/lib/formula/functions.ts — the whitelist function library.
//
// Every callable in the formula language lives here. The evaluator NEVER reaches
// JS globals, prototypes, eval, or Function — it only ever calls into this frozen
// table. Each entry validates its own arity/types and returns a Value (a scalar
// `number` or a length-N `Float64Array` vector). Errors are thrown as
// FnError(kind, message) and caught by the evaluator, which attaches the call's
// source position before surfacing a friendly FormulaError. Nothing here throws
// a bare Error into React.
//
// Value semantics (numpy-like):
//   - scalar  : a plain `number`
//   - vector  : a Float64Array of length N (the sample count)
//   - booleans are 1 / 0 (a "mask" is just a 0/1 vector)
//
// Functions fall into three shapes:
//   - elementwise : abs sqrt exp log log10 sin cos tan floor ceil round sign
//                   clip(x,lo,hi) where(cond,a,b) min/max(>=2 args)
//   - reducers    : mean std var sum median amin amax count -> scalar
//   - windowed    : diff cumsum gradient rolling_mean rolling_std normalize

import type { FormulaError } from "./errors";

/** A formula value: a scalar number or a length-N vector. */
export type Value = number | Float64Array;

/** Thrown by a function impl; the evaluator turns it into a FormulaError. */
export class FnError extends Error {
  readonly kind: FormulaError["kind"];
  constructor(kind: FormulaError["kind"], message: string) {
    super(message);
    this.kind = kind;
    this.name = "FnError";
  }
}

// ---------------------------------------------------------------------------
// Value helpers (shared with the evaluator)
// ---------------------------------------------------------------------------

export function isVector(v: Value): v is Float64Array {
  return v instanceof Float64Array;
}

/** Length of a value: a vector's length, or 1 for a scalar. */
export function lengthOf(v: Value): number {
  return isVector(v) ? v.length : 1;
}

/**
 * Read element `i` of a value: the i-th element of a vector, or the scalar
 * itself (scalars broadcast to every index).
 */
export function at(v: Value, i: number): number {
  return isVector(v) ? v[i] : v;
}

/**
 * The broadcast length of a set of values: every vector must share one length N
 * (scalars are length-agnostic). Mismatched vector lengths are a type error.
 * Returns 1 when there are no vectors (all-scalar expression -> scalar result).
 */
export function broadcastLength(values: Value[]): number {
  let n = -1;
  for (const v of values) {
    if (isVector(v)) {
      if (n === -1) n = v.length;
      else if (n !== v.length) {
        throw new FnError(
          "type",
          `Length mismatch: cannot combine vectors of length ${n} and ${v.length}.`,
        );
      }
    }
  }
  return n === -1 ? 1 : n;
}

/**
 * Apply a unary numeric op elementwise. A scalar input yields a scalar; a vector
 * input yields a vector.
 */
export function mapUnary(v: Value, fn: (x: number) => number): Value {
  if (isVector(v)) {
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = fn(v[i]);
    return out;
  }
  return fn(v);
}

/**
 * Apply a binary numeric op with scalar<->vector broadcasting. Two scalars yield
 * a scalar; any vector operand yields a vector of the broadcast length.
 */
export function mapBinary(
  a: Value,
  b: Value,
  fn: (x: number, y: number) => number,
): Value {
  if (!isVector(a) && !isVector(b)) return fn(a, b);
  const n = broadcastLength([a, b]);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(at(a, i), at(b, i));
  return out;
}

/** Collect the finite numeric elements of a value into a plain array. */
function finiteElements(v: Value): number[] {
  const out: number[] = [];
  const n = lengthOf(v);
  for (let i = 0; i < n; i++) {
    const x = at(v, i);
    if (Number.isFinite(x)) out.push(x);
  }
  return out;
}

/** All elements of a value (including non-finite) as a plain array. */
function allElements(v: Value): number[] {
  const n = lengthOf(v);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = at(v, i);
  return out;
}

// ---------------------------------------------------------------------------
// Reducer math (finite-aware, deterministic)
// ---------------------------------------------------------------------------

function sumFinite(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function meanFinite(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return sumFinite(xs) / xs.length;
}

/** Population variance (ddof=0) over finite elements — matches numpy default. */
function varFinite(xs: number[]): number {
  const n = xs.length;
  if (n === 0) return NaN;
  const m = meanFinite(xs);
  let acc = 0;
  for (const x of xs) {
    const d = x - m;
    acc += d * d;
  }
  return acc / n;
}

function medianFinite(xs: number[]): number {
  const n = xs.length;
  if (n === 0) return NaN;
  const v = xs.slice().sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
}

// ---------------------------------------------------------------------------
// Arity validation
// ---------------------------------------------------------------------------

function exact(name: string, args: Value[], n: number): void {
  if (args.length !== n) {
    throw new FnError(
      "arity",
      `${name}() expects ${n} argument${n === 1 ? "" : "s"}, got ${args.length}.`,
    );
  }
}

function atLeast(name: string, args: Value[], n: number): void {
  if (args.length < n) {
    throw new FnError(
      "arity",
      `${name}() expects at least ${n} argument${n === 1 ? "" : "s"}, got ${args.length}.`,
    );
  }
}

/** Coerce a value that must be a scalar window size to a positive integer. */
function windowArg(name: string, v: Value): number {
  if (isVector(v)) {
    throw new FnError(
      "type",
      `${name}() window size must be a scalar number, not a channel/vector.`,
    );
  }
  if (!Number.isFinite(v) || v < 1 || Math.floor(v) !== v) {
    throw new FnError(
      "type",
      `${name}() window size must be a positive integer, got ${v}.`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Windowed helpers
// ---------------------------------------------------------------------------

/** Adjacent forward difference; first element is NaN (no predecessor). */
function diff(v: Value): Value {
  const xs = allElements(v);
  const n = xs.length;
  const out = new Float64Array(n);
  out[0] = NaN;
  for (let i = 1; i < n; i++) out[i] = xs[i] - xs[i - 1];
  return n === 1 ? out : out;
}

/** Running cumulative sum (non-finite contributes NaN forward, numpy-like). */
function cumsum(v: Value): Value {
  const xs = allElements(v);
  const out = new Float64Array(xs.length);
  let acc = 0;
  for (let i = 0; i < xs.length; i++) {
    acc += xs[i];
    out[i] = acc;
  }
  return out;
}

/** Central gradient (numpy.gradient with unit spacing): edges one-sided. */
function gradient(v: Value): Value {
  const xs = allElements(v);
  const n = xs.length;
  const out = new Float64Array(n);
  if (n === 1) {
    out[0] = 0;
    return out;
  }
  out[0] = xs[1] - xs[0];
  out[n - 1] = xs[n - 1] - xs[n - 2];
  for (let i = 1; i < n - 1; i++) out[i] = (xs[i + 1] - xs[i - 1]) / 2;
  return out;
}

/**
 * Trailing rolling reducer of window `w`: out[i] uses x[i-w+1..i]. The first
 * w-1 positions (incomplete window) are NaN, matching pandas' default. `reduce`
 * receives the finite values in the window.
 */
function rolling(
  v: Value,
  w: number,
  reduce: (window: number[]) => number,
): Value {
  const xs = allElements(v);
  const n = xs.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (i < w - 1) {
      out[i] = NaN;
      continue;
    }
    const win: number[] = [];
    for (let j = i - w + 1; j <= i; j++) {
      if (Number.isFinite(xs[j])) win.push(xs[j]);
    }
    out[i] = reduce(win);
  }
  return out;
}

/** Z-score normalize: (x - mean) / std over finite elements. std 0 -> zeros. */
function normalize(v: Value): Value {
  const finite = finiteElements(v);
  const m = meanFinite(finite);
  const sd = Math.sqrt(varFinite(finite));
  return mapUnary(v, (x) => (sd > 0 ? (x - m) / sd : 0));
}

// ---------------------------------------------------------------------------
// The frozen function table
// ---------------------------------------------------------------------------

export type FnImpl = (args: Value[]) => Value;

/**
 * Whitelist of every callable. The evaluator looks functions up here BY NAME and
 * only here — there is no other reachable call path. Frozen so the table cannot
 * be mutated at runtime.
 */
export const FUNCTIONS: Readonly<Record<string, FnImpl>> = Object.freeze({
  // ---- elementwise (1 arg) ----
  abs: (a) => (exact("abs", a, 1), mapUnary(a[0], Math.abs)),
  sqrt: (a) => (exact("sqrt", a, 1), mapUnary(a[0], Math.sqrt)),
  exp: (a) => (exact("exp", a, 1), mapUnary(a[0], Math.exp)),
  log: (a) => (exact("log", a, 1), mapUnary(a[0], Math.log)),
  log10: (a) => (exact("log10", a, 1), mapUnary(a[0], Math.log10)),
  sin: (a) => (exact("sin", a, 1), mapUnary(a[0], Math.sin)),
  cos: (a) => (exact("cos", a, 1), mapUnary(a[0], Math.cos)),
  tan: (a) => (exact("tan", a, 1), mapUnary(a[0], Math.tan)),
  floor: (a) => (exact("floor", a, 1), mapUnary(a[0], Math.floor)),
  ceil: (a) => (exact("ceil", a, 1), mapUnary(a[0], Math.ceil)),
  // Math.round is half-up; use a symmetric round-half-away-from-zero for sign
  // stability so round(-0.5) === -1 (numpy uses banker's; we keep it simple and
  // documented).
  round: (a) => (exact("round", a, 1), mapUnary(a[0], roundHalfAway)),
  sign: (a) => (exact("sign", a, 1), mapUnary(a[0], Math.sign)),

  // ---- elementwise (multi arg) ----
  clip: (a) => {
    exact("clip", a, 3);
    const [x, lo, hi] = a;
    return mapBinary(mapBinary(x, lo, Math.max), hi, Math.min);
  },
  where: (a) => {
    exact("where", a, 3);
    const [cond, t, f] = a;
    const n = broadcastLength([cond, t, f]);
    if (n === 1 && !isVector(cond) && !isVector(t) && !isVector(f)) {
      return truthy(cond as number) ? (t as number) : (f as number);
    }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = truthy(at(cond, i)) ? at(t, i) : at(f, i);
    return out;
  },
  min: (a) => {
    atLeast("min", a, 2);
    return a.reduce((acc, x) => mapBinary(acc, x, Math.min));
  },
  max: (a) => {
    atLeast("max", a, 2);
    return a.reduce((acc, x) => mapBinary(acc, x, Math.max));
  },

  // ---- reducers -> scalar ----
  mean: (a) => (exact("mean", a, 1), meanFinite(finiteElements(a[0]))),
  std: (a) => (exact("std", a, 1), Math.sqrt(varFinite(finiteElements(a[0])))),
  var: (a) => (exact("var", a, 1), varFinite(finiteElements(a[0]))),
  sum: (a) => (exact("sum", a, 1), sumFinite(finiteElements(a[0]))),
  median: (a) => (exact("median", a, 1), medianFinite(finiteElements(a[0]))),
  amin: (a) => {
    exact("amin", a, 1);
    const xs = finiteElements(a[0]);
    return xs.length === 0 ? NaN : Math.min(...xs);
  },
  amax: (a) => {
    exact("amax", a, 1);
    const xs = finiteElements(a[0]);
    return xs.length === 0 ? NaN : Math.max(...xs);
  },
  count: (a) => (exact("count", a, 1), finiteElements(a[0]).length),

  // ---- windowed ----
  diff: (a) => (exact("diff", a, 1), diff(a[0])),
  cumsum: (a) => (exact("cumsum", a, 1), cumsum(a[0])),
  gradient: (a) => (exact("gradient", a, 1), gradient(a[0])),
  rolling_mean: (a) => {
    exact("rolling_mean", a, 2);
    const w = windowArg("rolling_mean", a[1]);
    return rolling(a[0], w, (win) => (win.length ? meanFinite(win) : NaN));
  },
  rolling_std: (a) => {
    exact("rolling_std", a, 2);
    const w = windowArg("rolling_std", a[1]);
    return rolling(a[0], w, (win) => (win.length ? Math.sqrt(varFinite(win)) : NaN));
  },
  normalize: (a) => (exact("normalize", a, 1), normalize(a[0])),
});

/** Round half away from zero (so -0.5 -> -1, 2.5 -> 3). */
function roundHalfAway(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** Truthiness for `where`/logical ops: finite & non-zero is true. */
export function truthy(x: number): boolean {
  return Number.isFinite(x) && x !== 0;
}

/** Public, sorted list of function names (for the panel cheat-sheet + suggest). */
export const FUNCTION_NAMES: readonly string[] = Object.freeze(
  Object.keys(FUNCTIONS).sort(),
);
