"use client";

/**
 * lane-toolbar.tsx — lane membership presets + lane management.
 *
 * Buttons:
 *  - Auto group        -> magnitude bucketing (the headline grouping action)
 *  - One lane per ch.   -> every channel in its own lane
 *  - Single lane        -> all channels in one lane (the honest EI baseline)
 *  - Add lane           -> a new empty lane to pre-stage as a drop target
 *  - Crop toggle        -> switch lane drags from zoom to crop-band select
 *
 * It reads `preset`/`cropMode` from the store and dispatches store actions.
 * Grouping itself is performed by the store (which calls the @/lib/timeseries
 * helpers); the toolbar only triggers it.
 */

import * as React from "react";
import {
  Crop,
  LayoutGrid,
  Plus,
  Rows3,
  Sparkles,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { UrlPreset } from "@/lib/types";

export interface LaneToolbarProps {
  /** active preset; "custom" once the user drags */
  preset: UrlPreset;
  /** crop-drag mode active */
  cropMode: boolean;
  /** number of lanes (to disable add when there is no dataset) */
  hasDataset: boolean;
  onApplyAutoGroup: () => void;
  onApplyPreset: (
    preset: "one-per-channel" | "all-in-one" | "auto-group",
  ) => void;
  onAddLane: () => void;
  onToggleCrop: () => void;
  /** optional embed flag: still render (core interaction), just compact */
  embed?: boolean;
  /** read-only viewer mode: hide the crop (data-mutating) toggle */
  readOnly?: boolean;
  className?: string;
}

interface PresetDef {
  key: UrlPreset;
  label: string;
  title: string;
  icon: React.ReactNode;
  run: (p: LaneToolbarProps) => void;
}

const PRESETS: PresetDef[] = [
  {
    key: "auto",
    label: "Auto group",
    title: "Group channels by order-of-magnitude of their value range",
    icon: <Sparkles className="h-4 w-4" aria-hidden />,
    run: (p) => p.onApplyAutoGroup(),
  },
  {
    key: "one",
    label: "One per lane",
    title: "One lane per channel",
    icon: <Rows3 className="h-4 w-4" aria-hidden />,
    run: (p) => p.onApplyPreset("one-per-channel"),
  },
  {
    key: "all",
    label: "Single lane",
    title: "All channels in one lane (reproduces the shared-axis problem)",
    icon: <LayoutGrid className="h-4 w-4" aria-hidden />,
    run: (p) => p.onApplyPreset("all-in-one"),
  },
];

export function LaneToolbar(props: LaneToolbarProps) {
  const {
    preset,
    cropMode,
    hasDataset,
    onAddLane,
    onToggleCrop,
    embed = false,
    readOnly = false,
    className,
  } = props;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2",
        className,
      )}
      role="toolbar"
      aria-label="Lane layout"
    >
      {/* segmented preset control */}
      <div
        className="inline-flex overflow-hidden rounded-md border border-border"
        role="group"
        aria-label="Lane presets"
      >
        {PRESETS.map((p, i) => {
          const active = preset === p.key;
          return (
            <button
              key={p.key}
              type="button"
              title={p.title}
              aria-pressed={active}
              disabled={!hasDataset}
              onClick={() => p.run(props)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                "disabled:cursor-not-allowed disabled:opacity-50",
                i > 0 && "border-l border-border",
                active
                  ? "bg-accent text-accent-fg"
                  : "bg-surface text-fg hover:bg-surface-2",
              )}
            >
              {p.icon}
              {!embed && <span>{p.label}</span>}
            </button>
          );
        })}
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={onAddLane}
        disabled={!hasDataset}
        title="Add an empty lane"
      >
        <Plus className="h-4 w-4" aria-hidden />
        {!embed && "Add lane"}
      </Button>

      {!readOnly && (
        <Button
          variant={cropMode ? "primary" : "outline"}
          size="sm"
          onClick={onToggleCrop}
          disabled={!hasDataset}
          aria-pressed={cropMode}
          title="Drag on a lane to select a crop range"
        >
          {cropMode ? (
            <Square className="h-4 w-4" aria-hidden />
          ) : (
            <Crop className="h-4 w-4" aria-hidden />
          )}
          {!embed && (cropMode ? "Cropping" : "Crop")}
        </Button>
      )}

      {preset === "custom" && !embed ? (
        <span className="ml-1 rounded bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
          Custom layout
        </span>
      ) : null}
    </div>
  );
}
