// Function library: every elementwise fn, reducer, and windowed op, plus
// arity/type errors raised through the public evaluator.

import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluate } from "../evaluator";
import type { EvalContext } from "../evaluator";
import { broadcastLength, isVector, type Value } from "../functions";

function run(src: string, ctx: EvalContext): Value {
  const parsed = parse(src);
  if ("error" in parsed) throw new Error(`parse: ${parsed.error.message}`);
  const res = evaluate(parsed.ast, ctx);
  if ("error" in res) throw new Error(`eval: ${res.error.message}`);
  return res.value;
}

function vec(src: string, ctx: EvalContext): number[] {
  const v = run(src, ctx);
  expect(isVector(v)).toBe(true);
  return Array.from(v as Float64Array);
}

function scalar(src: string, ctx: EvalContext): number {
  const v = run(src, ctx);
  expect(isVector(v)).toBe(false);
  return v as number;
}

/** Evaluate expecting a FormulaError of a given kind; return the error. */
function evErr(src: string, ctx: EvalContext) {
  const parsed = parse(src);
  if ("error" in parsed) return parsed.error;
  const res = evaluate(parsed.ast, ctx);
  if ("error" in res) return res.error;
  throw new Error(`expected an error for "${src}"`);
}

const A = [-2, -1, 0, 1, 2];
const ctxA: EvalContext = { channels: { a: A }, length: 5 };

describe("elementwise functions", () => {
  it("abs", () => {
    expect(vec("abs(a)", ctxA)).toEqual([2, 1, 0, 1, 2]);
    expect(scalar("abs(-7)", ctxA)).toBe(7);
  });

  it("sqrt / exp / log / log10", () => {
    expect(scalar("sqrt(9)", ctxA)).toBe(3);
    expect(scalar("exp(0)", ctxA)).toBe(1);
    expect(scalar("log(e)", ctxA)).toBeCloseTo(1);
    expect(scalar("log10(1000)", ctxA)).toBeCloseTo(3);
  });

  it("sin / cos / tan", () => {
    expect(scalar("sin(0)", ctxA)).toBeCloseTo(0);
    expect(scalar("cos(0)", ctxA)).toBeCloseTo(1);
    expect(scalar("tan(0)", ctxA)).toBeCloseTo(0);
  });

  it("floor / ceil / round / sign", () => {
    expect(scalar("floor(2.9)", ctxA)).toBe(2);
    expect(scalar("ceil(2.1)", ctxA)).toBe(3);
    expect(scalar("round(2.5)", ctxA)).toBe(3);
    expect(scalar("round(-0.5)", ctxA)).toBe(-1); // half away from zero
    expect(vec("sign(a)", ctxA)).toEqual([-1, -1, 0, 1, 1]);
  });

  it("clip(x, lo, hi)", () => {
    expect(vec("clip(a, -1, 1)", ctxA)).toEqual([-1, -1, 0, 1, 1]);
    expect(scalar("clip(5, 0, 3)", ctxA)).toBe(3);
  });

  it("where(cond, a, b) selects elementwise", () => {
    expect(vec("where(a > 0, 1, -1)", ctxA)).toEqual([-1, -1, -1, 1, 1]);
    // scalar branches still broadcast against a vector condition
    expect(vec("where(a == 0, 100, a)", ctxA)).toEqual([-2, -1, 100, 1, 2]);
  });

  it("where with all-scalar args returns a scalar", () => {
    expect(scalar("where(1, 7, 9)", ctxA)).toBe(7);
    expect(scalar("where(0, 7, 9)", ctxA)).toBe(9);
  });

  it("min / max take >=2 args and broadcast", () => {
    expect(scalar("min(3, 1, 2)", ctxA)).toBe(1);
    expect(scalar("max(3, 1, 2)", ctxA)).toBe(3);
    expect(vec("max(a, 0)", ctxA)).toEqual([0, 0, 0, 1, 2]);
    expect(vec("min(a, 0)", ctxA)).toEqual([-2, -1, 0, 0, 0]);
  });
});

describe("reducers -> scalar", () => {
  const R = [1, 2, 3, 4, 5];
  const ctx: EvalContext = { channels: { r: R }, length: 5 };

  it("mean / sum / count", () => {
    expect(scalar("mean(r)", ctx)).toBe(3);
    expect(scalar("sum(r)", ctx)).toBe(15);
    expect(scalar("count(r)", ctx)).toBe(5);
  });

  it("median (odd + even)", () => {
    expect(scalar("median(r)", ctx)).toBe(3);
    const ctx4: EvalContext = { channels: { r: [1, 2, 3, 4] }, length: 4 };
    expect(scalar("median(r)", ctx4)).toBe(2.5);
  });

  it("amin / amax", () => {
    expect(scalar("amin(r)", ctx)).toBe(1);
    expect(scalar("amax(r)", ctx)).toBe(5);
  });

  it("var (population, ddof=0) and std", () => {
    // values 1..5: mean 3, var = (4+1+0+1+4)/5 = 2, std = sqrt(2)
    expect(scalar("var(r)", ctx)).toBeCloseTo(2);
    expect(scalar("std(r)", ctx)).toBeCloseTo(Math.sqrt(2));
  });

  it("reducers ignore non-finite values", () => {
    const ctxN: EvalContext = {
      channels: { r: [1, NaN, 3] },
      length: 3,
    };
    expect(scalar("mean(r)", ctxN)).toBe(2);
    expect(scalar("count(r)", ctxN)).toBe(2);
  });

  it("a reducer result broadcasts back over a vector", () => {
    // centering: r - mean(r)
    expect(vec("r - mean(r)", ctx)).toEqual([-2, -1, 0, 1, 2]);
  });
});

describe("windowed functions", () => {
  const W = [1, 3, 6, 10];
  const ctx: EvalContext = { channels: { w: W }, length: 4 };

  it("diff: first NaN, then adjacent differences", () => {
    const out = vec("diff(w)", ctx);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out.slice(1)).toEqual([2, 3, 4]);
  });

  it("cumsum is a running total", () => {
    expect(vec("cumsum(w)", ctx)).toEqual([1, 4, 10, 20]);
  });

  it("gradient: one-sided edges, central interior", () => {
    // w = [1,3,6,10]: edges 2 and 4; interior (6-1)/2=2.5, (10-3)/2=3.5
    expect(vec("gradient(w)", ctx)).toEqual([2, 2.5, 3.5, 4]);
  });

  it("rolling_mean: leading partial windows are NaN", () => {
    const out = vec("rolling_mean(w, 2)", ctx);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out.slice(1)).toEqual([2, 4.5, 8]); // means of [1,3],[3,6],[6,10]
  });

  it("rolling_std window of 2", () => {
    const out = vec("rolling_std(w, 2)", ctx);
    expect(Number.isNaN(out[0])).toBe(true);
    // std of [1,3] (pop) = 1; [3,6] = 1.5; [6,10] = 2
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(1.5);
    expect(out[3]).toBeCloseTo(2);
  });

  it("normalize -> mean 0, std 1", () => {
    const out = vec("normalize(w)", ctx);
    const mean = out.reduce((s, x) => s + x, 0) / out.length;
    const variance =
      out.reduce((s, x) => s + (x - mean) ** 2, 0) / out.length;
    expect(mean).toBeCloseTo(0);
    expect(Math.sqrt(variance)).toBeCloseTo(1);
  });

  it("normalize of a constant series is all zeros (std 0 guard)", () => {
    const ctxC: EvalContext = { channels: { w: [5, 5, 5] }, length: 3 };
    expect(vec("normalize(w)", ctxC)).toEqual([0, 0, 0]);
  });
});

describe("arity + type errors (never throw)", () => {
  it("too few args -> arity error", () => {
    const e = evErr("abs()", ctxA);
    expect(e.kind).toBe("arity");
    expect(e.message).toMatch(/abs\(\) expects 1/);
  });

  it("too many args -> arity error", () => {
    const e = evErr("sqrt(1, 2)", ctxA);
    expect(e.kind).toBe("arity");
  });

  it("min/max need at least 2 args", () => {
    const e = evErr("min(1)", ctxA);
    expect(e.kind).toBe("arity");
    expect(e.message).toMatch(/at least 2/);
  });

  it("rolling window must be a scalar integer", () => {
    const e = evErr("rolling_mean(a, a)", ctxA);
    expect(e.kind).toBe("type");
    expect(e.message).toMatch(/window size/);
  });

  it("rolling window must be positive", () => {
    const e = evErr("rolling_mean(a, 0)", ctxA);
    expect(e.kind).toBe("type");
  });

  it("channels of differing source length pad to N (last index NaN)", () => {
    // Channel vectors are normalized to the context length N, so combining a
    // length-3 and a length-2 channel never errors — the shorter one pads with
    // NaN at the trailing index, which propagates (NaN-safe) through arithmetic.
    const ctx: EvalContext = {
      channels: { p: [1, 2, 3], q: [10, 20] },
      length: 3,
    };
    const out = vec("p + q", ctx);
    expect(out[0]).toBe(11);
    expect(out[1]).toBe(22);
    expect(Number.isNaN(out[2])).toBe(true); // q padded with NaN at index 2
  });

  it("broadcastLength rejects truly mismatched raw vectors", () => {
    // The internal guard fires when two genuinely different-length vectors meet
    // (e.g. a raw Float64Array fed straight in) — exercised via the helper.
    expect(() =>
      broadcastLength([Float64Array.from([1, 2, 3]), Float64Array.from([1, 2])]),
    ).toThrow(/Length mismatch/);
  });

  it("unknown function -> name error with suggestion", () => {
    const e = evErr("sqrtt(4)", ctxA);
    expect(e.kind).toBe("name");
    expect(e.message).toMatch(/Unknown function/);
    expect(e.suggestion).toBe("sqrt");
  });

  it("unknown identifier -> name error with channel suggestion", () => {
    const ctx: EvalContext = { channels: { accX: [1, 2] }, length: 2 };
    const e = evErr("accY", ctx);
    expect(e.kind).toBe("name");
    expect(e.message).toMatch(/Unknown identifier/);
    expect(e.suggestion).toBe("accX");
  });

  it("unknown col(\"...\") -> name error", () => {
    const ctx: EvalContext = { channels: { "Acc X": [1, 2] }, length: 2 };
    const e = evErr('col("Acc Z")', ctx);
    expect(e.kind).toBe("name");
    expect(e.message).toMatch(/Unknown channel/);
  });
});
