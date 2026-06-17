// src/lib/formula/tokenizer.ts — hand-written tokenizer for the formula engine.
//
// Lexes a Python-ish expression source into a flat token stream. Every token
// carries its char `pos` so the parser/evaluator can point a caret at errors.
// Never throws — returns { ok:false, error } on a bad character / unterminated
// string. ~150 LOC.

import type { FormulaError } from "./errors";

export type TokenKind =
  | "NUMBER"
  | "IDENT"
  | "STRING"
  | "OP"
  | "PUNC"
  | "KEYWORD"
  | "EOF";

export interface Token {
  kind: TokenKind;
  /** Raw source text of the token (for NUMBER this is the literal). */
  value: string;
  /** Parsed numeric value (NUMBER only). */
  num?: number;
  pos: number;
}

/** Reserved words lexed as KEYWORD rather than IDENT. */
const KEYWORDS = new Set(["and", "or", "not", "true", "false"]);

/**
 * Multi-char operators, longest-first so `**`, `<=`, `>=`, `==`, `!=` win over
 * their single-char prefixes. `**` MUST come before `*`.
 */
const MULTI_OPS = ["**", "<=", ">=", "==", "!="];
const SINGLE_OPS = new Set(["+", "-", "*", "/", "%", "<", ">"]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}
function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

export interface TokenizeOk {
  ok: true;
  tokens: Token[];
}
export interface TokenizeErr {
  ok: false;
  error: FormulaError;
}
export type TokenizeResult = TokenizeOk | TokenizeErr;

export function tokenize(src: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    // Whitespace (incl. newlines/tabs) is insignificant.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // Strings — only valid inside col("..."); double or single quoted.
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i++;
      let str = "";
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === "\\" && i + 1 < n) {
          // Minimal escape support: \" \' \\ \n \t.
          const next = src[i + 1];
          str +=
            next === "n"
              ? "\n"
              : next === "t"
                ? "\t"
                : next; // covers \" \' \\ and any other char
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        str += c;
        i++;
      }
      if (!closed) {
        return tokenizeError("Unterminated string literal.", start);
      }
      tokens.push({ kind: "STRING", value: str, pos: start });
      continue;
    }

    // Numbers: int / float / scientific (1, 3.14, .5, 1e-3, 2.5E10).
    if (isDigit(ch) || (ch === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      while (i < n && isDigit(src[i])) i++;
      if (src[i] === ".") {
        i++;
        while (i < n && isDigit(src[i])) i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j++;
        if (isDigit(src[j] ?? "")) {
          i = j;
          while (i < n && isDigit(src[i])) i++;
        }
      }
      const raw = src.slice(start, i);
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        return tokenizeError(`Invalid number "${raw}".`, start);
      }
      tokens.push({ kind: "NUMBER", value: raw, num, pos: start });
      continue;
    }

    // Identifiers / keywords.
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < n && isIdentPart(src[i])) i++;
      const word = src.slice(start, i);
      tokens.push({
        kind: KEYWORDS.has(word) ? "KEYWORD" : "IDENT",
        value: word,
        pos: start,
      });
      continue;
    }

    // Parentheses + comma are punctuation.
    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ kind: "PUNC", value: ch, pos: i });
      i++;
      continue;
    }

    // Multi-char operators (longest match first).
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ kind: "OP", value: two, pos: i });
      i += 2;
      continue;
    }

    // Bare `=` is reserved-out (assignment is not part of the language).
    if (ch === "=") {
      return tokenizeError(
        'Unexpected "=". Use "==" to compare for equality.',
        i,
      );
    }

    // Single-char operators.
    if (SINGLE_OPS.has(ch)) {
      tokens.push({ kind: "OP", value: ch, pos: i });
      i++;
      continue;
    }

    return tokenizeError(`Unexpected character "${ch}".`, i);
  }

  tokens.push({ kind: "EOF", value: "", pos: n });
  return { ok: true, tokens };
}

function tokenizeError(message: string, pos: number): TokenizeErr {
  return { ok: false, error: { kind: "tokenize", message, pos } };
}
