/**
 * lane-board.contract.ts — the store/helper contract the lane board codes to.
 *
 * The editor store (`@/lib/store` -> `useEditorStore`) and the time-series
 * helpers (`@/lib/timeseries`) are owned by other agents. This file documents
 * the slice + actions the lane board depends on and RE-EXPORTS the real store
 * types so the components have one canonical import. Action names are BINDING:
 *   moveChannelToLane, createLaneWithChannel, removeLane, renameLane,
 *   setLaneYScale, toggleChannelVisibility, applyAutoGroup, applyPreset.
 *
 * NOTE on shapes (matched to the actual store at integration time):
 *   - The document lives under `dataset` (channels + lanes); the derived shared
 *     x-axis is exposed at the top level as `xs`.
 *   - Transient view/drag state lives under `ui`: ui.xWindow, ui.cursorIdx,
 *     ui.preset, ui.activeChannelId, ui.overId, ui.cropSel, ui.cropActive.
 *   - setLaneYScale takes `{ auto, min?, max?, symmetric? }`. The lane board
 *     bridges the Lane component's `{ yAuto, yMin, yMax, ySymmetric }` shape to
 *     this signature internally.
 *   - crop toggle is `ui.cropActive` / `setCropActive`.
 *   - applyPreset takes a `LanePreset`
 *     ("one-per-channel" | "all-in-one" | "auto-group").
 */

export type {
  EditorState,
  ConnectionState,
  AsyncStatus,
  XWindow,
  CropSelection,
} from "@/lib/store";

export { selectChannelsById, selectUnassignedChannelIds } from "@/lib/store";

/**
 * ===== TIMESERIES CONTRACT (`@/lib/timeseries`) — what the board uses =====
 *
 *   channelRange(channel): { min, max }
 *     - finite [min,max] of a channel (NaN bounds when degenerate)
 *
 *   downsample(values, maxPoints): { values, indices }
 *     - min/max bucketed decimation preserving visual extremes; returns the
 *       original index of each kept point so x can be sampled identically.
 *       NEVER drops true peaks, so it is safe to derive y-auto from it.
 *
 *   autoGroupLanes(channels, opts?): Lane[]   (used by the store, not directly here)
 */
