import { describe, it, expect } from "vitest";
import {
  channelRange,
  magnitudeBucket,
  FLAT_BUCKET,
  quantile,
  robustSpan,
  rangeBucket,
  autoGroupLanes,
  presetOneLanePerChannel,
  presetSingleLane,
  cropDataset,
  downsample,
  makeChannelColor,
  toEiPayload,
} from "@/lib/timeseries";
import type { Channel, Dataset } from "@/lib/types";

function ch(
  id: string,
  values: number[],
  extra: Partial<Channel> = {},
): Channel {
  return {
    id,
    name: extra.name ?? id,
    values,
    color: extra.color ?? "#000000",
    visible: extra.visible ?? true,
    ...extra,
  };
}

const detIds = (i: number) => `lane_${i}`;

describe("channelRange", () => {
  it("returns finite min/max ignoring NaN and Infinity", () => {
    expect(channelRange(ch("a", [3, 1, 2]))).toEqual({ min: 1, max: 3 });
    expect(channelRange(ch("a", [NaN, 5, Infinity, -2]))).toEqual({
      min: -2,
      max: 5,
    });
  });

  it("returns NaN bounds for an all-non-finite channel", () => {
    const r = channelRange(ch("a", [NaN, Infinity, -Infinity]));
    expect(Number.isNaN(r.min)).toBe(true);
    expect(Number.isNaN(r.max)).toBe(true);
  });

  it("returns NaN bounds for an empty channel", () => {
    const r = channelRange(ch("a", []));
    expect(Number.isNaN(r.min)).toBe(true);
  });
});

describe("magnitudeBucket", () => {
  it("buckets by order of magnitude of the span", () => {
    expect(magnitudeBucket({ min: 0, max: 1000 })).toBe(3); // span 1000 -> floor(log10)=3
    expect(magnitudeBucket({ min: 0, max: 0.05 })).toBe(-2); // span 0.05 -> floor(log10)=-2
  });

  it("computes floor(log10(span)) exactly", () => {
    expect(magnitudeBucket({ min: 0, max: 1 })).toBe(0); // log10(1)=0
    expect(magnitudeBucket({ min: 0, max: 0.5 })).toBe(-1); // log10(0.5)≈-0.30
    expect(magnitudeBucket({ min: 0, max: 9.9 })).toBe(0); // log10(9.9)≈0.99
    expect(magnitudeBucket({ min: 0, max: 100 })).toBe(2);
    expect(magnitudeBucket({ min: -500, max: 500 })).toBe(3); // span 1000
  });

  it("returns FLAT_BUCKET for flat / degenerate ranges", () => {
    expect(magnitudeBucket({ min: 5, max: 5 })).toBe(FLAT_BUCKET);
    expect(magnitudeBucket({ min: NaN, max: NaN })).toBe(FLAT_BUCKET);
    expect(magnitudeBucket({ min: 0, max: -1 })).toBe(FLAT_BUCKET); // span < 0
  });
});

describe("quantile", () => {
  it("interpolates linearly on a sorted copy", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([10, 0, 5], 0.5)).toBe(5); // sorts internally
  });

  it("ignores non-finite values and handles degenerate input", () => {
    expect(quantile([NaN, 5, Infinity], 0.5)).toBe(5);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
    expect(Number.isNaN(quantile([NaN], 0.5))).toBe(true);
  });

  it("does not mutate the input", () => {
    const v = [3, 1, 2];
    quantile(v, 0.5);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe("robustSpan", () => {
  it("returns the p99-p1 span and resists a single outlier spike", () => {
    const base = Array.from({ length: 100 }, (_, i) => i / 100); // 0..0.99
    const spiked = [...base, 1000]; // one huge outlier
    const s = robustSpan(spiked);
    expect(s).not.toBeNull();
    // The robust span stays ~1, not ~1000, because p99 clips the spike.
    expect(s!).toBeLessThan(5);
  });

  it("returns null for fewer than 2 finite samples", () => {
    expect(robustSpan([])).toBeNull();
    expect(robustSpan([5])).toBeNull();
    expect(robustSpan([NaN, Infinity])).toBeNull();
  });
});

describe("rangeBucket (robust + offsetGuard)", () => {
  it("separates a near-constant-but-offset signal (100..101) from 0..1", () => {
    const offset = rangeBucket([100, 100.5, 101]);
    const small = rangeBucket([0, 0.5, 1]);
    expect(offset).not.toBe(small);
  });

  it("keeps a single spike in an otherwise 0..1 channel out of a high bucket", () => {
    // 1000 in-range samples so one outlier sits well beyond p99.
    const base = Array.from({ length: 1000 }, (_, i) => i / 1000); // 0..0.999
    const clean = rangeBucket(base);
    const withSpike = rangeBucket([...base, 1000]);
    // The percentile span absorbs the lone spike: same bucket as the clean one.
    expect(withSpike).toBe(clean);
  });

  it("returns FLAT_BUCKET for constant / all-NaN channels", () => {
    expect(rangeBucket([5, 5, 5])).toBe(FLAT_BUCKET);
    expect(rangeBucket([NaN, NaN])).toBe(FLAT_BUCKET);
    expect(rangeBucket([7])).toBe(FLAT_BUCKET);
  });
});

describe("autoGroupLanes (core feature)", () => {
  it("does NOT merge a 100..101 channel with a 0..1 channel (offsetGuard)", () => {
    const channels = [
      ch("offset", [100, 100.5, 101]),
      ch("small", [0, 0.5, 1]),
    ];
    const lanes = autoGroupLanes(channels, { idFactory: detIds });
    expect(lanes.length).toBeGreaterThanOrEqual(2);
    // The two channels never share a lane.
    const offsetLane = lanes.find((l) => l.channelIds.includes("offset"));
    expect(offsetLane?.channelIds).not.toContain("small");
  });

  it("keeps a spiky 0..1 channel grouped with a clean 0..1 channel", () => {
    // 1000 samples so a single hidden spike sits well beyond p99 and the robust
    // span keeps the spiky channel in the same magnitude bucket as the clean one.
    const clean = Array.from({ length: 1000 }, (_, i) => i / 1000);
    const spiky = clean.slice();
    spiky[500] = 999; // hidden outlier
    const channels = [ch("clean", clean), ch("spiky", spiky)];
    const lanes = autoGroupLanes(channels, { idFactory: detIds });
    expect(lanes).toHaveLength(1);
    expect(lanes[0].channelIds).toEqual(["clean", "spiky"]);
  });


  it("separates a 0..1000 channel from a 0..1 channel into different lanes", () => {
    const channels = [
      ch("big", [0, 500, 1000]),
      ch("small", [0, 0.5, 1]),
    ];
    const lanes = autoGroupLanes(channels, { idFactory: detIds });
    expect(lanes).toHaveLength(2);
    // Largest-magnitude lane first.
    expect(lanes[0].channelIds).toEqual(["big"]);
    expect(lanes[1].channelIds).toEqual(["small"]);
    expect(lanes.every((l) => l.yAuto)).toBe(true);
  });

  it("groups channels that share a magnitude bucket into one lane", () => {
    const channels = [
      ch("x", [-2, 0, 2]), // span 4 -> bucket 0
      ch("y", [-1, 0, 3]), // span 4 -> bucket 0
      ch("z", [1, 5, 9]), // span 8 -> bucket 0
    ];
    const lanes = autoGroupLanes(channels, { idFactory: detIds });
    expect(lanes).toHaveLength(1);
    expect(lanes[0].channelIds).toEqual(["x", "y", "z"]);
  });

  it("separates same-decade channels that are still ~5x apart (accY/accZ bug)", () => {
    // Idle IMU: accX ~ -0.06, accY ~ -1.8, accZ ~ -9.6. accY and accZ share the
    // same log10 decade yet are ~5x apart — whole-decade bucketing put them in
    // one lane and crushed accY into an invisible sliver. Each must get a lane.
    const channels = [
      ch("accX", [-0.06, -0.05, -0.07, -0.06]),
      ch("accY", [-1.81, -1.8, -1.82, -1.79]),
      ch("accZ", [-9.62, -9.6, -9.65, -9.61]),
    ];
    const lanes = autoGroupLanes(channels, { idFactory: detIds });
    expect(lanes).toHaveLength(3);
    expect(
      lanes.find((l) => l.channelIds.includes("accY"))?.channelIds,
    ).toEqual(["accY"]);
    expect(
      lanes.find((l) => l.channelIds.includes("accZ"))?.channelIds,
    ).toEqual(["accZ"]);
  });

  it("preserves channel order within a bucket", () => {
    const channels = [
      ch("a", [0, 5]),
      ch("b", [0, 6]),
      ch("c", [0, 7]),
    ];
    const lanes = autoGroupLanes(channels, { idFactory: detIds });
    expect(lanes[0].channelIds).toEqual(["a", "b", "c"]);
  });

  it("puts constant / all-NaN channels in a trailing 'flat' lane, never throwing", () => {
    const channels = [
      ch("varied", [0, 100]),
      ch("constant", [5, 5, 5]),
      ch("nanny", [NaN, NaN]),
    ];
    const lanes = autoGroupLanes(channels, { idFactory: detIds });
    const flatLane = lanes[lanes.length - 1];
    expect(flatLane.title).toBe("Constant");
    expect(flatLane.channelIds).toEqual(["constant", "nanny"]);
  });

  it("orders numeric buckets descending by magnitude", () => {
    const channels = [
      ch("tiny", [0, 0.01]), // bucket -2
      ch("huge", [0, 100000]), // bucket 5
      ch("mid", [0, 50]), // bucket 1
    ];
    const lanes = autoGroupLanes(channels, { idFactory: detIds });
    expect(lanes.map((l) => l.channelIds[0])).toEqual(["huge", "mid", "tiny"]);
  });

  it("caps lane count and merges the least-populated adjacent buckets", () => {
    // 8 distinct magnitudes, maxLanes 6 -> 6 lanes.
    const channels = Array.from({ length: 8 }, (_, i) =>
      ch(`c${i}`, [0, Math.pow(10, i) * 5]),
    );
    const lanes = autoGroupLanes(channels, { idFactory: detIds, maxLanes: 6 });
    expect(lanes.length).toBe(6);
    // No channel is dropped.
    const all = lanes.flatMap((l) => l.channelIds).sort();
    expect(all).toEqual(channels.map((c) => c.id).sort());
  });

  it("returns [] for no channels", () => {
    expect(autoGroupLanes([], { idFactory: detIds })).toEqual([]);
  });

  it("uses deterministic lane ids from idFactory", () => {
    const lanes = autoGroupLanes([ch("a", [0, 1])], { idFactory: detIds });
    expect(lanes[0].id).toBe("lane_0");
  });
});

describe("presets", () => {
  it("presetOneLanePerChannel makes one lane per channel titled by name", () => {
    const channels = [
      ch("a", [1], { name: "Accel X" }),
      ch("b", [2], { name: "Accel Y" }),
    ];
    const lanes = presetOneLanePerChannel(channels, detIds);
    expect(lanes).toHaveLength(2);
    expect(lanes[0].title).toBe("Accel X");
    expect(lanes[0].channelIds).toEqual(["a"]);
    expect(lanes[1].channelIds).toEqual(["b"]);
  });

  it("presetSingleLane puts every channel in one lane", () => {
    const channels = [ch("a", [1]), ch("b", [2]), ch("c", [3])];
    const lanes = presetSingleLane(channels, detIds);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].channelIds).toEqual(["a", "b", "c"]);
    expect(lanes[0].title).toBe("All channels");
  });

  it("presetSingleLane on no channels returns []", () => {
    expect(presetSingleLane([], detIds)).toEqual([]);
  });
});

describe("cropDataset", () => {
  const base: Dataset = {
    source: "csv",
    name: "x",
    lanes: [],
    time: [0, 10, 20, 30, 40],
    channels: [
      ch("a", [0, 1, 2, 3, 4]),
      ch("b", [10, 11, 12, 13, 14]),
    ],
  };

  it("trims time and all channels to the inclusive window", () => {
    const out = cropDataset(base, 1, 3);
    expect(out.time).toEqual([10, 20, 30]);
    expect(out.channels[0].values).toEqual([1, 2, 3]);
    expect(out.channels[1].values).toEqual([11, 12, 13]);
  });

  it("does not mutate the source dataset", () => {
    cropDataset(base, 1, 3);
    expect(base.channels[0].values).toEqual([0, 1, 2, 3, 4]);
    expect(base.time).toEqual([0, 10, 20, 30, 40]);
  });

  it("clamps out-of-range bounds", () => {
    const out = cropDataset(base, -5, 100);
    expect(out.channels[0].values).toEqual([0, 1, 2, 3, 4]);
    expect(out.time).toEqual([0, 10, 20, 30, 40]);
  });

  it("normalizes reversed bounds", () => {
    const out = cropDataset(base, 3, 1);
    expect(out.channels[0].values).toEqual([1, 2, 3]);
  });

  it("supports a single-sample crop", () => {
    const out = cropDataset(base, 2, 2);
    expect(out.channels[0].values).toEqual([2]);
    expect(out.time).toEqual([20]);
  });

  it("handles datasets with no time axis", () => {
    const ds: Dataset = {
      source: "csv",
      name: "x",
      lanes: [],
      channels: [ch("a", [0, 1, 2, 3])],
    };
    const out = cropDataset(ds, 1, 2);
    expect(out.time).toBeUndefined();
    expect(out.channels[0].values).toEqual([1, 2]);
  });
});

describe("downsample", () => {
  it("returns the full series when below maxPoints", () => {
    const out = downsample([1, 2, 3], 100);
    expect(out.values).toEqual([1, 2, 3]);
    expect(out.indices).toEqual([0, 1, 2]);
  });

  it("preserves the min and max within each bucket", () => {
    // Hide an extreme peak in the middle of an otherwise small series.
    const values = [0, 0, 0, 0, 1000, 0, 0, 0, 0, -1000, 0, 0];
    const out = downsample(values, 6);
    expect(out.values).toContain(1000);
    expect(out.values).toContain(-1000);
    expect(out.values.length).toBeLessThanOrEqual(6);
  });

  it("never exceeds maxPoints", () => {
    const values = Array.from({ length: 10000 }, (_, i) => Math.sin(i));
    const out = downsample(values, 200);
    expect(out.values.length).toBeLessThanOrEqual(200);
    expect(out.indices.length).toBe(out.values.length);
  });

  it("returns ascending, valid original indices", () => {
    const values = Array.from({ length: 1000 }, (_, i) => (i % 7) - 3);
    const out = downsample(values, 50);
    for (let i = 1; i < out.indices.length; i++) {
      expect(out.indices[i]).toBeGreaterThanOrEqual(out.indices[i - 1]);
    }
    for (let i = 0; i < out.indices.length; i++) {
      const idx = out.indices[i];
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(values.length);
      // The decimated value equals the original at that index.
      expect(out.values[i]).toBe(values[idx]);
    }
  });

  it("preserves global extremes of a large noisy series", () => {
    const values = Array.from({ length: 5000 }, (_, i) => Math.sin(i / 10));
    values[1234] = 99; // hidden global max
    values[4321] = -99; // hidden global min
    const out = downsample(values, 400);
    expect(Math.max(...out.values)).toBe(99);
    expect(Math.min(...out.values)).toBe(-99);
  });

  it("handles empty input and non-positive budgets", () => {
    expect(downsample([], 100)).toEqual({ values: [], indices: [] });
    expect(downsample([1, 2, 3], 0)).toEqual({ values: [], indices: [] });
  });

  it("does not mutate the input array", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const copy = values.slice();
    downsample(values, 50);
    expect(values).toEqual(copy);
  });
});

describe("makeChannelColor", () => {
  it("is stable and distinct for the first palette entries", () => {
    const a = makeChannelColor(0);
    const b = makeChannelColor(1);
    expect(a).toMatch(/^#[0-9a-f]{6}$/i);
    expect(a).not.toBe(b);
    expect(makeChannelColor(0)).toBe(a); // stable
  });

  it("produces valid hex colors beyond the palette length via hue rotation", () => {
    for (let i = 0; i < 40; i++) {
      expect(makeChannelColor(i)).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // A wrapped index differs from its base palette color.
    expect(makeChannelColor(12)).not.toBe(makeChannelColor(0));
  });

  it("falls back to the first palette color for invalid indices", () => {
    expect(makeChannelColor(-1)).toBe(makeChannelColor(0));
    expect(makeChannelColor(1.5)).toBe(makeChannelColor(0));
  });
});

describe("toEiPayload", () => {
  const ds: Dataset = {
    source: "csv",
    name: "x",
    lanes: [],
    intervalMs: 10,
    channels: [
      ch("a", [1, 2, 3], { name: "accX", units: "m/s2" }),
      ch("b", [4, 5, 6], { name: "accY" }),
    ],
  };

  it("transposes per-channel storage into per-timestep rows", () => {
    const p = toEiPayload(ds);
    expect(p.values).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    expect(p.sensors).toEqual([
      { name: "accX", units: "m/s2" },
      { name: "accY", units: "N/A" },
    ]);
    expect(p.intervalMs).toBe(10);
  });

  it("excludes hidden channels", () => {
    const hidden: Dataset = {
      ...ds,
      channels: [
        ch("a", [1, 2], { name: "x" }),
        ch("b", [3, 4], { name: "y", visible: false }),
      ],
    };
    const p = toEiPayload(hidden);
    expect(p.sensors.map((s) => s.name)).toEqual(["x"]);
    expect(p.values).toEqual([[1], [2]]);
  });

  it("coerces non-finite samples to 0", () => {
    const withNaN: Dataset = {
      ...ds,
      intervalMs: 5,
      channels: [ch("a", [1, NaN, Infinity], { name: "x" })],
    };
    const p = toEiPayload(withNaN);
    expect(p.values).toEqual([[1], [0], [0]]);
  });

  it("derives intervalMs from frequencyHz when intervalMs is absent", () => {
    const freq: Dataset = {
      source: "csv",
      name: "x",
      lanes: [],
      frequencyHz: 100,
      channels: [ch("a", [1, 2], { name: "x" })],
    };
    expect(toEiPayload(freq).intervalMs).toBe(10);
  });

  it("derives intervalMs from a time axis (seconds -> ms) as a fallback", () => {
    const timed: Dataset = {
      source: "csv",
      name: "x",
      lanes: [],
      time: [0, 0.02, 0.04, 0.06],
      channels: [ch("a", [1, 2, 3, 4], { name: "x" })],
    };
    expect(toEiPayload(timed).intervalMs).toBeCloseTo(20, 6);
  });

  it("returns 0 intervalMs when timing is unknown", () => {
    const noTiming: Dataset = {
      source: "csv",
      name: "x",
      lanes: [],
      channels: [ch("a", [1, 2], { name: "x" })],
    };
    expect(toEiPayload(noTiming).intervalMs).toBe(0);
  });
});
