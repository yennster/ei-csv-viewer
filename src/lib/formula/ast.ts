// src/lib/formula/ast.ts — AST node types + the constant table.
//
// The formula engine is a hand-written tokenizer + Pratt parser + tree-walking
// evaluator over a numpy-like { number | Float64Array } value type. There is NO
// eval(), Function(), Pyodide or WASM anywhere — the evaluator only ever touches
// a frozen whitelist of pure JS Math helpers, so there is zero reachable path to
// JS globals/prototypes/channel objects beyond their `.values`.
//
// This module is small and dependency-free; it is shared by the parser and the
// evaluator.

/** A discriminated-union AST node produced by the parser. */
export type Node =
  | NumberLit
  | Ident
  | ColRef
  | Unary
  | Binary
  | Logical
  | Compare
  | Call;

/** Numeric literal: 1, 3.14, 1e-3. */
export interface NumberLit {
  type: "NumberLit";
  value: number;
  pos: number;
}

/** Bare identifier: a channel name (simple), a constant (pi/e), or index/t. */
export interface Ident {
  type: "Ident";
  name: string;
  pos: number;
}

/** Explicit channel reference: col("Acc X") — supports any channel name. */
export interface ColRef {
  type: "ColRef";
  name: string;
  pos: number;
}

/** Prefix unary: -x, +x, not x. */
export interface Unary {
  type: "Unary";
  op: "-" | "+" | "not";
  operand: Node;
  pos: number;
}

/** Arithmetic binary: + - * / % **. */
export interface Binary {
  type: "Binary";
  op: "+" | "-" | "*" | "/" | "%" | "**";
  left: Node;
  right: Node;
  pos: number;
}

/** Boolean binary: and / or. */
export interface Logical {
  type: "Logical";
  op: "and" | "or";
  left: Node;
  right: Node;
  pos: number;
}

/** Comparison: < <= > >= == !=. */
export interface Compare {
  type: "Compare";
  op: "<" | "<=" | ">" | ">=" | "==" | "!=";
  left: Node;
  right: Node;
  pos: number;
}

/** Function call: f(arg, ...). */
export interface Call {
  type: "Call";
  name: string;
  args: Node[];
  pos: number;
}

/**
 * Named scalar constants usable as bare identifiers. These are reserved — a
 * channel literally named "pi" would still resolve to Math.PI here, which is
 * the documented behaviour (use col("pi") to reach such a channel).
 */
export const CONSTANTS: Readonly<Record<string, number>> = Object.freeze({
  pi: Math.PI,
  e: Math.E,
  true: 1,
  false: 0,
});
