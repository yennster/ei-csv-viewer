import { describe, it, expect, beforeEach } from "vitest";
import { useEditorStore } from "@/lib/store";
import type { Channel, Dataset } from "@/lib/types";

function ch(id: string, values: number[]): Channel {
  return { id, name: id, values, color: "#3b82f6", visible: true };
}

// Three channels of SIMILAR magnitude (~0..10) so auto-group merges them into a
// single lane, while one-per-channel keeps three lanes — letting us tell the two
// presets apart by lane count.
function makeDataset(name: string): Dataset {
  return {
    channels: [ch("a", [0, 5, 10]), ch("b", [0, 6, 11]), ch("c", [0, 4, 9])],
    lanes: [],
    source: "csv",
    name,
  };
}

describe("store — lane preset persistence across sample loads", () => {
  beforeEach(() => {
    // Clean start: no dataset, default (auto) preset.
    useEditorStore.setState((s) => ({
      dataset: null,
      ui: { ...s.ui, preset: "one" },
    }));
  });

  it("defaults to one-per-lane on first load", () => {
    useEditorStore.getState().loadDataset(makeDataset("first"));
    const s = useEditorStore.getState();
    expect(s.ui.preset).toBe("one");
    // one lane per channel by default (auto group is hidden for now)
    expect(s.dataset?.lanes.length).toBe(3);
  });

  it("re-applies the chosen preset when a new sample loads", () => {
    const store = useEditorStore.getState();
    store.loadDataset(makeDataset("first"));
    store.applyPreset("one-per-channel");

    let s = useEditorStore.getState();
    expect(s.ui.preset).toBe("one");
    expect(s.dataset?.lanes.length).toBe(3); // one lane per channel

    // Load a DIFFERENT sample — the preset must persist (not snap back to auto).
    store.loadDataset(makeDataset("second"));
    s = useEditorStore.getState();
    expect(s.dataset?.name).toBe("second");
    expect(s.ui.preset).toBe("one");
    expect(s.dataset?.lanes.length).toBe(3);
    expect(s.dataset?.lanes.every((l) => l.channelIds.length === 1)).toBe(true);
  });

  it("persists the single-lane (all-in-one) preset too", () => {
    const store = useEditorStore.getState();
    store.loadDataset(makeDataset("first"));
    store.applyPreset("all-in-one");
    expect(useEditorStore.getState().ui.preset).toBe("all");

    store.loadDataset(makeDataset("second"));
    const s = useEditorStore.getState();
    expect(s.ui.preset).toBe("all");
    expect(s.dataset?.lanes.length).toBe(1);
    expect(s.dataset?.lanes[0].channelIds.length).toBe(3);
  });
});
