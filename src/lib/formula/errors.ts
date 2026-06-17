// src/lib/formula/errors.ts — the friendly error type + Levenshtein nearest.
//
// Every public entry point of the engine returns an {ok}|{error} union; it NEVER
// throws into React. FormulaError carries enough to render an inline caret.

/** A friendly, non-throwing formula error. */
export interface FormulaError {
  kind: "tokenize" | "parse" | "name" | "arity" | "type" | "runtime";
  /** Friendly message, e.g. `Unknown channel "accX". Did you mean "Acc X"?`. */
  message: string;
  /** Char offset into source (for caret / underline in the panel). */
  pos?: number;
  /** Optional best-match channel/function name. */
  suggestion?: string;
}

/** Small helper to build a FormulaError of a given kind. */
export function err(
  kind: FormulaError["kind"],
  message: string,
  pos?: number,
  suggestion?: string,
): FormulaError {
  return { kind, message, pos, suggestion };
}

/**
 * Classic Levenshtein edit distance (case-insensitive). Used to suggest the
 * nearest known identifier when a name is unknown.
 */
export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

/**
 * Return the nearest candidate to `unknown` by Levenshtein distance, or
 * undefined when nothing is reasonably close. The threshold scales with the
 * length of the unknown token so short typos still match but unrelated names
 * don't produce noise.
 */
export function suggestIdentifier(
  unknown: string,
  available: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const name of available) {
    const d = levenshtein(unknown, name);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  if (best === undefined) return undefined;
  // Allow up to ~half the length (min 2) of the longer string in edits.
  const limit = Math.max(2, Math.ceil(Math.max(unknown.length, best.length) / 2));
  return bestDist <= limit ? best : undefined;
}
