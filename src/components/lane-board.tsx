"use client";

/**
 * lane-board.tsx — THE CENTERPIECE.
 *
 * A vertically-scrolling board of full-width lane rows that all share ONE
 * x-axis and ONE synchronized uPlot crosshair, while each lane keeps its OWN
 * auto-scaled y-axis. The whole board is a single <DndContext>; channels are
 * dragged between lanes, into a "+ new lane" drop target, or back to a reserved
 * "Unassigned" tray. This drag-between-lanes interaction is the whole product.
 *
 * Store contract (`@/lib/store` -> useEditorStore): action names are BINDING:
 * moveChannelToLane, createLaneWithChannel, removeLane, renameLane,
 * setLaneYScale, toggleChannelVisibility, applyAutoGroup, applyPreset.
 * The document lives under `dataset` (channels + lanes); transient view/drag
 * state lives under `ui`; the shared x-axis is exposed as `xs`.
 */

import * as React from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToWindowEdges } from "@dnd-kit/modifiers";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import uPlot from "uplot";
import type { Channel, Lane as LaneModel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/store";
import type { EditorState } from "@/lib/store";
import type { XWindow } from "./lane-board.contract";
import { Lane, UNASSIGNED_ID } from "./lane";
import { ChannelChip, type MoveTarget } from "./channel-chip";
import { LaneToolbar } from "./lane-toolbar";
import { CropControls } from "./crop-controls";

/** Module-level sync key — every lane joins this one cursor sync group. */
export const SYNC_KEY = "ei-lanes";

export interface LaneBoardProps {
  /** strip the toolbar chrome when embedded (lanes stay fully functional) */
  embed?: boolean;
  className?: string;
}

export function LaneBoard({ embed = false, className }: LaneBoardProps) {
  // ---- store slices (narrow selectors to limit re-renders) ----
  // Transient view/drag state lives under `ui`; the document under `dataset`;
  // the derived shared x-axis at top level as `xs`.
  const dataset = useEditorStore((s: EditorState) => s.dataset);
  const xs = useEditorStore((s: EditorState) => s.xs);
  const xWindow = useEditorStore((s: EditorState) => s.ui.xWindow);
  const cursorIdx = useEditorStore((s: EditorState) => s.ui.cursorIdx);
  const preset = useEditorStore((s: EditorState) => s.ui.preset);
  const activeChannelId = useEditorStore(
    (s: EditorState) => s.ui.activeChannelId,
  );
  const overId = useEditorStore((s: EditorState) => s.ui.overId);
  const cropActive = useEditorStore((s: EditorState) => s.ui.cropActive);
  const cropSel = useEditorStore((s: EditorState) => s.ui.cropSel);
  const readOnly = useEditorStore((s: EditorState) => s.ui.mode === "viewer");
  const filterMask = useEditorStore((s: EditorState) => s.ui.filter?.mask ?? null);

  // ---- actions ----
  const moveChannelToLane = useEditorStore(
    (s: EditorState) => s.moveChannelToLane,
  );
  const createLaneWithChannel = useEditorStore(
    (s: EditorState) => s.createLaneWithChannel,
  );
  const removeLane = useEditorStore((s: EditorState) => s.removeLane);
  const renameLane = useEditorStore((s: EditorState) => s.renameLane);
  const toggleChannelVisibility = useEditorStore(
    (s: EditorState) => s.toggleChannelVisibility,
  );
  const applyAutoGroup = useEditorStore((s: EditorState) => s.applyAutoGroup);
  const applyPreset = useEditorStore((s: EditorState) => s.applyPreset);
  const addLane = useEditorStore((s: EditorState) => s.addLane);
  const renameChannel = useEditorStore((s: EditorState) => s.renameChannel);
  const setXWindow = useEditorStore((s: EditorState) => s.setXWindow);
  const setCursorIdx = useEditorStore((s: EditorState) => s.setCursorIdx);
  const setActiveChannelId = useEditorStore(
    (s: EditorState) => s.setActiveChannelId,
  );
  const setOverId = useEditorStore((s: EditorState) => s.setOverId);
  const setCropSel = useEditorStore((s: EditorState) => s.setCropSel);
  const setCropActive = useEditorStore((s: EditorState) => s.setCropActive);
  const setLaneYScaleRaw = useEditorStore(
    (s: EditorState) => s.setLaneYScale,
  );

  // ---- derived ----
  const lanes = dataset?.lanes ?? EMPTY_LANES;
  // Signature of the lane LAYOUT (which lanes exist). Changes on a preset switch
  // or add/remove lane, but NOT on a drag (which only moves channels between
  // existing lanes), so the chart area remounts only on structural changes.
  const layoutKey = lanes.map((l) => l.id).join("|") || "empty";
  // Derive the id->channel map from a stable subscription to dataset.channels.
  // Using selectChannelsById as a raw zustand selector would build a NEW object
  // every call, so Object.is snapshot caching never matches and the whole board
  // re-renders on every store change — including ui.cursorIdx on each mousemove
  // (the documented re-render storm). Memoizing keeps the map identity stable
  // across cursor moves.
  const channels = dataset?.channels;
  const channelsById = React.useMemo(() => {
    const map: Record<string, Channel> = {};
    if (channels) for (const c of channels) map[c.id] = c;
    return map;
  }, [channels]);

  const unassignedChannels = React.useMemo(() => {
    if (!dataset) return [] as Channel[];
    const assigned = new Set<string>();
    for (const lane of dataset.lanes)
      for (const id of lane.channelIds) assigned.add(id);
    return dataset.channels.filter((c) => !assigned.has(c.id));
  }, [dataset]);

  // ---- move targets for chip kebab menus ----
  const moveTargets: MoveTarget[] = React.useMemo(() => {
    const targets: MoveTarget[] = lanes.map((l) => ({
      id: l.id,
      label: l.title,
    }));
    targets.push({ id: "new", label: "New lane" });
    targets.push({ id: UNASSIGNED_ID, label: "Unassigned" });
    return targets;
  }, [lanes]);

  // ---- uPlot instance ref map (NON-serializable; lives outside the store) ----
  const uplotMap = React.useRef<Map<string, uPlot>>(new Map());
  const registerChart = React.useCallback((laneId: string, u: uPlot) => {
    uplotMap.current.set(laneId, u);
  }, []);
  const unregisterChart = React.useCallback((laneId: string) => {
    uplotMap.current.delete(laneId);
  }, []);
  // ---- x-window fan-out: drive every lane's x scale from the store ----
  // (UplotChart guards its own programmatic setScale so this never echoes.)
  React.useEffect(() => {
    const min = xWindow ? xWindow.min : (xs[0] ?? 0);
    const max = xWindow ? xWindow.max : (xs[xs.length - 1] ?? 1);
    uplotMap.current.forEach((u) => {
      try {
        u.setScale("x", { min, max });
      } catch {
        /* chart may be mid-teardown; ignore */
      }
    });
  }, [xWindow, xs]);

  // ---- y-scale adapter: the Lane component speaks { yAuto, yMin, yMax,
  // ySymmetric } (mirroring the Lane data model); the store's setLaneYScale
  // takes { auto, min, max, symmetric }. Bridge the two here. ----
  const setLaneYScale = React.useCallback(
    (
      laneId: string,
      scale: {
        yAuto: boolean;
        yMin?: number;
        yMax?: number;
        ySymmetric?: boolean;
      },
    ) => {
      setLaneYScaleRaw(laneId, {
        auto: scale.yAuto,
        min: scale.yMin,
        max: scale.yMax,
        symmetric: scale.ySymmetric,
      });
    },
    [setLaneYScaleRaw],
  );

  // ---- move resolution helper (used by chip kebab menus) ----
  const handleMove = React.useCallback(
    (channelId: string, targetId: string) => {
      if (targetId === "new") createLaneWithChannel(channelId);
      else moveChannelToLane(channelId, targetId);
    },
    [createLaneWithChannel, moveChannelToLane],
  );

  // ---- dnd sensors: pointer (5px) + keyboard ----
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const onDragStart = React.useCallback(
    (e: DragStartEvent) => {
      const channelId = e.active.data.current?.channelId as string | undefined;
      if (channelId) setActiveChannelId(channelId);
      document.body.style.cursor = "grabbing";
    },
    [setActiveChannelId],
  );

  const onDragOver = React.useCallback(
    (e: DragOverEvent) => {
      setOverId(e.over ? String(e.over.id) : null);
    },
    [setOverId],
  );

  const onDragEnd = React.useCallback(
    (e: DragEndEvent) => {
      document.body.style.cursor = "";
      setActiveChannelId(null);
      setOverId(null);
      const channelId = e.active.data.current?.channelId as string | undefined;
      const overData = e.over?.data.current as
        | { type?: string; laneId?: string }
        | undefined;
      if (!channelId || !overData) return;

      if (overData.type === "new-lane") {
        createLaneWithChannel(channelId);
      } else if (overData.type === "lane" && overData.laneId) {
        const fromLaneId = e.active.data.current?.fromLaneId as
          | string
          | undefined;
        if (fromLaneId === overData.laneId) return; // no-op
        moveChannelToLane(channelId, overData.laneId);
      }
    },
    [createLaneWithChannel, moveChannelToLane, setActiveChannelId, setOverId],
  );

  const onDragCancel = React.useCallback(() => {
    document.body.style.cursor = "";
    setActiveChannelId(null);
    setOverId(null);
  }, [setActiveChannelId, setOverId]);

  // ---- lane callbacks ----
  const onZoom = React.useCallback(
    (w: XWindow | null) => setXWindow(w),
    [setXWindow],
  );
  const onCursor = React.useCallback(
    (idx: number | null) => setCursorIdx(idx),
    [setCursorIdx],
  );
  const onCrop = React.useCallback(
    (sel: { startIdx: number; endIdx: number } | null) => setCropSel(sel),
    [setCropSel],
  );

  const activeChannel = activeChannelId
    ? channelsById[activeChannelId]
    : undefined;

  // Crop is a data-mutating action; force it off in read-only viewer mode so a
  // stale cropActive (e.g. set before a mode switch) can never brush a crop.
  const effectiveCrop = cropActive && !readOnly;

  if (!dataset) {
    return (
      <div
        className={cn(
          "flex h-full min-h-64 items-center justify-center text-sm text-fg-muted",
          className,
        )}
      >
        No dataset loaded — import a CSV or load an Edge Impulse sample.
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {!embed ? (
        <LaneToolbar
          preset={preset}
          cropMode={effectiveCrop}
          hasDataset={!!dataset}
          onApplyAutoGroup={applyAutoGroup}
          onApplyPreset={applyPreset}
          onAddLane={addLane}
          onToggleCrop={() => setCropActive(!cropActive)}
          embed={embed}
          readOnly={readOnly}
        />
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{
          announcements: {
            onDragStart: ({ active }) =>
              `Picked up channel ${chipName(active.id)}. Use arrow keys to choose a lane, space to drop.`,
            onDragOver: ({ over }) =>
              over ? `Over ${dropName(over.id)}.` : "Not over a drop target.",
            onDragEnd: ({ over }) =>
              over ? `Dropped into ${dropName(over.id)}.` : "Drop cancelled.",
            onDragCancel: () => "Move cancelled.",
          },
        }}
      >
        {/* Remount the whole chart area when the lane LAYOUT changes (preset
            switch, add/remove lane) so the uPlot charts re-create in one clean
            unmount-then-mount pass with a fresh cursor-sync group — like a fresh
            load. Switching presets otherwise re-inits charts mid-churn and the
            non-first lanes can end up blank. A drag keeps the same lane ids, so
            it does NOT remount and stays smooth. */}
        <React.Fragment key={layoutKey}>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {lanes.map((lane: LaneModel) => (
              <Lane
                key={lane.id}
                lane={lane}
                channels={lane.channelIds
                  .map((id) => channelsById[id])
                  .filter((c): c is Channel => !!c)}
                xs={xs}
                xWindow={xWindow}
                cursorIdx={cursorIdx}
                syncKey={SYNC_KEY}
                cropMode={effectiveCrop}
                cropSel={cropSel}
                filterMask={filterMask}
                moveTargets={moveTargets}
                isOver={overId === `lane:${lane.id}`}
                onRenameLane={renameLane}
                onRemoveLane={removeLane}
                onSetYScale={setLaneYScale}
                onRenameChannel={renameChannel}
                onToggleVisible={toggleChannelVisibility}
                onMoveChannel={handleMove}
                onReady={registerChart}
                onDestroyChart={unregisterChart}
                onZoom={onZoom}
                onCursor={onCursor}
                onCrop={onCrop}
              />
            ))}

            {/* reserved Unassigned tray (parked channels; NOT charted) */}
            <UnassignedTray
              channels={unassignedChannels}
              cursorIdx={cursorIdx}
              moveTargets={moveTargets}
              isOver={overId === `lane:${UNASSIGNED_ID}`}
              onRenameChannel={renameChannel}
              onToggleVisible={toggleChannelVisibility}
              onMoveChannel={handleMove}
            />

            {/* persistent "+ new lane" drop target */}
            <NewLaneDropZone
              active={!!activeChannelId}
              isOver={overId === "new-lane"}
            />
          </div>

          {/* The shared x-axis ruler is intentionally hidden — lanes share one
              x-window and double-click resets the zoom to full extent. */}

          {/* crop apply/reset surface, only while crop mode is active (editor) */}
          {effectiveCrop ? <CropControls /> : null}
        </React.Fragment>

        {/* portaled overlay so the dragged chip escapes canvas/overflow clip */}
        <DragOverlay modifiers={[restrictToWindowEdges]} dropAnimation={null}>
          {activeChannel ? (
            <ChannelChip
              channel={activeChannel}
              laneId="__overlay__"
              isOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

const EMPTY_LANES: LaneModel[] = [];

/** The reserved unassigned tray — a rail with NO chart. */
const UnassignedTray = React.memo(function UnassignedTray({
  channels,
  cursorIdx,
  moveTargets,
  isOver,
  onRenameChannel,
  onToggleVisible,
  onMoveChannel,
}: {
  channels: Channel[];
  cursorIdx: number | null;
  moveTargets: MoveTarget[];
  isOver: boolean;
  onRenameChannel: (channelId: string, name: string) => void;
  onToggleVisible: (channelId: string) => void;
  onMoveChannel: (channelId: string, targetId: string) => void;
}) {
  const droppable = useDroppable({
    id: `lane:${UNASSIGNED_ID}`,
    data: { type: "lane", laneId: UNASSIGNED_ID },
  });

  return (
    <div
      ref={droppable.setNodeRef}
      className={cn(
        "border-b border-border bg-surface-2/40 p-2 transition-colors",
        isOver && "bg-accent/5 ring-2 ring-inset ring-accent",
      )}
      data-lane-id={UNASSIGNED_ID}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
        Unassigned ({channels.length})
      </div>
      {channels.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-2 py-2 text-center text-xs text-fg-muted">
          Drop a channel here to park it (not charted)
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {channels.map((c) => (
            <ChannelChip
              key={c.id}
              channel={c}
              laneId={UNASSIGNED_ID}
              cursorValue={cursorIdx != null ? c.values[cursorIdx] : undefined}
              moveTargets={moveTargets.filter((t) => t.id !== UNASSIGNED_ID)}
              onRename={onRenameChannel}
              onToggleVisible={onToggleVisible}
              onMove={onMoveChannel}
            />
          ))}
        </div>
      )}
    </div>
  );
});

/** The persistent "+ new lane" droppable strip. */
const NewLaneDropZone = React.memo(function NewLaneDropZone({
  active,
  isOver,
}: {
  active: boolean;
  isOver: boolean;
}) {
  const droppable = useDroppable({ id: "new-lane", data: { type: "new-lane" } });
  return (
    <div
      ref={droppable.setNodeRef}
      aria-label="Drop here to create a new lane"
      className={cn(
        "m-2 flex items-center justify-center rounded-md border-2 border-dashed text-xs font-medium transition-all",
        isOver
          ? "border-accent bg-accent/10 py-10 text-accent"
          : active
            ? "border-accent/60 bg-accent/5 py-6 text-accent/80"
            : "border-border py-4 text-fg-muted",
      )}
      data-new-lane=""
    >
      {isOver ? "Drop to create a new lane" : "+ New lane"}
    </div>
  );
});

/** Strip the "chip:" prefix from a draggable id for screen-reader text. */
function chipName(id: string | number): string {
  const s = String(id);
  return s.startsWith("chip:") ? s.slice(5) : s;
}

/** Human-ish name for a droppable id for screen-reader text. */
function dropName(id: string | number): string {
  const s = String(id);
  if (s === "new-lane") return "the new-lane zone";
  if (s === `lane:${UNASSIGNED_ID}`) return "Unassigned";
  if (s.startsWith("lane:")) return `lane ${s.slice(5)}`;
  return s;
}
