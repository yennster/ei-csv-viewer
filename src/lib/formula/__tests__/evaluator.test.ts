// Core evaluator + operator semantics: literals, identifiers, broadcasting,
// arithmetic (incl. ** right-assoc and unary minus precedence), comparisons,
// logical ops, constants, index/t, and channel resolution.

import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluate, toColumn, toMask } from "../evaluator";
import type { EvalContext } from "../evaluator";
import { isVector, type Value } from "../functions";

/** Parse + evaluate, asserting success, returning the raw Value. */
function ev(src: string, ctx: EvalContext = { channels: {}, length: 1 }): Value {
  const parsed = parse(src);
  if ("error" in parsed) {
    throw new Error(`parse failed for "${src}": ${parsed.error.message}`);
  }
  const res = evaluate(parsed.ast, ctx);
  if ("error" in res) {
    throw new Error(`eval failed for "${src}": ${res.error.message}`);
  }
  return res.value;
}

/** Evaluate expecting a scalar. */
function scalar(src: string, ctx?: EvalContext): number {
  const v = ev(src, ctx);
  expect(isVector(v)).toBe(false);
  return v as number;
}

/** Evaluate expecting a vector, returned as a plain array. */
function vec(src: string, ctx: EvalContext): number[] {
  const v = ev(src, ctx);
  expect(isVector(v)).toBe(true);
  return Array.from(v as Float64Array);
}

const X = [1, 2, 3, 4];
const Y = [10, 20, 30, 40];
const ctxXY: EvalContext = {
  channels: { x: X, y: Y },
  length: 4,
};

describe("literals + constants", () => {
  it("evaluates a number literal", () => {
    expect(scalar("42")).toBe(42);
    expect(scalar("3.14")).toBeCloseTo(3.14);
    expect(scalar("1e-3")).toBeCloseTo(0.001);
  });

  it("exposes pi and e constants", () => {
    expect(scalar("pi")).toBeCloseTo(Math.PI);
    expect(scalar("e")).toBeCloseTo(Math.E);
  });

  it("treats true/false as 1/0", () => {
    expect(scalar("true")).toBe(1);
    expect(scalar("false")).toBe(0);
  });
});

describe("arithmetic operators", () => {
  it("adds/subtracts/multiplies/divides scalars", () => {
    expect(scalar("2 + 3 * 4")).toBe(14); // precedence
    expect(scalar("(2 + 3) * 4")).toBe(20);
    expect(scalar("10 / 4")).toBe(2.5);
    expect(scalar("7 - 2 - 1")).toBe(4); // left-assoc
  });

  it("modulo is Python-style (sign of divisor)", () => {
    expect(scalar("5 % 3")).toBe(2);
    expect(scalar("-1 % 3")).toBe(2); // python: 2, not -1
    expect(scalar("1 % -3")).toBe(-2);
  });

  it("** is right-associative", () => {
    // 2**3**2 == 2**(3**2) == 2**9 == 512  (NOT (2**3)**2 == 64)
    expect(scalar("2 ** 3 ** 2")).toBe(512);
  });

  it("unary minus binds looser than ** (Python): -2**2 == -4", () => {
    expect(scalar("-2 ** 2")).toBe(-4);
    expect(scalar("(-2) ** 2")).toBe(4);
  });

  it("allows a unary exponent: 2 ** -1 == 0.5", () => {
    expect(scalar("2 ** -1")).toBe(0.5);
  });

  it("chained unary signs", () => {
    expect(scalar("--3")).toBe(3);
    expect(scalar("-+-3")).toBe(3);
  });
});

describe("broadcasting", () => {
  it("scalar op vector -> vector", () => {
    expect(vec("x + 1", ctxXY)).toEqual([2, 3, 4, 5]);
    expect(vec("2 * x", ctxXY)).toEqual([2, 4, 6, 8]);
  });

  it("vector op scalar (other side) -> vector", () => {
    expect(vec("x - 1", ctxXY)).toEqual([0, 1, 2, 3]);
  });

  it("vector op vector elementwise -> vector", () => {
    expect(vec("x + y", ctxXY)).toEqual([11, 22, 33, 44]);
    expect(vec("y / x", ctxXY)).toEqual([10, 10, 10, 10]);
  });

  it("scalar op scalar -> scalar", () => {
    const v = ev("2 + 3", ctxXY);
    expect(isVector(v)).toBe(false);
  });

  it("magnitude expression sqrt(x**2 + y**2)", () => {
    const out = vec("sqrt(x**2 + y**2)", ctxXY);
    expect(out[0]).toBeCloseTo(Math.hypot(1, 10));
    expect(out[3]).toBeCloseTo(Math.hypot(4, 40));
  });
});

describe("comparisons + logical", () => {
  it("comparison yields a 0/1 mask vector", () => {
    expect(vec("x > 2", ctxXY)).toEqual([0, 0, 1, 1]);
    expect(vec("x <= 2", ctxXY)).toEqual([1, 1, 0, 0]);
    expect(vec("x == 3", ctxXY)).toEqual([0, 0, 1, 0]);
    expect(vec("x != 3", ctxXY)).toEqual([1, 1, 0, 1]);
  });

  it("and / or combine masks", () => {
    expect(vec("(x > 1) and (x < 4)", ctxXY)).toEqual([0, 1, 1, 0]);
    expect(vec("(x == 1) or (x == 4)", ctxXY)).toEqual([1, 0, 0, 1]);
  });

  it("not inverts truthiness", () => {
    expect(vec("not (x > 2)", ctxXY)).toEqual([1, 1, 0, 0]);
    expect(scalar("not 0")).toBe(1);
    expect(scalar("not 5")).toBe(0);
  });

  it("rejects chained comparisons instead of silently mis-evaluating", () => {
    // Python's `1 < x < 3` means `(1 < x) and (x < 3)`. A left-assoc binary chain
    // would instead compute `(1 < x) < 3` — a 0/1 mask compared with 3, ALWAYS
    // true — matching every sample. We refuse to parse it and point at `and`.
    const parsed = parse("1 < x < 3");
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error.kind).toBe("parse");
      expect(parsed.error.message).toMatch(/\band\b/);
    }
    // A single comparison still parses fine.
    expect(vec("1 < x", ctxXY)).toEqual([0, 1, 1, 1]);
  });
});

describe("identifiers: channels, index, t", () => {
  it("resolves a bare channel name to its values", () => {
    expect(vec("x", ctxXY)).toEqual([1, 2, 3, 4]);
  });

  it("col(\"...\") resolves names with spaces", () => {
    const ctx: EvalContext = {
      channels: { "Acc X": [5, 6, 7] },
      length: 3,
    };
    expect(vec('col("Acc X")', ctx)).toEqual([5, 6, 7]);
  });

  it("index is 0..N-1", () => {
    expect(vec("index", ctxXY)).toEqual([0, 1, 2, 3]);
  });

  it("t uses the explicit time axis when present", () => {
    const ctx: EvalContext = {
      channels: { x: X },
      length: 4,
      time: [0, 0.5, 1, 1.5],
    };
    expect(vec("t", ctx)).toEqual([0, 0.5, 1, 1.5]);
  });

  it("t falls back to the sample index without a time axis", () => {
    expect(vec("t", ctxXY)).toEqual([0, 1, 2, 3]);
  });
});

describe("materialization helpers", () => {
  it("toColumn broadcasts a scalar to length N", () => {
    expect(toColumn(7, 3)).toEqual([7, 7, 7]);
  });

  it("toColumn passes a vector through (padding short vectors with NaN)", () => {
    expect(toColumn(Float64Array.from([1, 2]), 3)).toEqual([1, 2, NaN]);
  });

  it("toMask treats finite non-zero as true", () => {
    expect(toMask(Float64Array.from([0, 1, 2, NaN]), 4)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("toMask broadcasts a scalar boolean", () => {
    expect(toMask(1, 3)).toEqual([true, true, true]);
    expect(toMask(0, 3)).toEqual([false, false, false]);
  });
});
