"use client";

/**
 * formula-panel.tsx — the formula authoring surface.
 *
 * A Python-syntax, numpy-like expression editor with two modes:
 *   - DERIVE : an expression -> a new frozen channel (values + the source string
 *              kept as metadata). "Add channel" calls store.addDerivedChannel.
 *   - FILTER : a boolean expression -> a length-N mask that highlights matching
 *              samples (never deletes rows). "Apply filter" calls
 *              store.setFilterMask; "Clear filter" calls store.clearFilter. When
 *              the matches form a range, an inline "Crop to matches" reuses the
 *              existing crop pipeline (store.cropToSelection).
 *
 * The panel is PURE UI over the engine in `@/lib/formula` + the store. It builds
 * the eval context from the live dataset, evaluates as you type (debounced), and
 * shows an inline error (with a caret position + suggestion) or a small preview
 * (first values for DERIVE; match count + range for FILTER). Nothing here throws:
 * every engine entry point returns an {ok}|{error} union.
 *
 * The store actions it consumes — addDerivedChannel, setFilterMask, clearFilter,
 * cropToSelection — and the ui.filter highlight all live in the real store now.
 */

import * as React from "react";
import { FunctionSquare, Plus, Scissors, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/store";
import type { Channel } from "@/lib/types";
import {
  contextFromChannels,
  derive,
  filter,
  parse,
  FUNCTION_NAMES,
  RESERVED_IDENTIFIERS,
  type FormulaError,
  type FilterSuccess,
} from "@/lib/formula";

type Mode = "derive" | "filter";

/** Small categorized function groups for the cheat-sheet. */
const FN_GROUPS: { title: string; fns: string[] }[] = [
  {
    title: "Elementwise",
    fns: [
      "abs",
      "sqrt",
      "exp",
      "log",
      "log10",
      "sin",
      "cos",
      "tan",
      "floor",
      "ceil",
      "round",
      "sign",
      "clip",
      "where",
      "min",
      "max",
    ],
  },
  {
    title: "Reduce",
    fns: ["mean", "std", "var", "sum", "median", "amin", "amax", "count"],
  },
  {
    title: "Windowed",
    fns: [
      "diff",
      "cumsum",
      "gradient",
      "rolling_mean",
      "rolling_std",
      "normalize",
    ],
  },
];

/** Debounce a value by `ms` so we don't re-evaluate on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function FormulaPanel({ className }: { className?: string }) {
  const dataset = useEditorStore((s) => s.dataset);
  // Narrow selectors so the panel only re-renders on the slices it reads.
  const addDerivedChannel = useEditorStore((s) => s.addDerivedChannel);
  const setFilterMask = useEditorStore((s) => s.setFilterMask);
  const clearFilter = useEditorStore((s) => s.clearFilter);
  const cropToSelection = useEditorStore((s) => s.cropToSelection);
  const activeFilter = useEditorStore((s) => s.ui.filter);
  // Derive + filter are non-destructive analysis (kept in viewer mode), but
  // "Crop to matches" trims the full-resolution dataset (and calls the EI /crop
  // proxy for an Edge Impulse sample) — same data-mutating write-back as the
  // lane crop. Hide it in read-only viewer mode so the formula panel can't be a
  // back door to cropping.
  const readOnly = useEditorStore((s) => s.ui.mode === "viewer");

  const [mode, setMode] = React.useState<Mode>("derive");
  const [expr, setExpr] = React.useState("");
  const [name, setName] = React.useState("");
  const debouncedExpr = useDebounced(expr, 180);

  const channels: Channel[] = dataset?.channels ?? [];
  const time = dataset?.time;

  // Build the evaluation context once per dataset change.
  const ctx = React.useMemo(
    () => contextFromChannels(channels, time),
    // channels identity changes when the dataset changes (store is immutable).
    [channels, time],
  );

  // Live evaluation (debounced). DERIVE -> preview values; FILTER -> mask info.
  const result = React.useMemo<EvalState>(() => {
    const src = debouncedExpr.trim();
    if (src === "") return { kind: "empty" };
    // Cheap parse first for a fast syntax error before evaluating.
    const parsed = parse(src);
    if (!parsed.ok) return { kind: "error", error: parsed.error };

    if (mode === "derive") {
      const d = derive(src, ctx);
      if (!d.ok) return { kind: "error", error: d.error };
      return { kind: "derive", values: d.values, scalar: d.scalar };
    }
    const f = filter(src, ctx);
    if (!f.ok) return { kind: "error", error: f.error };
    return { kind: "filter", filter: f };
  }, [debouncedExpr, mode, ctx]);

  const hasDataset = channels.length > 0;
  const canApply = result.kind === mode; // "derive" | "filter"

  const defaultName = React.useMemo(
    () => suggestChannelName(channels),
    [channels],
  );

  function handleAddChannel() {
    if (result.kind !== "derive") return;
    const finalName = name.trim() || defaultName;
    addDerivedChannel(finalName, expr.trim(), result.values);
    setName("");
  }

  function handleApplyFilter() {
    if (result.kind !== "filter") return;
    setFilterMask({
      expr: expr.trim(),
      mask: result.filter.mask,
      count: result.filter.count,
      total: result.filter.total,
      range: result.filter.range,
    });
  }

  function handleCropToMatches() {
    if (result.kind !== "filter" || !result.filter.range) return;
    void cropToSelection(result.filter.range.start, result.filter.range.end);
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-surface p-3",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <FunctionSquare className="h-4 w-4 text-fg-muted" aria-hidden />
        <span className="text-sm font-semibold tracking-tight">Formula</span>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      {/* expression input */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="formula-expr" className="sr-only">
          {mode === "derive"
            ? "Expression for the new channel"
            : "Boolean filter expression"}
        </label>
        <textarea
          id="formula-expr"
          value={expr}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={2}
          disabled={!hasDataset}
          onChange={(e) => setExpr(e.target.value)}
          placeholder={
            mode === "derive"
              ? 'e.g. sqrt(accX**2 + accY**2 + accZ**2)'
              : "e.g. abs(accX) > 2 and index > 100"
          }
          className={cn(
            "w-full resize-y rounded-md border bg-surface px-3 py-2 font-mono text-sm text-fg",
            "placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2",
            result.kind === "error"
              ? "border-danger focus-visible:ring-danger"
              : "border-border focus-visible:ring-accent",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
        <ResultLine result={result} expr={debouncedExpr} />
      </div>

      {/* derive: optional name + add */}
      {mode === "derive" ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={name}
            disabled={!hasDataset}
            onChange={(e) => setName(e.target.value)}
            placeholder={defaultName}
            aria-label="New channel name"
            className={cn(
              "h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 text-xs text-fg",
              "placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
          <Button
            size="sm"
            onClick={handleAddChannel}
            disabled={!canApply}
            title="Freeze this expression into a new channel"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add channel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={handleApplyFilter}
            disabled={!canApply}
            title="Highlight the samples matching this expression"
          >
            Apply filter
          </Button>
          {!readOnly && result.kind === "filter" && result.filter.range ? (
            <Button
              size="sm"
              variant="outline"
              onClick={handleCropToMatches}
              title="Crop the dataset to the matching range"
            >
              <Scissors className="h-4 w-4" aria-hidden />
              Crop to matches
            </Button>
          ) : null}
          {activeFilter ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => clearFilter()}
              title="Remove the active filter highlight"
            >
              <X className="h-4 w-4" aria-hidden />
              Clear filter
            </Button>
          ) : null}
        </div>
      )}

      {activeFilter ? (
        <p className="rounded bg-surface-2 px-2 py-1 text-[11px] text-fg-muted">
          Active filter:{" "}
          <span className="font-mono text-fg">{activeFilter.expr}</span> —{" "}
          {activeFilter.count}/{activeFilter.total} samples
        </p>
      ) : null}

      <CheatSheet channels={channels} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live result state
// ---------------------------------------------------------------------------

type EvalState =
  | { kind: "empty" }
  | { kind: "error"; error: FormulaError }
  | { kind: "derive"; values: number[]; scalar: boolean }
  | { kind: "filter"; filter: FilterSuccess };

function ResultLine({ result, expr }: { result: EvalState; expr: string }) {
  if (result.kind === "empty") {
    return (
      <p className="text-[11px] text-fg-muted">
        Reference channels by name (or{" "}
        <code className="font-mono">col(&quot;Name&quot;)</code>); use{" "}
        <code className="font-mono">index</code> /{" "}
        <code className="font-mono">t</code> for position/time.
      </p>
    );
  }
  if (result.kind === "error") {
    return (
      <p className="flex flex-col gap-0.5 text-[11px] text-danger">
        <span>{result.error.message}</span>
        {result.error.pos !== undefined ? (
          <Caret source={expr} pos={result.error.pos} />
        ) : null}
      </p>
    );
  }
  if (result.kind === "derive") {
    const preview = result.values
      .slice(0, 6)
      .map((v) => formatNum(v))
      .join(", ");
    return (
      <p className="text-[11px] text-fg-muted">
        {result.scalar ? "Constant " : "Channel "} preview:{" "}
        <span className="font-mono text-fg">
          [{preview}
          {result.values.length > 6 ? ", …" : ""}]
        </span>
      </p>
    );
  }
  // filter
  const f = result.filter;
  return (
    <p className="text-[11px] text-fg-muted">
      <span className="font-mono font-medium text-fg">{f.count}</span> of{" "}
      <span className="font-mono">{f.total}</span> samples match
      {f.range ? (
        <>
          {" "}
          <span className="text-fg-muted">
            (range {f.range.start}–{f.range.end})
          </span>
        </>
      ) : null}
      .
    </p>
  );
}

/** A monospace caret line pointing at the error position in the source. */
function Caret({ source, pos }: { source: string; pos: number }) {
  const clamped = Math.max(0, Math.min(pos, source.length));
  return (
    <span className="font-mono text-fg-muted">
      <span className="whitespace-pre">{source}</span>
      {"\n"}
      <span className="whitespace-pre">{" ".repeat(clamped)}^</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------------

function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  const opts: { key: Mode; label: string; title: string }[] = [
    {
      key: "derive",
      label: "Derive",
      title: "Create a new channel from an expression",
    },
    {
      key: "filter",
      label: "Filter",
      title: "Highlight samples matching a boolean expression",
    },
  ];
  return (
    <div
      className="ml-auto inline-flex overflow-hidden rounded-md border border-border"
      role="group"
      aria-label="Formula mode"
    >
      {opts.map((o, i) => {
        const active = mode === o.key;
        return (
          <button
            key={o.key}
            type="button"
            title={o.title}
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            className={cn(
              "px-2.5 py-1 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
              i > 0 && "border-l border-border",
              active
                ? "bg-accent text-accent-fg"
                : "bg-surface text-fg hover:bg-surface-2",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cheat-sheet (available channels + function reference)
// ---------------------------------------------------------------------------

function CheatSheet({ channels }: { channels: Channel[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] font-medium text-fg-muted hover:text-fg"
        aria-expanded={open}
      >
        {open ? "Hide" : "Show"} channels &amp; functions
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-3">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
              Channels
            </p>
            <div className="flex flex-wrap gap-1">
              {channels.length === 0 ? (
                <span className="text-[11px] text-fg-muted">
                  No channels loaded.
                </span>
              ) : (
                channels.map((c) => (
                  <code
                    key={c.id}
                    title={`Reference: ${refFor(c.name)}`}
                    className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg"
                  >
                    {refFor(c.name)}
                  </code>
                ))
              )}
              {RESERVED_IDENTIFIERS.map((r) => (
                <code
                  key={r}
                  className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted"
                >
                  {r}
                </code>
              ))}
            </div>
          </div>
          {FN_GROUPS.map((g) => (
            <div key={g.title}>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                {g.title}
              </p>
              <div className="flex flex-wrap gap-1">
                {g.fns.map((fn) => (
                  <code
                    key={fn}
                    className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg"
                  >
                    {fn}
                  </code>
                ))}
              </div>
            </div>
          ))}
          <p className="text-[10px] text-fg-muted">
            {FUNCTION_NAMES.length} functions · operators{" "}
            <span className="font-mono">+ - * / % **</span> ·{" "}
            <span className="font-mono">and or not</span> · comparisons.
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A bare name if it's a simple identifier, else the col("...") form. */
function refFor(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `col("${name}")`;
}

/** A non-colliding default name for a derived channel. */
function suggestChannelName(channels: Channel[]): string {
  const taken = new Set(channels.map((c) => c.name));
  for (let i = 1; i < 1000; i++) {
    const candidate = `derived_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return "derived";
}

/** Compact numeric formatting for previews (handles NaN/Inf). */
function formatNum(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "-∞";
  if (Number.isInteger(v)) return String(v);
  return v.toPrecision(4).replace(/\.?0+$/, "");
}
