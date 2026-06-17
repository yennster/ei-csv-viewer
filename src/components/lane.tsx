"use client";

/**
 * lane.tsx — one lane row.
 *
 * Layout: a fixed-width left RAIL (editable title, channel chips, y-axis
 * control, lane menu) + a full-width CHART (one <UplotChart>). The WHOLE row
 * (rail + chart) is a single dnd-kit droppable so a channel can be dropped
 * anywhere on the lane, not just the rail.
 *
 * The chart renders only this lane's assigned + visible channels, with its OWN
 * auto-scaled (or manually pinned) y-axis. x is shared and the cursor is
 * synced across lanes via the syncKey.
 */

import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import uPlot from "uplot";
import { Lock, Magnet, MoreVertical, Trash2 } from "lucide-react";
import type { Channel, Lane as LaneModel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { laneAutoRange } from "./lane-autorange";
import { UplotChart, type UplotSeriesSpec, type RangeFn } from "./uplot-chart";
import { ChannelChip, type MoveTarget } from "./channel-chip";

/** Reserved id for the unassigned tray (never a real user lane). */
export const UNASSIGNED_ID = "unassigned";

export interface LaneProps {
  lane: LaneModel;
  /** resolved channels in lane order (membership only; may be hidden) */
  channels: Channel[];
  /** shared x-axis array */
  xs: number[];
  /** shared x-window (null = full extent) */
  xWindow: { min: number; max: number } | null;
  /** synchronized-cursor sample index */
  cursorIdx: number | null;
  /** sync group key shared by all lanes */
  syncKey: string;
  /** crop-drag mode active */
  cropMode: boolean;
  /** current crop selection (sample indices) to paint as a band */
  cropSel?: { startIdx: number; endIdx: number } | null;
  /** active formula filter mask (length-N): shade non-matching regions */
  filterMask?: boolean[] | null;
  /** move targets offered by each chip's kebab menu */
  moveTargets: MoveTarget[];
  /** is this lane the current drop target? */
  isOver: boolean;
  // actions (thin passthroughs to the store)
  onRenameLane: (laneId: string, title: string) => void;
  onRemoveLane: (laneId: string) => void;
  /** matches the store's setLaneYScale signature */
  onSetYScale: (
    laneId: string,
    scale: {
      yAuto: boolean;
      yMin?: number;
      yMax?: number;
      ySymmetric?: boolean;
    },
  ) => void;
  onRenameChannel: (channelId: string, name: string) => void;
  onToggleVisible: (channelId: string) => void;
  onMoveChannel: (channelId: string, targetId: string) => void;
  onReady?: (laneId: string, u: uPlot) => void;
  onDestroyChart?: (laneId: string) => void;
  onZoom?: (window: { min: number; max: number } | null) => void;
  onCursor?: (idx: number | null) => void;
  onCrop?: (sel: { startIdx: number; endIdx: number } | null) => void;
}

export const Lane = React.memo(function Lane({
  lane,
  channels,
  xs,
  xWindow,
  cursorIdx,
  syncKey,
  cropMode,
  cropSel,
  filterMask,
  moveTargets,
  isOver,
  onRenameLane,
  onRemoveLane,
  onSetYScale,
  onRenameChannel,
  onToggleVisible,
  onMoveChannel,
  onReady,
  onDestroyChart,
  onZoom,
  onCursor,
  onCrop,
}: LaneProps) {
  const droppable = useDroppable({
    id: `lane:${lane.id}`,
    data: { type: "lane", laneId: lane.id },
  });

  const visible = React.useMemo(
    () => channels.filter((c) => c.visible),
    [channels],
  );

  const series: UplotSeriesSpec[] = React.useMemo(
    () =>
      visible.map((c) => ({
        id: c.id,
        label: c.name,
        color: c.color,
        values: c.values,
      })),
    [visible],
  );

  // Per-lane y-range fn. AUTO reads the min-max envelope of visible channels
  // within the current x-window (so zooming into a quiet region re-fills the
  // lane). MANUAL pins [yMin,yMax] (optionally symmetric around zero).
  const yRange: RangeFn = React.useCallback(
    (self, _a, _b): [number, number] => {
      if (!lane.yAuto) {
        let lo = lane.yMin ?? 0;
        let hi = lane.yMax ?? 1;
        if (lane.ySymmetric) {
          const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
          lo = -m;
          hi = m;
        }
        if (!(lo < hi)) {
          // invalid manual bounds -> fall back to a unit window around lo
          return [lo - 1, lo + 1];
        }
        return [lo, hi];
      }
      // Re-fit to the data inside the CURRENT x-window so zooming in on time
      // reveals granularity instead of flattening the lines. Read the LIVE
      // x-scale off the chart (the zoom controller sets x before re-ranging y),
      // not the committed `xWindow` prop — which is stale during a gesture and
      // never re-ranges y on its own. Fall back to the prop before the
      // instance's scale exists (initial render).
      const sx = self?.scales?.x;
      const win =
        sx &&
        typeof sx.min === "number" &&
        typeof sx.max === "number" &&
        Number.isFinite(sx.min) &&
        Number.isFinite(sx.max)
          ? { min: sx.min, max: sx.max }
          : xWindow;
      const [lo, hi] = laneAutoRange(visible, xs, win);
      if (lane.ySymmetric) {
        const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
        return [-m, m];
      }
      return [lo, hi];
    },
    [lane.yAuto, lane.yMin, lane.yMax, lane.ySymmetric, visible, xs, xWindow],
  );

  const height = lane.heightPx ?? 160;
  const hasVisible = visible.length > 0;

  const handleReady = React.useCallback(
    (u: uPlot) => onReady?.(lane.id, u),
    [onReady, lane.id],
  );
  const handleDestroy = React.useCallback(
    () => onDestroyChart?.(lane.id),
    [onDestroyChart, lane.id],
  );

  return (
    <div
      ref={droppable.setNodeRef}
      className={cn(
        "grid min-w-0 grid-cols-1 gap-0 border-b border-border md:grid-cols-[var(--rail-w,240px)_1fr]",
        "transition-colors",
        isOver && "bg-accent/5 ring-2 ring-inset ring-accent",
      )}
      style={{ ["--rail-w" as string]: "240px" }}
      data-lane-id={lane.id}
    >
      {/* ---- LEFT RAIL ---- */}
      <div className="flex flex-col gap-2 border-border bg-surface-2/40 p-2 md:border-r">
        <div className="flex items-start gap-1">
          <LaneTitle
            title={lane.title}
            onRename={(t) => onRenameLane(lane.id, t)}
          />
          <YAxisControl lane={lane} onSetYScale={onSetYScale} />
          <LaneMenu laneId={lane.id} onRemove={() => onRemoveLane(lane.id)} />
        </div>

        <div className="flex flex-col gap-1">
          {channels.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-fg-muted">
              Drag a channel here
            </div>
          ) : (
            channels.map((c) => (
              <ChannelChip
                key={c.id}
                channel={c}
                laneId={lane.id}
                cursorValue={
                  cursorIdx != null ? c.values[cursorIdx] : undefined
                }
                moveTargets={moveTargets.filter((t) => t.id !== lane.id)}
                onRename={onRenameChannel}
                onToggleVisible={onToggleVisible}
                onMove={onMoveChannel}
              />
            ))
          )}
        </div>
      </div>

      {/* ---- CHART ---- */}
      <div className="relative min-w-0">
        {hasVisible ? (
          <UplotChart
            xs={xs}
            series={series}
            syncKey={syncKey}
            xWindow={xWindow}
            yRange={yRange}
            showXAxis={false}
            gutterPx={56}
            height={height}
            cropMode={cropMode}
            cropSel={cropSel}
            filterMask={filterMask}
            onReady={handleReady}
            onDestroy={handleDestroy}
            onZoom={onZoom}
            onCursor={onCursor}
            onCrop={onCrop}
          />
        ) : (
          <div
            className="flex items-center justify-center text-xs text-fg-muted"
            style={{ height }}
          >
            No visible channels
          </div>
        )}
      </div>
    </div>
  );
});

/** Inline-editable lane title. */
function LaneTitle({
  title,
  onRename,
}: {
  title: string;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(title);
  const ref = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (editing) {
      setDraft(title);
      requestAnimationFrame(() => ref.current?.select());
    }
  }, [editing, title]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== title) onRename(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        className={cn(
          "h-6 min-w-0 flex-1 rounded border border-border bg-bg px-1 text-xs font-semibold text-fg",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        )}
      />
    );
  }
  return (
    <button
      type="button"
      className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-fg hover:text-accent"
      title="Click to rename lane"
      onClick={() => setEditing(true)}
    >
      {title}
    </button>
  );
}

/** Per-lane y-axis control: auto (magnet) / manual (lock) with a popover. */
function YAxisControl({
  lane,
  onSetYScale,
}: {
  lane: LaneModel;
  onSetYScale: LaneProps["onSetYScale"];
}) {
  const [open, setOpen] = React.useState(false);
  const [min, setMin] = React.useState(String(lane.yMin ?? ""));
  const [max, setMax] = React.useState(String(lane.yMax ?? ""));
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setMin(lane.yMin != null ? String(lane.yMin) : "");
    setMax(lane.yMax != null ? String(lane.yMax) : "");
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, lane.yMin, lane.yMax]);

  const applyManual = () => {
    const lo = Number(min);
    const hi = Number(max);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) {
      onSetYScale(lane.id, {
        yAuto: false,
        yMin: lo,
        yMax: hi,
        ySymmetric: lane.ySymmetric,
      });
    }
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        aria-label={
          lane.yAuto ? "Y-axis: auto (click to configure)" : "Y-axis: manual"
        }
        aria-pressed={!lane.yAuto}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded text-fg-muted",
          "hover:bg-border hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          !lane.yAuto && "text-accent",
        )}
        onClick={() => setOpen((v) => !v)}
      >
        {lane.yAuto ? (
          <Magnet className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Lock className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
      {open ? (
        <div
          className={cn(
            "absolute right-0 z-30 mt-1 w-48 rounded-md border border-border bg-surface p-2 shadow-lg",
          )}
        >
          <div className="mb-2 flex items-center gap-1">
            <button
              type="button"
              className={cn(
                "flex-1 rounded px-2 py-1 text-xs font-medium",
                lane.yAuto
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg hover:bg-border",
              )}
              onClick={() =>
                onSetYScale(lane.id, {
                  yAuto: true,
                  ySymmetric: lane.ySymmetric,
                })
              }
            >
              Auto
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 rounded px-2 py-1 text-xs font-medium",
                !lane.yAuto
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg hover:bg-border",
              )}
              onClick={applyManual}
            >
              Manual
            </button>
          </div>
          <div className="mb-2 flex items-center gap-1">
            <input
              value={min}
              onChange={(e) => setMin(e.target.value)}
              inputMode="decimal"
              placeholder="min"
              className="h-7 w-full rounded border border-border bg-bg px-1 text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
            <input
              value={max}
              onChange={(e) => setMax(e.target.value)}
              inputMode="decimal"
              placeholder="max"
              className="h-7 w-full rounded border border-border bg-bg px-1 text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-fg">
            <input
              type="checkbox"
              checked={!!lane.ySymmetric}
              onChange={(e) =>
                onSetYScale(lane.id, {
                  yAuto: lane.yAuto,
                  yMin: lane.yMin,
                  yMax: lane.yMax,
                  ySymmetric: e.target.checked,
                })
              }
            />
            Symmetric around zero
          </label>
          <button
            type="button"
            className="mt-2 w-full rounded bg-surface-2 px-2 py-1 text-xs font-medium text-fg hover:bg-border"
            onClick={applyManual}
          >
            Fit / apply
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Lane "⋯" menu — currently remove; extendable for duplicate/clear. */
function LaneMenu({
  laneId,
  onRemove,
}: {
  laneId: string;
  onRemove: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        aria-label="Lane options"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded text-fg-muted",
          "hover:bg-border hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
        onClick={() => setOpen((v) => !v)}
        data-lane-menu={laneId}
      >
        <MoreVertical className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 min-w-36 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-danger hover:bg-surface-2"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Remove lane
          </button>
        </div>
      ) : null}
    </div>
  );
}
