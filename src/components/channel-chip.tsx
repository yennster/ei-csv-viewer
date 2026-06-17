"use client";

/**
 * channel-chip.tsx — a draggable channel token.
 *
 * Used in two places: a lane's header/legend, and the unassigned tray. It is a
 * dnd-kit useDraggable (NOT useSortable) because cross-lane re-parenting is the
 * centerpiece and within-lane order is secondary (stable color order suffices).
 *
 * Interactions:
 *  - small drag (>5px, enforced by the board's PointerSensor) starts a move
 *  - plain click toggles visibility
 *  - double-click opens inline rename
 *  - a kebab "Move to…" menu is the NON-DRAG fallback (touch + a11y)
 *  - keyboard: focusable; Space/Enter with the KeyboardSensor picks it up
 */

import * as React from "react";
import { useDraggable } from "@dnd-kit/core";
import { Eye, EyeOff, GripVertical, MoveRight } from "lucide-react";
import type { Channel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/store";
import { formatValue } from "./lane-format";

/** A move target offered by the kebab menu. */
export interface MoveTarget {
  id: string; // lane id, "new", or "unassigned"
  label: string;
}

export interface ChannelChipProps {
  channel: Channel;
  /** owning lane id, or the literal "unassigned" for the tray */
  laneId: string;
  /** live value at the synchronized cursor index, if any */
  cursorValue?: number;
  /** targets for the "Move to…" fallback menu */
  moveTargets?: MoveTarget[];
  /** rename a channel by id */
  onRename?: (channelId: string, name: string) => void;
  /** toggle channel visibility */
  onToggleVisible?: (channelId: string) => void;
  /** non-drag move via the kebab menu */
  onMove?: (channelId: string, targetId: string) => void;
  /** when rendered inside the DragOverlay: no draggable hooks, ghost styling */
  isOverlay?: boolean;
}

export function ChannelChip({
  channel,
  laneId,
  cursorValue,
  moveTargets,
  onRename,
  onToggleVisible,
  onMove,
  isOverlay = false,
}: ChannelChipProps) {
  // Channel rename is a data mutation (the name flows into CSV/EI export), so
  // it is disabled in read-only viewer mode. Drag/visibility stay available.
  const readOnly = useEditorStore((s) => s.ui.mode === "viewer");

  const draggable = useDraggable({
    id: `chip:${channel.id}`,
    data: { type: "channel", channelId: channel.id, fromLaneId: laneId },
    disabled: isOverlay,
  });

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(channel.name);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (editing) {
      setDraft(channel.name);
      // focus on next tick once mounted
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, channel.name]);

  // close the kebab menu on outside click
  React.useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const commitRename = React.useCallback(() => {
    const next = draft.trim();
    if (next && next !== channel.name) onRename?.(channel.id, next);
    setEditing(false);
  }, [draft, channel.id, channel.name, onRename]);

  const dimmed = !channel.visible;

  // ---- overlay clone (rendered in the portaled DragOverlay) ----
  if (isOverlay) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5",
          "shadow-lg ring-1 ring-accent/40",
        )}
        style={{ transform: "scale(1.03)" }}
      >
        <span
          className="h-3 w-3 shrink-0 rounded-sm"
          style={{ backgroundColor: channel.color }}
        />
        <span className="text-sm font-medium text-fg">{channel.name}</span>
        <Sparkline values={channel.values} color={channel.color} />
      </div>
    );
  }

  return (
    <div
      ref={draggable.setNodeRef}
      style={{ touchAction: "none", opacity: draggable.isDragging ? 0.4 : 1 }}
      className={cn(
        "group/chip flex items-center gap-1.5 rounded-md border border-border bg-surface px-1.5 py-1",
        "transition-colors hover:bg-surface-2",
        dimmed && "opacity-60",
      )}
      data-channel-id={channel.id}
    >
      {/* drag grip — carries the keyboard/pointer listeners */}
      <button
        type="button"
        aria-label={`Drag ${channel.name}`}
        className={cn(
          "flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded text-fg-muted",
          "hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          "active:cursor-grabbing",
        )}
        {...draggable.listeners}
        {...draggable.attributes}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>

      {/* color swatch */}
      <span
        className="h-3 w-3 shrink-0 rounded-sm"
        style={{ backgroundColor: channel.color }}
        aria-hidden
      />

      {/* name / inline rename */}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setEditing(false);
            e.stopPropagation();
          }}
          className={cn(
            "h-5 w-24 rounded border border-border bg-bg px-1 text-xs text-fg",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
          )}
        />
      ) : (
        <button
          type="button"
          className="min-w-0 truncate text-left text-xs font-medium text-fg"
          title={`${channel.name}${channel.units ? ` (${channel.units})` : ""} — click to toggle${readOnly ? "" : ", double-click to rename"}`}
          onClick={() => onToggleVisible?.(channel.id)}
          onDoubleClick={readOnly ? undefined : () => setEditing(true)}
        >
          <span className="truncate">{channel.name}</span>
          {channel.units ? (
            <span className="ml-1 text-fg-muted">{channel.units}</span>
          ) : null}
        </button>
      )}

      {/* live cursor value */}
      {cursorValue != null && Number.isFinite(cursorValue) ? (
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-fg-muted">
          {formatValue(cursorValue)}
        </span>
      ) : null}

      {/* visibility toggle */}
      <button
        type="button"
        aria-label={channel.visible ? "Hide channel" : "Show channel"}
        aria-pressed={channel.visible}
        className={cn(
          "ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted",
          "hover:bg-border hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          cursorValue != null && Number.isFinite(cursorValue) && "ml-1",
        )}
        onClick={() => onToggleVisible?.(channel.id)}
      >
        {channel.visible ? (
          <Eye className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <EyeOff className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>

      {/* kebab "Move to…" fallback (touch + a11y, no drag required) */}
      {moveTargets && moveTargets.length > 0 ? (
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            aria-label={`Move ${channel.name} to another lane`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded text-fg-muted",
              "hover:bg-border hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoveRight className="h-3.5 w-3.5" aria-hidden />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className={cn(
                "absolute right-0 z-30 mt-1 min-w-40 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-lg",
              )}
            >
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                Move to
              </div>
              {moveTargets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  className={cn(
                    "block w-full px-3 py-1.5 text-left text-xs text-fg",
                    "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none",
                  )}
                  onClick={() => {
                    setMenuOpen(false);
                    onMove?.(channel.id, t.id);
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A tiny min-max sparkline so a dragged chip visibly "carries the signal". */
function Sparkline({
  values,
  color,
  width = 56,
  height = 16,
}: {
  values: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  const path = React.useMemo(
    () => sparklinePath(values, width, height),
    [values, width, height],
  );
  if (!path) return null;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className="shrink-0"
    >
      <path d={path} fill="none" stroke={color} strokeWidth={1.25} />
    </svg>
  );
}

/** Build a min-max-bucketed sparkline path (preserves the visual envelope). */
export function sparklinePath(
  values: number[],
  width: number,
  height: number,
  buckets = 48,
): string | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const n = Math.min(buckets, finite.length);
  const step = finite.length / n;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let bMin = Infinity;
    let bMax = -Infinity;
    for (let j = start; j < end && j < finite.length; j++) {
      const v = finite[j];
      if (v < bMin) bMin = v;
      if (v > bMax) bMax = v;
    }
    const mid = (bMin + bMax) / 2;
    const x = (i / (n - 1)) * width;
    const y = height - ((mid - min) / span) * height;
    pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}
