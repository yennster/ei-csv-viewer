// Public entrypoint: parse/evaluateFormula/derive/filter, the context builder,
// the DERIVE+FILTER round-trip, and safety guarantees (no global/eval reach,
// never throws).

import { describe, it, expect } from "vitest";
import type { Channel } from "@/lib/types";
import {
  parse,
  evaluateFormula,
  derive,
  filter,
  contextFromChannels,
  FUNCTION_NAMES,
  RESERVED_IDENTIFIERS,
} from "../index";

/** Minimal channels for context building. */
function ch(name: string, values: number[]): Pick<Channel, "name" | "values"> {
  return { name, values };
}

const accX = ch("Acc X", [1, -2, 3, -4, 5]);
const accY = ch("Acc Y", [0, 0, 6, 0, 0]);
const ctx = contextFromChannels([accX, accY]);

describe("parse", () => {
  it("returns ok + ast for a valid expression", () => {
    const r = parse("accX + 1");
    expect(r.ok).toBe(true);
  });

  it("empty source is a friendly error, not a throw", () => {
    const r = parse("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/Enter an expression/);
  });

  it("a syntax error comes back as a parse FormulaError", () => {
    const r = parse("1 +");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("parse");
  });
});

describe("contextFromChannels", () => {
  it("maps names verbatim and derives N from the longest channel", () => {
    const c = contextFromChannels([ch("a", [1, 2, 3]), ch("b", [1])]);
    expect(c.length).toBe(3);
    expect(c.channels["a"]).toEqual([1, 2, 3]);
  });

  it("exposes a passed time axis", () => {
    const c = contextFromChannels([ch("a", [1, 2])], [0, 0.1]);
    expect(c.time).toEqual([0, 0.1]);
  });
});

describe("evaluateFormula", () => {
  it("evaluates against named channels (with spaces via col)", () => {
    const r = evaluateFormula('col("Acc X") * 2', ctx);
    expect(r.ok).toBe(true);
    if (r.ok && r.value instanceof Float64Array) {
      expect(Array.from(r.value)).toEqual([2, -4, 6, -8, 10]);
    }
  });
});

describe("DERIVE mode", () => {
  it("derives a length-N magnitude column", () => {
    const r = derive('sqrt(col("Acc X")**2 + col("Acc Y")**2)', ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.values).toHaveLength(5);
      expect(r.values[2]).toBeCloseTo(Math.hypot(3, 6));
      expect(r.scalar).toBe(false);
    }
  });

  it("a scalar expression broadcasts to a full column", () => {
    const r = derive("mean(col(\"Acc X\"))", ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.values).toHaveLength(5);
      const m = (1 - 2 + 3 - 4 + 5) / 5;
      expect(r.values.every((v) => v === m)).toBe(true);
      expect(r.scalar).toBe(true);
    }
  });

  it("a derive error surfaces as a FormulaError, not a throw", () => {
    const r = derive("nope(1)", ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("name");
  });
});

describe("FILTER mode", () => {
  it("produces a boolean mask + count + matching range", () => {
    const r = filter('col("Acc X") > 0', ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mask).toEqual([true, false, true, false, true]);
      expect(r.count).toBe(3);
      expect(r.total).toBe(5);
      expect(r.range).toEqual({ start: 0, end: 4 });
    }
  });

  it("a contiguous match has a tight range", () => {
    const r = filter('col("Acc Y") > 0', ctx); // only index 2
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.count).toBe(1);
      expect(r.range).toEqual({ start: 2, end: 2 });
    }
  });

  it("no match -> count 0, null range, never deletes anything", () => {
    const r = filter('col("Acc X") > 1000', ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.count).toBe(0);
      expect(r.range).toBeNull();
      expect(r.mask).toHaveLength(5);
    }
  });

  it("a scalar boolean broadcasts across all samples", () => {
    const r = filter("mean(col(\"Acc X\")) > 0", ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.count).toBe(5); // mean is 0.6 > 0 -> every sample matches
    }
  });
});

describe("DERIVE + FILTER round-trip", () => {
  it("derive a magnitude, then filter on it via a fresh channel", () => {
    // 1. DERIVE: magnitude of (Acc X, Acc Y).
    const d = derive('sqrt(col("Acc X")**2 + col("Acc Y")**2)', ctx);
    expect(d.ok).toBe(true);
    if (!d.ok) return;

    // 2. The store would freeze d.values into a new channel named "mag".
    const ctx2 = contextFromChannels([accX, accY, ch("mag", d.values)]);

    // 3. FILTER on the derived channel — referencing it by bare name.
    const f = filter("mag > 4", ctx2);
    expect(f.ok).toBe(true);
    if (!f.ok) return;

    // Recompute the expected mask independently.
    const expected = d.values.map((v) => v > 4);
    expect(f.mask).toEqual(expected);
    expect(f.count).toBe(expected.filter(Boolean).length);
  });
});

describe("public metadata", () => {
  it("exposes a sorted function-name list", () => {
    expect(FUNCTION_NAMES).toContain("rolling_mean");
    expect(FUNCTION_NAMES).toContain("clip");
    const sorted = [...FUNCTION_NAMES].sort();
    expect(FUNCTION_NAMES).toEqual(sorted);
  });

  it("exposes the reserved identifiers", () => {
    expect(RESERVED_IDENTIFIERS).toContain("pi");
    expect(RESERVED_IDENTIFIERS).toContain("index");
    expect(RESERVED_IDENTIFIERS).toContain("t");
  });
});

describe("safety: pure, deterministic, whitelist-only", () => {
  it("cannot reach JS globals/builtins as identifiers", () => {
    for (const name of [
      "globalThis",
      "window",
      "process",
      "constructor",
      "__proto__",
      "Math",
      "eval",
      "Function",
    ]) {
      const r = evaluateFormula(name, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("name");
    }
  });

  it("cannot call non-whitelisted functions", () => {
    for (const name of ["alert", "fetch", "require", "constructor"]) {
      const r = evaluateFormula(`${name}(1)`, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("name");
    }
  });

  it("is deterministic: same input -> same output", () => {
    const a = derive("normalize(col(\"Acc X\")) + index", ctx);
    const b = derive("normalize(col(\"Acc X\")) + index", ctx);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.values).toEqual(b.values);
  });

  it("does not mutate the input channel arrays", () => {
    const before = [...accX.values];
    derive('col("Acc X") * 999 + cumsum(col("Acc X"))', ctx);
    expect(accX.values).toEqual(before);
  });

  it("never throws on garbage input", () => {
    for (const bad of ["", "((", ")", "1 2 3", "@#$", "a +", "col(", "** 2"]) {
      expect(() => evaluateFormula(bad, ctx)).not.toThrow();
      const r = evaluateFormula(bad, ctx);
      expect(r.ok).toBe(false);
    }
  });
});
