"use client";

// src/components/labels-panel.tsx — editor for Edge Impulse time-series
// multi-label (structured-labels) segments.
//
// Lists the labeled segments of the current sample, lets the user add a label
// over an inclusive sample-index range (prefilled from a brushed crop selection
// or the full sample), rename / delete segments, fill gaps so the labels span
// the whole sample, validate the Edge Impulse "continuous + non-overlapping"
// contract, and download the structured_labels.labels sidecar. The colored
// bands themselves are drawn over every lane by the charts.

import * as React from "react";
import { Download, Plus, Tag, Trash2, Wand2 } from "lucide-react";
import { useEditorStore, datasetLength } from "@/lib/store";
import { labelColor, validateLabels } from "@/lib/labels";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

function downloadText(filename: string, text: string, type = "application/json") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function LabelsPanel() {
  const dataset = useEditorStore((s) => s.dataset);
  const labels = useEditorStore((s) => s.dataset?.labels ?? null);
  const cropSel = useEditorStore((s) => s.ui.cropSel);
  const readOnly = useEditorStore((s) => s.ui.mode === "viewer");

  const addLabel = useEditorStore((s) => s.addLabel);
  const renameLabel = useEditorStore((s) => s.renameLabel);
  const removeLabel = useEditorStore((s) => s.removeLabel);
  const fillLabelGaps = useEditorStore((s) => s.fillLabelGaps);
  const clearLabels = useEditorStore((s) => s.clearLabels);
  const exportLabels = useEditorStore((s) => s.exportLabels);

  const length = dataset ? datasetLength(dataset) : 0;
  const maxIdx = Math.max(0, length - 1);

  const [name, setName] = React.useState("");
  const [from, setFrom] = React.useState("0");
  const [to, setTo] = React.useState(String(maxIdx));

  // Keep the default range in step with the loaded sample length.
  React.useEffect(() => {
    setFrom("0");
    setTo(String(maxIdx));
  }, [maxIdx]);

  const segments = labels ?? [];
  const validation = React.useMemo(
    () => validateLabels(segments, length),
    [segments, length],
  );

  if (!dataset) return null;

  const useSelection = () => {
    if (!cropSel) return;
    setFrom(String(cropSel.startIdx));
    setTo(String(cropSel.endIdx));
  };

  const onAdd = () => {
    const lo = Math.round(Number(from));
    const hi = Math.round(Number(to));
    const trimmed = name.trim();
    if (!trimmed || !Number.isFinite(lo) || !Number.isFinite(hi)) return;
    addLabel(lo, hi, trimmed);
    setName("");
  };

  const onExport = () => {
    const json = exportLabels();
    if (!json) return;
    downloadText("structured_labels.labels", json);
  };

  return (
    <div className="grid gap-3 text-sm">
      {/* ---- add a label over a range ---- */}
      {!readOnly && (
        <div className="grid gap-2 rounded-md border border-border bg-surface-2/40 p-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-fg-muted">Label</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onAdd();
                }}
                placeholder="e.g. walking"
                className="w-40"
                aria-label="New label name"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-fg-muted">From</span>
              <Input
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                inputMode="numeric"
                className="w-20"
                aria-label="Label start index"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-fg-muted">To</span>
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                inputMode="numeric"
                className="w-20"
                aria-label="Label end index"
              />
            </label>
            <Button size="sm" onClick={onAdd} disabled={!name.trim()}>
              <Plus className="h-4 w-4" /> Add label
            </Button>
            {cropSel ? (
              <Button size="sm" variant="outline" onClick={useSelection}>
                Use selection ({cropSel.startIdx}–{cropSel.endIdx})
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-fg-muted">
            Ranges are inclusive sample indices (0–{maxIdx}). Adding a label
            carves it out of any overlapping segment so labels stay
            non-overlapping. Tip: enable crop mode to brush a range, then “Use
            selection”.
          </p>
        </div>
      )}

      {/* ---- validation summary ---- */}
      {segments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <ValidationBadge ok={validation.nonOverlapping} label="non-overlapping" />
          <ValidationBadge ok={validation.continuous} label="continuous" />
          <ValidationBadge ok={validation.fullLength} label="full length" />
          {validation.gaps.length > 0 && (
            <span className="text-fg-muted">
              {validation.gaps.length} gap
              {validation.gaps.length === 1 ? "" : "s"}
            </span>
          )}
          {!validation.ok && (
            <span className="text-amber-600 dark:text-amber-400">
              Edge Impulse needs continuous, non-overlapping labels over the full
              sample before upload.
            </span>
          )}
        </div>
      )}

      {/* ---- segment list ---- */}
      {segments.length === 0 ? (
        <p className="text-xs text-fg-muted">
          No labels yet. Add a label over a sample range to start segmenting this
          time series.
        </p>
      ) : (
        <ul className="grid gap-1">
          {segments.map((seg, i) => (
            <li
              key={`${seg.startIndex}-${seg.endIndex}-${i}`}
              className="flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5"
            >
              <span
                className="h-3 w-3 shrink-0 rounded-sm"
                style={{ backgroundColor: labelColor(seg.label) }}
                aria-hidden
              />
              {readOnly ? (
                <span className="min-w-0 flex-1 truncate font-medium">
                  {seg.label}
                </span>
              ) : (
                <input
                  defaultValue={seg.label}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== seg.label) renameLabel(i, v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-fg hover:border-border focus-visible:border-accent focus-visible:outline-none"
                  aria-label={`Rename label ${seg.label}`}
                />
              )}
              <span className="shrink-0 font-mono text-[11px] text-fg-muted">
                {seg.startIndex}–{seg.endIndex}
                <span className="ml-1 text-fg-muted/70">
                  ({seg.endIndex - seg.startIndex + 1})
                </span>
              </span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => removeLabel(i)}
                  className="shrink-0 rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  aria-label={`Delete label ${seg.label}`}
                  title="Delete segment"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ---- actions ---- */}
      <div className="flex flex-wrap items-center gap-2">
        {!readOnly && validation.gaps.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => fillLabelGaps("unlabeled")}
            title="Fill uncovered ranges with an 'unlabeled' segment"
          >
            <Wand2 className="h-4 w-4" /> Fill gaps
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={onExport}
          disabled={segments.length === 0}
          title="Download the structured_labels.labels sidecar file"
        >
          <Download className="h-4 w-4" /> Export labels
        </Button>
        {!readOnly && segments.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={clearLabels}
            title="Remove all labels"
          >
            Clear all
          </Button>
        )}
      </div>
    </div>
  );
}

function ValidationBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={
        ok
          ? "inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 font-medium text-green-700 dark:text-green-400"
          : "inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400"
      }
    >
      <Tag className="h-3 w-3" aria-hidden />
      {ok ? label : `not ${label}`}
    </span>
  );
}
