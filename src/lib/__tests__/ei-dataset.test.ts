import { describe, it, expect, beforeEach } from "vitest";
import { datasetFromSample } from "@/lib/ei-client";
import { useEditorStore } from "@/lib/store";
import type { Dataset, EISampleMeta, EISamplePayload } from "@/lib/types";

function sampleMeta(over: Partial<EISampleMeta> = {}): EISampleMeta {
  return {
    id: 42,
    filename: "sample-42.cbor",
    label: "idle",
    category: "training",
    sensors: [],
    ...over,
  };
}

describe("datasetFromSample (critical: must NOT pre-collapse to one lane)", () => {
  it("returns an EMPTY lanes array so the store lays out the channels itself", () => {
    const payload: EISamplePayload = {
      sensors: [
        { name: "big", units: "x" },
        { name: "small", units: "y" },
      ],
      // one row per timestep, one number per sensor axis
      values: [
        [0, 0],
        [500, 0.5],
        [1000, 1],
      ],
      intervalMs: 10,
    };
    const ds = datasetFromSample(sampleMeta(), payload);
    expect(ds.source).toBe("edge-impulse");
    expect(ds.channels.map((c) => c.name)).toEqual(["big", "small"]);
    // The headline fix: lanes are left empty (NOT a single "All channels" lane).
    expect(ds.lanes).toEqual([]);
    // Column-extraction sanity: channel i = values.map(row => row[i]).
    expect(ds.channels[0].values).toEqual([0, 500, 1000]);
    expect(ds.channels[1].values).toEqual([0, 0.5, 1]);
  });
});

describe("store.loadDataset lays out an EI sample into lanes", () => {
  beforeEach(() => {
    useEditorStore.getState().resetDataset();
  });

  it("splits a 0..1000 channel and a 0..1 channel into separate lanes", () => {
    const payload: EISamplePayload = {
      sensors: [{ name: "big" }, { name: "small" }],
      values: [
        [0, 0],
        [500, 0.5],
        [1000, 1],
      ],
      intervalMs: 10,
    };
    const ds = datasetFromSample(sampleMeta(), payload);
    useEditorStore.getState().loadDataset(ds);

    const lanes = useEditorStore.getState().dataset!.lanes;
    // The whole point of the product: disparate magnitudes get their own lane,
    // so the small-range channel is never crushed by the large one.
    expect(lanes.length).toBeGreaterThanOrEqual(2);
    const bigId = ds.channels[0].id;
    const smallId = ds.channels[1].id;
    const bigLane = lanes.find((l) => l.channelIds.includes(bigId));
    expect(bigLane?.channelIds).not.toContain(smallId);
  });
});

describe("datasetFromSample carries structured (multi-)labels", () => {
  it("normalizes structuredLabels from the sample onto the dataset", () => {
    const payload: EISamplePayload = {
      sensors: [{ name: "x" }],
      values: [[0], [1], [2], [3], [4]],
      intervalMs: 10,
    };
    const ds = datasetFromSample(
      sampleMeta({
        structuredLabels: [
          { startIndex: 0, endIndex: 2, label: "a" },
          { startIndex: 3, endIndex: 4, label: "b" },
        ],
      }),
      payload,
    );
    expect(ds.labels).toEqual([
      { startIndex: 0, endIndex: 2, label: "a" },
      { startIndex: 3, endIndex: 4, label: "b" },
    ]);
  });

  it("leaves labels undefined for a single-label sample", () => {
    const payload: EISamplePayload = {
      sensors: [{ name: "x" }],
      values: [[0], [1]],
    };
    expect(datasetFromSample(sampleMeta(), payload).labels).toBeUndefined();
  });
});

describe("store label editing", () => {
  beforeEach(() => {
    useEditorStore.getState().resetDataset();
  });

  function load() {
    const ds: Dataset = {
      source: "csv",
      name: "x",
      lanes: [],
      channels: [
        {
          id: "a",
          name: "a",
          values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
          color: "#000000",
          visible: true,
        },
      ],
    };
    useEditorStore.getState().loadDataset(ds);
  }

  it("adds, renames, and removes label segments", () => {
    load();
    const s = () => useEditorStore.getState();
    s().addLabel(0, 4, "walk");
    s().addLabel(5, 9, "run");
    expect(s().dataset!.labels).toEqual([
      { startIndex: 0, endIndex: 4, label: "walk" },
      { startIndex: 5, endIndex: 9, label: "run" },
    ]);
    s().renameLabel(1, "walk"); // merges with neighbour
    expect(s().dataset!.labels).toEqual([{ startIndex: 0, endIndex: 9, label: "walk" }]);
    s().removeLabel(0);
    expect(s().dataset!.labels).toBeUndefined();
  });

  it("re-indexes labels when the dataset is cropped", async () => {
    load();
    const s = () => useEditorStore.getState();
    s().addLabel(0, 4, "walk");
    s().addLabel(5, 9, "run");
    await s().cropToSelection(3, 7);
    // window [3..7]: walk -> 0..1, run -> 2..4
    expect(s().dataset!.labels).toEqual([
      { startIndex: 0, endIndex: 1, label: "walk" },
      { startIndex: 2, endIndex: 4, label: "run" },
    ]);
  });

  it("exports a structured_labels.labels file", () => {
    load();
    useEditorStore.getState().addLabel(0, 9, "walk");
    const json = useEditorStore.getState().exportLabels();
    expect(json).toBeTruthy();
    const parsed = JSON.parse(json!);
    expect(parsed.type).toBe("structured-labels");
    expect(Object.values(parsed.structuredLabels)[0]).toEqual([
      { startIndex: 0, endIndex: 9, label: "walk" },
    ]);
  });
});

describe("store.cropToSelection trims full-resolution values", () => {
  beforeEach(() => {
    useEditorStore.getState().resetDataset();
  });

  it("trims every channel (and time) to the inclusive index window", async () => {
    const ds: Dataset = {
      source: "csv",
      name: "x",
      lanes: [],
      time: [0, 1, 2, 3, 4],
      channels: [
        {
          id: "a",
          name: "a",
          values: [0, 1, 2, 3, 4],
          color: "#000000",
          visible: true,
        },
        {
          id: "b",
          name: "b",
          values: [10, 11, 12, 13, 14],
          color: "#111111",
          visible: true,
        },
      ],
    };
    useEditorStore.getState().loadDataset(ds);
    await useEditorStore.getState().cropToSelection(1, 3);

    const cropped = useEditorStore.getState().dataset!;
    expect(cropped.channels[0].values).toEqual([1, 2, 3]);
    expect(cropped.channels[1].values).toEqual([11, 12, 13]);
    expect(cropped.time).toEqual([1, 2, 3]);
    // crop selection + mode cleared after applying
    expect(useEditorStore.getState().ui.cropSel).toBeNull();
    expect(useEditorStore.getState().ui.cropActive).toBe(false);
  });
});
