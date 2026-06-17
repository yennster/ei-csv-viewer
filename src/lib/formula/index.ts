// src/lib/formula/index.ts — the public entrypoint of the formula engine.
//
// Re-exports the parser/evaluator behind a small, panel-friendly API. The UI and
// store only ever import from here, never from the internal tokenizer/parser/
// evaluator modules.
//
// Pipeline (all pure, deterministic, non-throwing):
//   source string
//     -> parse()          tokenize + parse -> AST | FormulaError
//     -> evaluateFormula() AST + channels  -> Value | FormulaError
//     -> derive()/filter() Value           -> length-N column | boolean mask
//
// Two result modes:
//   - DERIVE  : any expression -> a length-N number[] -> a NEW frozen channel
//               (the store stores the values + the source expression as metadata).
//   - FILTER  : a boolean expression -> a length-N boolean mask + a match count
//               + the matching index range to offer a crop-to-matching.
//
// SAFETY: pure, deterministic, whitelist-only. No eval/Function/global access.
// Every entry point returns an {ok}|{error} union and never throws into React.

import type { Channel } from "@/lib/types";
import type { Node } from "./ast";
import { CONSTANTS } from "./ast";
import type { FormulaError } from "./errors";
import { parse as parseInternal } from "./parser";
import {
  evaluate as evaluateAst,
  toColumn,
  toMask,
  type EvalContext,
} from "./evaluator";
import { isVector, type Value } from "./functions";

// Re-export the public types + cheat-sheet data for the panel.
export type { FormulaError } from "./errors";
export type { Value } from "./functions";
export { FUNCTION_NAMES } from "./functions";

/** The reserved bare identifiers usable in any formula (besides channels). */
export const RESERVED_IDENTIFIERS: readonly string[] = Object.freeze([
  ...Object.keys(CONSTANTS),
  "index",
  "t",
]);

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

export interface ParseSuccess {
  ok: true;
  ast: Node;
}
export interface ParseFailure {
  ok: false;
  error: FormulaError;
}
export type ParseOutcome = ParseSuccess | ParseFailure;

/** Parse a source string into an AST. Never throws. */
export function parse(source: string): ParseOutcome {
  const trimmed = source.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: { kind: "parse", message: "Enter an expression." },
    };
  }
  const res = parseInternal(source);
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, ast: res.ast };
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

/**
 * Build an EvalContext from a list of channels (name -> values). Names are taken
 * verbatim; a later duplicate name shadows an earlier one (last wins), which is
 * the same behaviour as referencing `col("Name")` for a duplicated header.
 * `time` is exposed as the bare identifier `t`.
 */
export function contextFromChannels(
  channels: Pick<Channel, "name" | "values">[],
  time?: number[],
): EvalContext {
  const map: Record<string, number[]> = {};
  let length = time?.length ?? 0;
  for (const ch of channels) {
    map[ch.name] = ch.values;
    if (ch.values.length > length) length = ch.values.length;
  }
  return { channels: map, length, time };
}

// ---------------------------------------------------------------------------
// evaluate (raw value)
// ---------------------------------------------------------------------------

export interface EvaluateSuccess {
  ok: true;
  value: Value;
}
export interface EvaluateFailure {
  ok: false;
  error: FormulaError;
}
export type EvaluateOutcome = EvaluateSuccess | EvaluateFailure;

/** Parse + evaluate a source string against a context. Never throws. */
export function evaluateFormula(
  source: string,
  ctx: EvalContext,
): EvaluateOutcome {
  const parsed = parse(source);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return evaluateNode(parsed.ast, ctx);
}

/** Evaluate an already-parsed AST against a context. Never throws. */
export function evaluateNode(node: Node, ctx: EvalContext): EvaluateOutcome {
  const res = evaluateAst(node, ctx);
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, value: res.value };
}

// ---------------------------------------------------------------------------
// DERIVE — expression -> a length-N column for a new channel
// ---------------------------------------------------------------------------

export interface DeriveSuccess {
  ok: true;
  /** Length-N column (full resolution); ready to freeze into a Channel. */
  values: number[];
  /** True when the source evaluated to a single scalar (broadcast to N). */
  scalar: boolean;
}
export type DeriveOutcome = DeriveSuccess | ParseFailure;

/**
 * DERIVE mode: evaluate a source string to a length-N column. A scalar result is
 * broadcast to every position so a constant expression still produces a full
 * channel. The caller (store.addDerivedChannel) freezes `values` into a new
 * Channel and records the source string as metadata.
 */
export function derive(source: string, ctx: EvalContext): DeriveOutcome {
  const res = evaluateFormula(source, ctx);
  if (!res.ok) return { ok: false, error: res.error };
  const n = lengthOfContext(ctx);
  return {
    ok: true,
    values: toColumn(res.value, n),
    scalar: !isVector(res.value),
  };
}

// ---------------------------------------------------------------------------
// FILTER — boolean expression -> a length-N mask + match metadata
// ---------------------------------------------------------------------------

export interface FilterSuccess {
  ok: true;
  /** Length-N boolean mask: true where the predicate held. */
  mask: boolean[];
  /** Number of matching samples. */
  count: number;
  /** Total samples (N). */
  total: number;
  /** Inclusive [first,last] matching index, or null when nothing matched. */
  range: { start: number; end: number } | null;
}
export type FilterOutcome = FilterSuccess | ParseFailure;

/**
 * FILTER mode: evaluate a boolean source string to a length-N mask. A scalar
 * boolean (e.g. `mean(x) > 0`) broadcasts to every sample. Never deletes rows —
 * the caller highlights matches and may offer crop-to-matching using `range`.
 */
export function filter(source: string, ctx: EvalContext): FilterOutcome {
  const res = evaluateFormula(source, ctx);
  if (!res.ok) return { ok: false, error: res.error };
  const n = lengthOfContext(ctx);
  const mask = toMask(res.value, n);

  let count = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      count++;
      if (start === -1) start = i;
      end = i;
    }
  }
  return {
    ok: true,
    mask,
    count,
    total: n,
    range: start === -1 ? null : { start, end },
  };
}

/** Canonical N for a context (explicit length, else longest channel/time). */
function lengthOfContext(ctx: EvalContext): number {
  if (ctx.length !== undefined) return ctx.length;
  let n = ctx.time?.length ?? 0;
  for (const k of Object.keys(ctx.channels)) {
    n = Math.max(n, ctx.channels[k].length);
  }
  return n;
}
