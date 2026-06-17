// src/lib/formula/evaluator.ts — the tree-walking, vectorized evaluator.
//
// Walks the parser's AST over a numpy-like Value (scalar `number` | length-N
// `Float64Array`) and returns { value } | { error }. It NEVER throws into React:
// every thrown FnError / unknown-name is caught and turned into a FormulaError
// with the offending node's source position attached.
//
// SAFETY: the evaluator only ever touches
//   - the channel data passed in via EvalContext (read-only number[] per name),
//   - the frozen CONSTANTS table (pi/e/true/false),
//   - the frozen FUNCTIONS whitelist.
// There is no eval(), no Function(), no `globalThis`, no prototype walk, no
// dynamic property access on arbitrary objects. The only identifiers that
// resolve are channel names, the constants, the optional `index`/`t` series, and
// whitelisted function names — anything else is a friendly "unknown identifier"
// error with a Levenshtein suggestion.

import type { Node } from "./ast";
import { CONSTANTS } from "./ast";
import type { FormulaError } from "./errors";
import { err, suggestIdentifier } from "./errors";
import {
  FUNCTIONS,
  FnError,
  type Value,
  at,
  broadcastLength,
  isVector,
  mapBinary,
  mapUnary,
  truthy,
} from "./functions";

/**
 * Read-only evaluation context. `channels` maps a channel NAME to its full-res
 * values; `length` is the canonical sample count N (used to materialize `index`
 * and to size scalar->vector results when a DERIVE needs a full column). `t` is
 * the optional explicit time axis exposed as the bare identifier `t`.
 */
export interface EvalContext {
  /** name -> full-resolution values. Looked up for bare idents and col("..."). */
  channels: Record<string, number[]>;
  /** Sample count N. Defaults to the longest channel when omitted. */
  length?: number;
  /** Optional explicit time axis, exposed as the identifier `t`. */
  time?: number[];
}

export interface EvalOk {
  value: Value;
}
export interface EvalErr {
  error: FormulaError;
}
export type EvalResult = EvalOk | EvalErr;

/** Internal throw carrying a FormulaError + the node position to blame. */
class EvalThrow extends Error {
  readonly fe: FormulaError;
  constructor(fe: FormulaError) {
    super(fe.message);
    this.fe = fe;
  }
}

/**
 * Evaluate an AST against a context. Pure & deterministic. Returns a value union
 * — never throws. Cross-channel length mismatches, unknown names, arity/type
 * errors all come back as a FormulaError.
 */
export function evaluate(node: Node, ctx: EvalContext): EvalResult {
  const ev = new Evaluator(ctx);
  try {
    return { value: ev.eval(node) };
  } catch (e) {
    if (e instanceof EvalThrow) return { error: e.fe };
    // Defensive: never let an unexpected throw escape into React.
    return {
      error: err(
        "runtime",
        e instanceof Error ? e.message : "Could not evaluate the formula.",
      ),
    };
  }
}

class Evaluator {
  private readonly ctx: EvalContext;
  /** Canonical sample count N (longest channel unless overridden). */
  private readonly n: number;
  /** Lazily-materialized `index` series (0..N-1). */
  private indexCache: Float64Array | null = null;

  constructor(ctx: EvalContext) {
    this.ctx = ctx;
    let n = ctx.length ?? 0;
    if (ctx.length === undefined) {
      for (const k of Object.keys(ctx.channels)) {
        n = Math.max(n, ctx.channels[k].length);
      }
      if (ctx.time) n = Math.max(n, ctx.time.length);
    }
    this.n = n;
  }

  eval(node: Node): Value {
    switch (node.type) {
      case "NumberLit":
        return node.value;
      case "Ident":
        return this.resolveIdent(node.name, node.pos);
      case "ColRef":
        return this.resolveChannel(node.name, node.pos);
      case "Unary":
        return this.evalUnary(node);
      case "Binary":
        return this.evalBinary(node);
      case "Logical":
        return this.evalLogical(node);
      case "Compare":
        return this.evalCompare(node);
      case "Call":
        return this.evalCall(node);
      default: {
        // Exhaustiveness guard: `node` is `never` here if the union is covered.
        const _never: never = node;
        void _never;
        throw new EvalThrow(err("runtime", "Unknown node."));
      }
    }
  }

  // ---- identifiers ----

  private resolveIdent(name: string, pos: number): Value {
    // Constants (pi/e/true/false) win over a same-named channel by design; the
    // ast documents that col("pi") reaches such a channel.
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) {
      return CONSTANTS[name];
    }
    if (name === "index") return this.indexSeries();
    if (name === "t") {
      if (this.ctx.time && this.ctx.time.length > 0) {
        return Float64Array.from(this.ctx.time);
      }
      // No explicit time axis -> t falls back to the sample index.
      return this.indexSeries();
    }
    if (Object.prototype.hasOwnProperty.call(this.ctx.channels, name)) {
      return this.channelVector(name);
    }
    // Unknown: suggest the nearest known name (channels + constants + index/t).
    const known = [
      ...Object.keys(this.ctx.channels),
      ...Object.keys(CONSTANTS),
      "index",
      "t",
    ];
    const suggestion = suggestIdentifier(name, known);
    const tail = suggestion ? ` Did you mean "${suggestion}"?` : "";
    throw new EvalThrow(
      err("name", `Unknown identifier "${name}".${tail}`, pos, suggestion),
    );
  }

  private resolveChannel(name: string, pos: number): Value {
    if (Object.prototype.hasOwnProperty.call(this.ctx.channels, name)) {
      return this.channelVector(name);
    }
    const suggestion = suggestIdentifier(name, Object.keys(this.ctx.channels));
    const tail = suggestion ? ` Did you mean col("${suggestion}")?` : "";
    throw new EvalThrow(
      err("name", `Unknown channel "${name}".${tail}`, pos, suggestion),
    );
  }

  private channelVector(name: string): Float64Array {
    const raw = this.ctx.channels[name];
    // Copy into a Float64Array so channel data is never mutated and so all vector
    // values share one type. Pad/truncate to N for clean broadcasting.
    const out = new Float64Array(this.n);
    const m = Math.min(this.n, raw.length);
    for (let i = 0; i < m; i++) out[i] = raw[i];
    for (let i = m; i < this.n; i++) out[i] = NaN;
    return out;
  }

  private indexSeries(): Float64Array {
    if (!this.indexCache) {
      const out = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) out[i] = i;
      this.indexCache = out;
    }
    return this.indexCache;
  }

  // ---- operators ----

  private evalUnary(node: Extract<Node, { type: "Unary" }>): Value {
    const x = this.eval(node.operand);
    switch (node.op) {
      case "-":
        return mapUnary(x, (v) => -v);
      case "+":
        return x;
      case "not":
        return mapUnary(x, (v) => (truthy(v) ? 0 : 1));
    }
  }

  private evalBinary(node: Extract<Node, { type: "Binary" }>): Value {
    const a = this.eval(node.left);
    const b = this.eval(node.right);
    try {
      switch (node.op) {
        case "+":
          return mapBinary(a, b, (x, y) => x + y);
        case "-":
          return mapBinary(a, b, (x, y) => x - y);
        case "*":
          return mapBinary(a, b, (x, y) => x * y);
        case "/":
          return mapBinary(a, b, (x, y) => x / y);
        case "%":
          // Python-style modulo (result takes the sign of the divisor).
          return mapBinary(a, b, pymod);
        case "**":
          return mapBinary(a, b, (x, y) => Math.pow(x, y));
      }
    } catch (e) {
      throw this.wrap(e, node.pos);
    }
  }

  private evalLogical(node: Extract<Node, { type: "Logical" }>): Value {
    const a = this.eval(node.left);
    const b = this.eval(node.right);
    try {
      // Elementwise boolean and/or, yielding a 0/1 mask (numpy logical_*).
      return node.op === "and"
        ? mapBinary(a, b, (x, y) => (truthy(x) && truthy(y) ? 1 : 0))
        : mapBinary(a, b, (x, y) => (truthy(x) || truthy(y) ? 1 : 0));
    } catch (e) {
      throw this.wrap(e, node.pos);
    }
  }

  private evalCompare(node: Extract<Node, { type: "Compare" }>): Value {
    const a = this.eval(node.left);
    const b = this.eval(node.right);
    const cmp = compareOp(node.op);
    try {
      return mapBinary(a, b, (x, y) => (cmp(x, y) ? 1 : 0));
    } catch (e) {
      throw this.wrap(e, node.pos);
    }
  }

  // ---- calls ----

  private evalCall(node: Extract<Node, { type: "Call" }>): Value {
    const impl = Object.prototype.hasOwnProperty.call(FUNCTIONS, node.name)
      ? FUNCTIONS[node.name]
      : undefined;
    if (!impl) {
      const suggestion = suggestIdentifier(node.name, Object.keys(FUNCTIONS));
      const tail = suggestion ? ` Did you mean "${suggestion}"?` : "";
      throw new EvalThrow(
        err(
          "name",
          `Unknown function "${node.name}".${tail}`,
          node.pos,
          suggestion,
        ),
      );
    }
    const args = node.args.map((a) => this.eval(a));
    try {
      // Validate cross-arg vector lengths up-front so the message points at the
      // call (functions also re-check, but this gives a consistent position).
      broadcastLength(args);
      return impl(args);
    } catch (e) {
      throw this.wrap(e, node.pos);
    }
  }

  /** Turn a thrown FnError into a positioned EvalThrow; rethrow EvalThrows. */
  private wrap(e: unknown, pos: number): EvalThrow {
    if (e instanceof EvalThrow) return e;
    if (e instanceof FnError) return new EvalThrow(err(e.kind, e.message, pos));
    return new EvalThrow(
      err("runtime", e instanceof Error ? e.message : "Evaluation error.", pos),
    );
  }
}

/** Python-style modulo: result has the sign of the divisor (a - b*floor(a/b)). */
function pymod(a: number, b: number): number {
  if (b === 0) return NaN;
  const r = a - b * Math.floor(a / b);
  return r;
}

function compareOp(op: string): (x: number, y: number) => boolean {
  switch (op) {
    case "<":
      return (x, y) => x < y;
    case "<=":
      return (x, y) => x <= y;
    case ">":
      return (x, y) => x > y;
    case ">=":
      return (x, y) => x >= y;
    case "==":
      return (x, y) => x === y;
    case "!=":
      return (x, y) => x !== y;
    default:
      return () => false;
  }
}

// ---------------------------------------------------------------------------
// Materialization helpers (used by index.ts to turn a Value into a column/mask)
// ---------------------------------------------------------------------------

/**
 * Expand a Value to a length-N number[] column (a DERIVE result). A scalar is
 * broadcast to every position so a constant expression still yields a full
 * channel.
 */
export function toColumn(value: Value, n: number): number[] {
  const out = new Array<number>(n);
  if (isVector(value)) {
    for (let i = 0; i < n; i++) out[i] = i < value.length ? value[i] : NaN;
  } else {
    for (let i = 0; i < n; i++) out[i] = value;
  }
  return out;
}

/**
 * Expand a Value to a length-N boolean mask (a FILTER result). Truthy = finite &
 * non-zero. A scalar boolean broadcasts to every position.
 */
export function toMask(value: Value, n: number): boolean[] {
  const out = new Array<boolean>(n);
  for (let i = 0; i < n; i++) out[i] = truthy(at(value, i));
  return out;
}
