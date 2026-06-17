// src/lib/formula/parser.ts — Pratt / precedence-climbing parser.
//
// Consumes the token stream from tokenizer.ts and produces a typed Node AST
// (ast.ts). Never throws — returns { ast } | { error } where error.kind is
// "parse". Precedence (low -> high), matching Python:
//
//   or
//   and
//   not                      (prefix)
//   comparison  < <= > >= == != (single comparison; CHAINING is REJECTED — unlike
//                             Python's `a < b < c`. A second comparison operator
//                             after a comparison throws a friendly ParseError that
//                             points to `and`, rather than silently evaluating the
//                             wrong `(a < b) < c` mask. Write `a < b and b < c`.)
//   +  -                     (binary)
//   *  /  %                  (binary)
//   unary +  -               (prefix)
//   **                       (RIGHT-associative, binds TIGHTER than unary minus,
//                             so  -2**2 == -(2**2) == -4)
//   call / atom              (number, constant, identifier, col("name"),
//                             parenthesized expr, function call f(args...))

import type { FormulaError } from "./errors";
import type { Node } from "./ast";
import { tokenize, type Token } from "./tokenizer";

export interface ParseOk {
  ast: Node;
}
export interface ParseErr {
  error: FormulaError;
}
export type ParseResult = ParseOk | ParseErr;

class ParseError extends Error {
  readonly fe: FormulaError;
  constructor(message: string, pos: number) {
    super(message);
    this.fe = { kind: "parse", message, pos };
  }
}

export function parse(src: string): ParseResult {
  const lexed = tokenize(src);
  if (!lexed.ok) return { error: lexed.error };
  try {
    const p = new Parser(lexed.tokens);
    const ast = p.parseExpression();
    p.expectEof();
    return { ast };
  } catch (e) {
    if (e instanceof ParseError) return { error: e.fe };
    // Defensive: never let an unexpected throw escape into React.
    return {
      error: {
        kind: "parse",
        message: e instanceof Error ? e.message : "Could not parse the formula.",
      },
    };
  }
}

class Parser {
  private readonly tokens: Token[];
  private i = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.i];
  }
  private next(): Token {
    return this.tokens[this.i++];
  }
  private atEof(): boolean {
    return this.peek().kind === "EOF";
  }

  expectEof(): void {
    if (!this.atEof()) {
      const t = this.peek();
      throw new ParseError(
        `Unexpected ${describe(t)} after the expression.`,
        t.pos,
      );
    }
  }

  // ---- precedence ladder ----

  parseExpression(): Node {
    return this.parseOr();
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.isKeyword("or")) {
      const op = this.next();
      const right = this.parseAnd();
      left = { type: "Logical", op: "or", left, right, pos: op.pos };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.isKeyword("and")) {
      const op = this.next();
      const right = this.parseNot();
      left = { type: "Logical", op: "and", left, right, pos: op.pos };
    }
    return left;
  }

  private parseNot(): Node {
    if (this.isKeyword("not")) {
      const op = this.next();
      const operand = this.parseNot();
      return { type: "Unary", op: "not", operand, pos: op.pos };
    }
    return this.parseComparison();
  }

  // A SINGLE comparison only. Python allows chaining (`0.5 < x < 2` means
  // `(0.5 < x) and (x < 2)`), but this engine does NOT desugar that — a left-assoc
  // chain would silently produce `(0.5 < x) < 2`, a 0/1 mask compared with 2 which
  // is ALWAYS true. That is a silent wrong answer (a band-pass filter matching the
  // whole recording), the most dangerous failure for an analysis tool. So if a
  // second comparison operator follows, throw a friendly error pointing to `and`.
  private parseComparison(): Node {
    const left = this.parseAdditive();
    if (!this.isCompareOp()) return left;
    const op = this.next();
    const right = this.parseAdditive();
    const cmp: Node = {
      type: "Compare",
      op: op.value as "<" | "<=" | ">" | ">=" | "==" | "!=",
      left,
      right,
      pos: op.pos,
    };
    if (this.isCompareOp()) {
      const t = this.peek();
      throw new ParseError(
        `Chained comparisons aren't supported. Write "a < b and b < c" instead of "a < b < c".`,
        t.pos,
      );
    }
    return cmp;
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next();
      const right = this.parseMultiplicative();
      left = {
        type: "Binary",
        op: op.value as "+" | "-",
        left,
        right,
        pos: op.pos,
      };
    }
    return left;
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.next();
      const right = this.parseUnary();
      left = {
        type: "Binary",
        op: op.value as "*" | "/" | "%",
        left,
        right,
        pos: op.pos,
      };
    }
    return left;
  }

  // unary +/- binds LOOSER than ** (Python semantics): -2**2 parses as
  // -(2**2). We achieve this by having unary recurse into the power parser,
  // whose base is a unary again (so 2 ** -3 still works).
  private parseUnary(): Node {
    if (this.isOp("-") || this.isOp("+")) {
      const op = this.next();
      const operand = this.parseUnary();
      return {
        type: "Unary",
        op: op.value as "-" | "+",
        operand,
        pos: op.pos,
      };
    }
    return this.parsePower();
  }

  // ** is RIGHT-associative: 2**3**2 == 2**(3**2). The right operand is a unary
  // so 2 ** -3 is valid; the left operand is a postfix atom (call/atom).
  private parsePower(): Node {
    const base = this.parsePostfix();
    if (this.isOp("**")) {
      const op = this.next();
      const exponent = this.parseUnary(); // right-assoc + allows unary exponent
      return {
        type: "Binary",
        op: "**",
        left: base,
        right: exponent,
        pos: op.pos,
      };
    }
    return base;
  }

  // An atom optionally followed by a call argument list: ident(args...).
  private parsePostfix(): Node {
    const atom = this.parseAtom();
    // Only bare identifiers can be called (f(...)). col("x")(...) is invalid.
    if (atom.type === "Ident" && this.isPunc("(")) {
      const open = this.next(); // (
      const args = this.parseArgs();
      this.expectPunc(")");
      return { type: "Call", name: atom.name, args, pos: open.pos };
    }
    return atom;
  }

  private parseArgs(): Node[] {
    const args: Node[] = [];
    if (this.isPunc(")")) return args; // empty arg list
    args.push(this.parseExpression());
    while (this.isPunc(",")) {
      this.next();
      // trailing comma -> error on the close paren below
      args.push(this.parseExpression());
    }
    return args;
  }

  private parseAtom(): Node {
    const t = this.peek();

    // number literal
    if (t.kind === "NUMBER") {
      this.next();
      return { type: "NumberLit", value: t.num ?? Number(t.value), pos: t.pos };
    }

    // true / false keyword constants (lexed as KEYWORD)
    if (t.kind === "KEYWORD" && (t.value === "true" || t.value === "false")) {
      this.next();
      return {
        type: "NumberLit",
        value: t.value === "true" ? 1 : 0,
        pos: t.pos,
      };
    }

    // parenthesized expression
    if (this.isPunc("(")) {
      this.next();
      const inner = this.parseExpression();
      this.expectPunc(")");
      return inner;
    }

    // identifier — could be col("...") (handled specially) or a bare ident.
    if (t.kind === "IDENT") {
      this.next();
      if (t.value === "col" && this.isPunc("(")) {
        this.next(); // (
        const arg = this.peek();
        if (arg.kind !== "STRING") {
          throw new ParseError(
            'col() expects a quoted channel name, e.g. col("Acc X").',
            arg.pos,
          );
        }
        this.next(); // string
        this.expectPunc(")");
        return { type: "ColRef", name: arg.value, pos: t.pos };
      }
      return { type: "Ident", name: t.value, pos: t.pos };
    }

    // a stray string outside col("...") is a parse error
    if (t.kind === "STRING") {
      throw new ParseError(
        'Unexpected string literal. Strings are only valid inside col("...").',
        t.pos,
      );
    }

    if (t.kind === "EOF") {
      throw new ParseError("Unexpected end of expression.", t.pos);
    }

    throw new ParseError(`Unexpected ${describe(t)}.`, t.pos);
  }

  // ---- token predicates ----

  private isKeyword(word: string): boolean {
    const t = this.peek();
    return t.kind === "KEYWORD" && t.value === word;
  }
  private isOp(op: string): boolean {
    const t = this.peek();
    return t.kind === "OP" && t.value === op;
  }
  private isCompareOp(): boolean {
    const t = this.peek();
    return (
      t.kind === "OP" &&
      (t.value === "<" ||
        t.value === "<=" ||
        t.value === ">" ||
        t.value === ">=" ||
        t.value === "==" ||
        t.value === "!=")
    );
  }
  private isPunc(p: string): boolean {
    const t = this.peek();
    return t.kind === "PUNC" && t.value === p;
  }
  private expectPunc(p: string): void {
    if (!this.isPunc(p)) {
      const t = this.peek();
      throw new ParseError(`Expected "${p}" but found ${describe(t)}.`, t.pos);
    }
    this.next();
  }
}

/** Friendly description of an unexpected token. */
function describe(t: Token): string {
  if (t.kind === "EOF") return "the end of the expression";
  if (t.kind === "STRING") return `string "${t.value}"`;
  return `"${t.value}"`;
}
