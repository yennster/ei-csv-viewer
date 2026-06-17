// src/lib/store.ts — the single zustand editor store.
//
// Source of truth for the editor Dataset (channels + lanes), the shared view
// state (x-window, cursor, crop, drag), the Edge Impulse connection status, and
// transient app-shell flags (theme, embed, async status).
//
// The lane board (feat:lane-board) codes against the contract in
// `src/components/lane-board.contract.ts`. Per that contract:
//   - The document lives under `dataset` (channels + lanes) plus a derived `xs`.
//   - Transient view/drag state lives under `ui`
//     (xWindow, cursorIdx, preset, activeChannelId, overId, cropActive, …).
//   - setLaneYScale takes `{ auto, min?, max?, symmetric? }`.
//   - crop toggle is `cropActive` / `setCropActive`.
//   - applyPreset takes a LanePreset.
// These action names are BINDING — keep them stable:
//   moveChannelToLane, createLaneWithChannel, removeLane, renameLane,
//   setLaneYScale, toggleChannelVisibility, applyAutoGroup, applyPreset.

"use client";

import { create } from "zustand";
import type {
  Channel,
  Dataset,
  EICategory,
  EISampleMeta,
  Lane,
  LanePreset,
  Mode,
  UrlPreset,
} from "@/lib/types";

// Sibling pure helpers (owned by the csv / timeseries agents).
import { parseCsv, serializeCsv } from "@/lib/csv";
import {
  autoGroupLanes,
  presetOneLanePerChannel,
  presetSingleLane,
  cropDataset,
  makeChannelColor,
} from "@/lib/timeseries";
// Same-origin EI client fetchers (the apiKey never reaches this module).
import {
  connectSession,
  disconnectSession,
  getSessionStatus,
  listSamples,
  loadSample,
  uploadSample,
  cropSample,
} from "@/lib/ei-client";

// ---------------------------------------------------------------------------
// id + x-axis helpers (kept local; no external deps)
// ---------------------------------------------------------------------------

let _seq = 0;
function uid(prefix: string): string {
  _seq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${_seq.toString(36)}${rand}`;
}
function laneId(): string {
  return uid("lane");
}
function chanId(): string {
  return uid("chan");
}

/** Shared x-axis: explicit time, else a 0..n-1 sample index. */
export function buildXs(channels: Channel[], time?: number[]): number[] {
  if (time && time.length > 0) return time;
  const n = channels.reduce((m, c) => Math.max(m, c.values.length), 0);
  const xs = new Array<number>(n);
  for (let i = 0; i < n; i++) xs[i] = i;
  return xs;
}

const RESERVED_LANE_IDS = new Set(["unassigned", "new-lane"]);

/** Remove a channelId from every lane (used before re-inserting on a move). */
function withoutChannel(lanes: Lane[], channelId: string): Lane[] {
  return lanes.map((l) =>
    l.channelIds.includes(channelId)
      ? { ...l, channelIds: l.channelIds.filter((c) => c !== channelId) }
      : l,
  );
}

function laneOf(lanes: Lane[], channelId: string): Lane | undefined {
  return lanes.find((l) => l.channelIds.includes(channelId));
}
function indexOfLane(lanes: Lane[], id: string): number {
  return lanes.findIndex((l) => l.id === id);
}

function lanesForPreset(channels: Channel[], preset: LanePreset): Lane[] {
  switch (preset) {
    case "auto-group":
      return autoGroupLanes(channels);
    case "one-per-channel":
      return presetOneLanePerChannel(channels);
    case "all-in-one":
      return presetSingleLane(channels);
    default:
      return autoGroupLanes(channels);
  }
}

function presetToUrl(preset: LanePreset): UrlPreset {
  return preset === "auto-group"
    ? "auto"
    : preset === "all-in-one"
      ? "all"
      : "one";
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface ConnectionState {
  status: "disconnected" | "connecting" | "connected" | "error";
  projectId?: number;
  projectName?: string;
  error?: string;
}

export type AsyncStatus = "idle" | "loading" | "saving" | "error";

export interface XWindow {
  min: number;
  max: number;
}
export interface CropSelection {
  startIdx: number;
  endIdx: number;
}

/**
 * The active formula FILTER highlight (non-destructive). Lanes / charts shade the
 * non-matching regions; rows are never mutated. See the formula engine and the
 * FormulaPanel.
 */
export interface FilterState {
  /** source expression that produced the mask. */
  expr: string;
  /** length-N mask: true where the predicate held. */
  mask: boolean[];
  /** number of matching samples. */
  count: number;
  /** total samples (N). */
  total: number;
  /** inclusive matching extent, or null when nothing matched. */
  range: { start: number; end: number } | null;
}

/** Transient view / drag / async UI state (not part of the editor document). */
export interface UiState {
  theme: "light" | "dark";
  embed: boolean;
  /** viewer | editor; viewer hides data-mutating + write-back controls. */
  mode: Mode;
  /** Render preset reflected by the lane toolbar segmented control. */
  preset: UrlPreset;
  /** Shared x-window in x-domain units; null => full extent. */
  xWindow: XWindow | null;
  /** Hovered sample index, lifted from any lane's synchronized cursor. */
  cursorIdx: number | null;
  /** Crop selection in INDEX space (so the EI crop endpoint gets indices). */
  cropSel: CropSelection | null;
  /** When true, lane drags select a crop band instead of zooming. */
  cropActive: boolean;
  /** dnd-kit transient drag state. */
  activeChannelId: string | null;
  overId: string | null;
  selectedLaneId: string | null;
  /** Active non-destructive formula filter highlight, or null. */
  filter: FilterState | null;
  /** Long-running op status + last human-readable message. */
  busy: AsyncStatus;
  message: string | null;
}

export interface EditorState {
  // ---- document ----
  dataset: Dataset | null;
  /** Derived shared x-axis (sample index or seconds). */
  xs: number[];

  // ---- transient view / ui state ----
  ui: UiState;

  // ---- app-shell connection / sample listing ----
  connection: ConnectionState;
  samples: EISampleMeta[];
  samplesStatus: AsyncStatus;

  // ---- bootstrap / connection ----
  hydrateConnection: () => Promise<void>;
  connect: (opts: {
    apiKey: string;
    projectId?: number;
    studioHost?: string;
    ingestionHost?: string;
  }) => Promise<boolean>;
  disconnect: () => Promise<void>;
  fetchSamples: (opts: {
    category?: EICategory;
    labels?: string[];
    limit?: number;
    offset?: number;
  }) => Promise<void>;

  // ---- dataset loading ----
  loadDataset: (dataset: Dataset) => void;
  importCsv: (file: File) => Promise<void>;
  loadFromEdgeImpulse: (sampleId: number) => Promise<void>;
  resetDataset: () => void;

  // ---- lane / channel mutations (BINDING names) ----
  moveChannelToLane: (channelId: string, laneId: string) => void;
  createLaneWithChannel: (channelId: string) => void;
  addLane: () => void;
  removeLane: (laneId: string) => void;
  renameLane: (laneId: string, title: string) => void;
  reorderLane: (laneId: string, toIndex: number) => void;
  setLaneYScale: (
    laneId: string,
    scale: { auto: boolean; min?: number; max?: number; symmetric?: boolean },
  ) => void;
  toggleChannelVisibility: (channelId: string) => void;
  renameChannel: (channelId: string, name: string) => void;
  applyAutoGroup: () => void;
  applyPreset: (kind: LanePreset) => void;

  // ---- formula engine (derive + filter; non-destructive analysis) ----
  /** Append a frozen formula-derived channel (its own solo lane) + rebuild xs. */
  addDerivedChannel: (name: string, expr: string, values: number[]) => void;
  /** Set the active filter highlight (never mutates rows/channels). */
  setFilterMask: (filter: FilterState) => void;
  /** Clear the active filter highlight. */
  clearFilter: () => void;

  // ---- shared view setters ----
  setXWindow: (win: XWindow | null) => void;
  setCursorIdx: (idx: number | null) => void;
  setActiveChannelId: (id: string | null) => void;
  setOverId: (id: string | null) => void;
  setCropSel: (sel: CropSelection | null) => void;
  setCropActive: (on: boolean) => void;
  setSelectedLaneId: (id: string | null) => void;

  // ---- crop / export / upload ----
  cropToSelection: (start: number, end: number) => Promise<void>;
  exportCsv: () => string | null;
  uploadToEdgeImpulse: (opts: {
    label: string;
    category: EICategory;
    fileName?: string;
    deviceName?: string;
  }) => Promise<boolean>;

  // ---- ui ----
  setTheme: (theme: "light" | "dark") => void;
  setEmbed: (embed: boolean) => void;
  setMode: (mode: Mode) => void;

  /** Internal: flip the toolbar preset to "custom" after a manual mutation. */
  _markCustom: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const initialUi: UiState = {
  theme: "light",
  embed: false,
  mode: "editor",
  preset: "auto",
  xWindow: null,
  cursorIdx: null,
  cropSel: null,
  cropActive: false,
  activeChannelId: null,
  overId: null,
  selectedLaneId: null,
  filter: null,
  busy: "idle",
  message: null,
};

export const useEditorStore = create<EditorState>((set, get) => {
  /** Patch the current dataset's lanes in one immutable shot. */
  function setLanes(lanes: Lane[]) {
    const ds = get().dataset;
    if (!ds) return;
    set({ dataset: { ...ds, lanes } });
  }
  /** Patch `ui` immutably. */
  function patchUi(patch: Partial<UiState>) {
    set((s) => ({ ui: { ...s.ui, ...patch } }));
  }

  return {
    dataset: null,
    xs: [],
    ui: initialUi,
    connection: { status: "disconnected" },
    samples: [],
    samplesStatus: "idle",

    // ---- bootstrap / connection ----
    async hydrateConnection() {
      try {
        const status = await getSessionStatus();
        if (status.connected) {
          set((s) => ({
            connection: {
              ...s.connection,
              status: "connected",
              projectId: status.projectId,
            },
          }));
        }
      } catch {
        // best-effort; leave disconnected
      }
    },

    async connect(opts) {
      set((s) => ({
        connection: { ...s.connection, status: "connecting", error: undefined },
      }));
      try {
        const res = await connectSession(opts);
        if (!res.success) {
          set({
            connection: {
              status: "error",
              error: res.error ?? "Failed to connect to Edge Impulse",
            },
          });
          return false;
        }
        set({
          connection: {
            status: "connected",
            projectId: res.projectId,
            projectName: res.projectName,
          },
        });
        return true;
      } catch (err) {
        set({
          connection: {
            status: "error",
            error: err instanceof Error ? err.message : "Connection failed",
          },
        });
        return false;
      }
    },

    async disconnect() {
      try {
        await disconnectSession();
      } catch {
        // ignore network errors on disconnect
      }
      set({
        connection: { status: "disconnected" },
        samples: [],
        samplesStatus: "idle",
      });
    },

    async fetchSamples(opts) {
      set({ samplesStatus: "loading" });
      try {
        const samples = await listSamples(opts);
        set({ samples, samplesStatus: "idle" });
      } catch (err) {
        set({ samples: [], samplesStatus: "error" });
        patchUi({
          message:
            err instanceof Error ? err.message : "Failed to list samples",
        });
      }
    },

    // ---- dataset loading ----
    loadDataset(dataset) {
      set((s) => {
        // PERSIST the user's chosen lane preset across sample switches. CSV/EI
        // datasets arrive without lanes; rather than always snapping back to
        // auto-group, re-apply whichever preset (Auto group / One per lane /
        // Single lane) is currently active. A prior hand-arranged "custom"
        // layout can't be reproduced on a different channel set, so it falls
        // back to auto-group. A dataset that ships its own lanes keeps them.
        const persisted = s.ui.preset;
        const presetForLoad: LanePreset =
          persisted === "one"
            ? "one-per-channel"
            : persisted === "all"
              ? "all-in-one"
              : "auto-group";
        const explicit = dataset.lanes.length > 0;
        const lanes = explicit
          ? dataset.lanes
          : lanesForPreset(dataset.channels, presetForLoad);
        const next: Dataset = { ...dataset, lanes };
        return {
          dataset: next,
          xs: buildXs(next.channels, next.time),
          ui: {
            ...s.ui,
            preset: explicit ? "custom" : presetToUrl(presetForLoad),
            xWindow: null,
            cursorIdx: null,
            cropSel: null,
            cropActive: false,
            selectedLaneId: lanes[0]?.id ?? null,
            filter: null,
            busy: "idle",
            message: null,
          },
        };
      });
    },

    async importCsv(file) {
      patchUi({ busy: "loading", message: null });
      try {
        const dataset = await parseCsv(file, { name: file.name });
        get().loadDataset(dataset);
        patchUi({ busy: "idle" });
      } catch (err) {
        patchUi({
          busy: "error",
          message:
            err instanceof Error ? err.message : "Could not parse the CSV file",
        });
        throw err;
      }
    },

    async loadFromEdgeImpulse(sampleId) {
      patchUi({ busy: "loading", message: null });
      try {
        const dataset = await loadSample(sampleId);
        get().loadDataset(dataset);
        patchUi({ busy: "idle" });
      } catch (err) {
        patchUi({
          busy: "error",
          message:
            err instanceof Error ? err.message : "Could not load the sample",
        });
        throw err;
      }
    },

    resetDataset() {
      set((s) => ({
        dataset: null,
        xs: [],
        ui: { ...initialUi, theme: s.ui.theme, embed: s.ui.embed, mode: s.ui.mode },
      }));
    },

    // ---- lane / channel mutations ----
    moveChannelToLane(channelId, targetLaneId) {
      const ds = get().dataset;
      if (!ds) return;
      const current = laneOf(ds.lanes, channelId);
      if (current?.id === targetLaneId) return; // no-op

      if (targetLaneId === "unassigned") {
        setLanes(withoutChannel(ds.lanes, channelId));
        get()._markCustom();
        return;
      }

      let lanes = withoutChannel(ds.lanes, channelId);
      const idx = indexOfLane(lanes, targetLaneId);
      if (idx === -1) return; // unknown target
      lanes = lanes.map((l, i) =>
        i === idx ? { ...l, channelIds: [...l.channelIds, channelId] } : l,
      );
      setLanes(lanes);
      get()._markCustom();
    },

    createLaneWithChannel(channelId) {
      const ds = get().dataset;
      if (!ds) return;
      const source = laneOf(ds.lanes, channelId);
      let lanes = withoutChannel(ds.lanes, channelId);
      const newLane: Lane = {
        id: laneId(),
        title: `Lane ${lanes.length + 1}`,
        channelIds: [channelId],
        yAuto: true,
      };
      if (source) {
        const at = indexOfLane(lanes, source.id);
        const insertAt = at === -1 ? lanes.length : at + 1;
        lanes = [...lanes.slice(0, insertAt), newLane, ...lanes.slice(insertAt)];
      } else {
        lanes = [...lanes, newLane];
      }
      setLanes(lanes);
      patchUi({ selectedLaneId: newLane.id });
      get()._markCustom();
    },

    addLane() {
      const ds = get().dataset;
      if (!ds) return;
      const newLane: Lane = {
        id: laneId(),
        title: `Lane ${ds.lanes.length + 1}`,
        channelIds: [],
        yAuto: true,
      };
      setLanes([...ds.lanes, newLane]);
      patchUi({ selectedLaneId: newLane.id });
    },

    removeLane(id) {
      const ds = get().dataset;
      if (!ds || RESERVED_LANE_IDS.has(id)) return;
      if (ds.lanes.length <= 1) return; // keep a drop target around
      const lanes = ds.lanes.filter((l) => l.id !== id);
      setLanes(lanes);
      set((s) => ({
        ui: {
          ...s.ui,
          selectedLaneId:
            s.ui.selectedLaneId === id
              ? (lanes[0]?.id ?? null)
              : s.ui.selectedLaneId,
        },
      }));
      get()._markCustom();
    },

    renameLane(id, title) {
      const ds = get().dataset;
      if (!ds) return;
      setLanes(ds.lanes.map((l) => (l.id === id ? { ...l, title } : l)));
    },

    reorderLane(id, toIndex) {
      const ds = get().dataset;
      if (!ds) return;
      const from = indexOfLane(ds.lanes, id);
      if (from === -1) return;
      const clamped = Math.max(0, Math.min(ds.lanes.length - 1, toIndex));
      if (from === clamped) return;
      const lanes = [...ds.lanes];
      const [moved] = lanes.splice(from, 1);
      lanes.splice(clamped, 0, moved);
      setLanes(lanes);
      get()._markCustom();
    },

    setLaneYScale(id, scale) {
      const ds = get().dataset;
      if (!ds) return;
      setLanes(
        ds.lanes.map((l) => {
          if (l.id !== id) return l;
          if (scale.auto) {
            return {
              ...l,
              yAuto: true,
              yMin: undefined,
              yMax: undefined,
              ySymmetric: undefined,
            };
          }
          return {
            ...l,
            yAuto: false,
            yMin: scale.min,
            yMax: scale.max,
            ySymmetric: scale.symmetric ?? l.ySymmetric,
          };
        }),
      );
    },

    toggleChannelVisibility(channelId) {
      const ds = get().dataset;
      if (!ds) return;
      set({
        dataset: {
          ...ds,
          channels: ds.channels.map((c) =>
            c.id === channelId ? { ...c, visible: !c.visible } : c,
          ),
        },
      });
    },

    renameChannel(channelId, name) {
      const ds = get().dataset;
      if (!ds) return;
      set({
        dataset: {
          ...ds,
          channels: ds.channels.map((c) =>
            c.id === channelId ? { ...c, name } : c,
          ),
        },
      });
    },

    applyAutoGroup() {
      get().applyPreset("auto-group");
    },

    applyPreset(kind) {
      const ds = get().dataset;
      if (!ds) return;
      const lanes = lanesForPreset(ds.channels, kind);
      setLanes(lanes);
      patchUi({ preset: presetToUrl(kind), selectedLaneId: lanes[0]?.id ?? null });
    },

    // ---- formula engine ----
    addDerivedChannel(name, expr, values) {
      const ds = get().dataset;
      if (!ds) return;
      // A derived channel is a normal Channel; it joins lanes / drag / export
      // unchanged. Mint it full-resolution and frozen with its source expression.
      const channel: Channel = {
        id: chanId(),
        name,
        values,
        color: makeChannelColor(ds.channels.length),
        visible: true,
        derived: true,
        expr,
      };
      // Give it its own new lane so the derived trace is immediately visible,
      // inserted after the currently-selected lane (mirrors createLaneWithChannel).
      const newLane: Lane = {
        id: laneId(),
        title: name,
        channelIds: [channel.id],
        yAuto: true,
      };
      const selectedId = get().ui.selectedLaneId;
      const at = selectedId ? indexOfLane(ds.lanes, selectedId) : -1;
      const insertAt = at === -1 ? ds.lanes.length : at + 1;
      const lanes = [
        ...ds.lanes.slice(0, insertAt),
        newLane,
        ...ds.lanes.slice(insertAt),
      ];
      const next: Dataset = {
        ...ds,
        channels: [...ds.channels, channel],
        lanes,
      };
      set({ dataset: next, xs: buildXs(next.channels, next.time) });
      patchUi({ selectedLaneId: newLane.id });
      get()._markCustom();
    },

    setFilterMask(filter) {
      patchUi({ filter });
    },

    clearFilter() {
      patchUi({ filter: null });
    },

    // ---- shared view setters ----
    setXWindow(win) {
      patchUi({ xWindow: win });
    },
    setCursorIdx(idx) {
      patchUi({ cursorIdx: idx });
    },
    setActiveChannelId(id) {
      patchUi({ activeChannelId: id });
    },
    setOverId(id) {
      patchUi({ overId: id });
    },
    setCropSel(sel) {
      patchUi({ cropSel: sel });
    },
    setCropActive(on) {
      set((s) => ({
        ui: { ...s.ui, cropActive: on, cropSel: on ? s.ui.cropSel : null },
      }));
    },
    setSelectedLaneId(id) {
      patchUi({ selectedLaneId: id });
    },

    // ---- crop / export / upload ----
    async cropToSelection(start, end) {
      const ds = get().dataset;
      if (!ds) return;
      const length = ds.channels.reduce(
        (m, c) => Math.max(m, c.values.length),
        ds.time?.length ?? 0,
      );
      const lo = Math.max(0, Math.min(start, end));
      const hi = Math.min(length - 1, Math.max(start, end));
      if (hi <= lo) return;

      // EI sample: offer a server-side crop; always also trim locally so the
      // view reflects the crop even if the server call is unavailable.
      if (ds.source === "edge-impulse" && ds.sampleId != null) {
        patchUi({ busy: "saving", message: null });
        try {
          await cropSample(ds.sampleId, lo, hi);
        } catch (err) {
          patchUi({
            busy: "error",
            message:
              err instanceof Error ? err.message : "Server-side crop failed",
          });
        }
      }

      const next = cropDataset(ds, lo, hi);
      set((s) => ({
        dataset: next,
        xs: buildXs(next.channels, next.time),
        ui: {
          ...s.ui,
          busy: "idle",
          xWindow: null,
          cropSel: null,
          cropActive: false,
          cursorIdx: null,
          // crop shifts sample indices, so a prior filter mask no longer aligns.
          filter: null,
        },
      }));
    },

    exportCsv() {
      const ds = get().dataset;
      if (!ds) return null;
      return serializeCsv(ds);
    },

    async uploadToEdgeImpulse(opts) {
      const ds = get().dataset;
      if (!ds) return false;
      patchUi({ busy: "saving", message: null });
      try {
        await uploadSample({
          dataset: ds,
          label: opts.label,
          category: opts.category,
          fileName: opts.fileName,
          deviceName: opts.deviceName,
        });
        patchUi({ busy: "idle", message: "Uploaded to Edge Impulse" });
        return true;
      } catch (err) {
        patchUi({
          busy: "error",
          message: err instanceof Error ? err.message : "Upload failed",
        });
        return false;
      }
    },

    // ---- ui ----
    setTheme(theme) {
      patchUi({ theme });
    },
    setEmbed(embed) {
      patchUi({ embed });
    },
    setMode(mode) {
      patchUi({ mode });
    },

    _markCustom() {
      set((s) =>
        s.ui.preset === "custom" ? s : { ui: { ...s.ui, preset: "custom" } },
      );
    },
  };
});

// ---------------------------------------------------------------------------
// Selectors (re-exported through lane-board.contract.ts for the board)
// ---------------------------------------------------------------------------

/** Channels resolved by id for O(1) lookup in the render path. */
export function selectChannelsById(state: EditorState): Record<string, Channel> {
  const map: Record<string, Channel> = {};
  if (!state.dataset) return map;
  for (const c of state.dataset.channels) map[c.id] = c;
  return map;
}

/** Channel ids in the dataset but not in any lane (the backlog/unassigned). */
export function selectUnassignedChannelIds(state: EditorState): string[] {
  if (!state.dataset) return [];
  const assigned = new Set<string>();
  for (const lane of state.dataset.lanes)
    for (const id of lane.channelIds) assigned.add(id);
  return state.dataset.channels
    .filter((c) => !assigned.has(c.id))
    .map((c) => c.id);
}
