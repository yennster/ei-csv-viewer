import { describe, it, expect } from "vitest";
import {
  addLabelSegment,
  buildStructuredLabelsFile,
  cropLabels,
  distinctLabels,
  fillGaps,
  labelColor,
  mergeAdjacent,
  normalizeLabels,
  parseStructuredLabels,
  removeLabelAt,
  renameLabelAt,
  serializeStructuredLabels,
  validateLabels,
} from "@/lib/labels";
import type { StructuredLabel } from "@/lib/types";

const seg = (
  startIndex: number,
  endIndex: number,
  label: string,
): StructuredLabel => ({ startIndex, endIndex, label });

describe("labelColor", () => {
  it("is deterministic per label name", () => {
    expect(labelColor("walking")).toBe(labelColor("walking"));
    expect(labelColor("a")).not.toBe(undefined);
  });
  it("falls back to the first palette color for blank labels", () => {
    expect(labelColor("")).toBe(labelColor("  ".trim()));
  });
});

describe("normalizeLabels", () => {
  it("sorts by start, clamps to [0,length-1], and drops degenerate segments", () => {
    const out = normalizeLabels(
      [seg(5, 3, "b"), seg(-2, 1, "a"), seg(100, 200, "c")],
      10,
    );
    // seg(5,3) -> reordered to (3,5); seg(-2,1) -> (0,1); seg(100,200) -> (9,9)
    expect(out).toEqual([seg(0, 1, "a"), seg(3, 5, "b"), seg(9, 9, "c")]);
  });
  it("returns [] for empty/nullish input", () => {
    expect(normalizeLabels(undefined)).toEqual([]);
    expect(normalizeLabels([])).toEqual([]);
  });
});

describe("mergeAdjacent", () => {
  it("merges touching segments with the same label", () => {
    expect(mergeAdjacent([seg(0, 2, "a"), seg(3, 5, "a")])).toEqual([
      seg(0, 5, "a"),
    ]);
  });
  it("keeps different labels separate", () => {
    expect(mergeAdjacent([seg(0, 2, "a"), seg(3, 5, "b")])).toEqual([
      seg(0, 2, "a"),
      seg(3, 5, "b"),
    ]);
  });
});

describe("addLabelSegment", () => {
  it("adds a label over empty space", () => {
    expect(addLabelSegment([], 0, 4, "a", 10)).toEqual([seg(0, 4, "a")]);
  });

  it("carves the new range out of an overlapping segment (splits it)", () => {
    // existing 'a' over 0..9; insert 'b' over 3..5 -> a[0..2], b[3..5], a[6..9]
    const out = addLabelSegment([seg(0, 9, "a")], 3, 5, "b", 10);
    expect(out).toEqual([seg(0, 2, "a"), seg(3, 5, "b"), seg(6, 9, "a")]);
  });

  it("trims a partially-overlapping neighbour", () => {
    const out = addLabelSegment([seg(0, 5, "a")], 4, 9, "b", 10);
    expect(out).toEqual([seg(0, 3, "a"), seg(4, 9, "b")]);
  });

  it("merges with an adjacent same-label segment", () => {
    const out = addLabelSegment([seg(0, 4, "a")], 5, 9, "a", 10);
    expect(out).toEqual([seg(0, 9, "a")]);
  });

  it("fully replaces a covered segment", () => {
    const out = addLabelSegment([seg(2, 4, "a")], 0, 9, "b", 10);
    expect(out).toEqual([seg(0, 9, "b")]);
  });
});

describe("removeLabelAt / renameLabelAt", () => {
  it("removes by index", () => {
    expect(removeLabelAt([seg(0, 1, "a"), seg(2, 3, "b")], 0)).toEqual([
      seg(2, 3, "b"),
    ]);
  });
  it("renames and merges with a now-matching neighbour", () => {
    const out = renameLabelAt([seg(0, 2, "a"), seg(3, 5, "b")], 1, "a");
    expect(out).toEqual([seg(0, 5, "a")]);
  });
});

describe("fillGaps", () => {
  it("fills head, middle, and tail gaps so the cover is continuous", () => {
    const out = fillGaps([seg(2, 4, "a"), seg(7, 8, "b")], 10, "x");
    expect(out).toEqual([
      seg(0, 1, "x"),
      seg(2, 4, "a"),
      seg(5, 6, "x"),
      seg(7, 8, "b"),
      seg(9, 9, "x"),
    ]);
  });
  it("fills the whole range when there are no labels", () => {
    expect(fillGaps([], 5, "x")).toEqual([seg(0, 4, "x")]);
  });
});

describe("cropLabels", () => {
  it("shifts and clamps segments to the kept window, dropping outside ones", () => {
    const labels = [seg(0, 2, "a"), seg(3, 6, "b"), seg(7, 9, "c")];
    // keep [3..7] -> b becomes 0..3, c becomes 4..4; a is dropped
    expect(cropLabels(labels, 3, 7)).toEqual([seg(0, 3, "b"), seg(4, 4, "c")]);
  });
  it("handles reversed bounds", () => {
    expect(cropLabels([seg(0, 9, "a")], 7, 3)).toEqual([seg(0, 4, "a")]);
  });
});

describe("validateLabels", () => {
  it("accepts a continuous, non-overlapping full-length cover", () => {
    const v = validateLabels([seg(0, 4, "a"), seg(5, 9, "b")], 10);
    expect(v.ok).toBe(true);
    expect(v.nonOverlapping).toBe(true);
    expect(v.continuous).toBe(true);
    expect(v.fullLength).toBe(true);
    expect(v.gaps).toEqual([]);
  });

  it("flags a gap", () => {
    const v = validateLabels([seg(0, 2, "a"), seg(5, 9, "b")], 10);
    expect(v.ok).toBe(false);
    expect(v.continuous).toBe(false);
    expect(v.gaps).toContainEqual({ startIndex: 3, endIndex: 4 });
  });

  it("flags a tail gap (not full length)", () => {
    const v = validateLabels([seg(0, 4, "a")], 10);
    expect(v.fullLength).toBe(false);
    expect(v.gaps).toContainEqual({ startIndex: 5, endIndex: 9 });
  });

  it("flags overlaps", () => {
    const v = validateLabels([seg(0, 5, "a"), seg(4, 9, "b")], 10);
    expect(v.nonOverlapping).toBe(false);
    expect(v.overlaps.length).toBeGreaterThan(0);
  });

  it("treats empty labels as valid (single-label sample)", () => {
    const v = validateLabels([], 10);
    expect(v.ok).toBe(true);
    expect(v.fullLength).toBe(false);
  });
});

describe("structured_labels.labels (de)serialization", () => {
  it("builds the versioned file keyed by data file name", () => {
    const file = buildStructuredLabelsFile("updown.3.json", [
      seg(0, 300, "first_label"),
      seg(301, 621, "second_label"),
    ]);
    expect(file).toEqual({
      version: 1,
      type: "structured-labels",
      structuredLabels: {
        "updown.3.json": [
          { startIndex: 0, endIndex: 300, label: "first_label" },
          { startIndex: 301, endIndex: 621, label: "second_label" },
        ],
      },
    });
  });

  it("round-trips through serialize + parse", () => {
    const labels = [seg(0, 2, "a"), seg(3, 5, "b")];
    const json = serializeStructuredLabels("x.json", labels);
    expect(parseStructuredLabels(json, "x.json")).toEqual(labels);
  });

  it("parses the first file's segments when no name is given", () => {
    const json = JSON.stringify({
      version: 1,
      type: "structured-labels",
      structuredLabels: { "a.json": [{ startIndex: 0, endIndex: 1, label: "z" }] },
    });
    expect(parseStructuredLabels(json)).toEqual([seg(0, 1, "z")]);
  });

  it("returns [] on malformed input", () => {
    expect(parseStructuredLabels("not json")).toEqual([]);
    expect(parseStructuredLabels({})).toEqual([]);
    expect(parseStructuredLabels({ structuredLabels: { f: "nope" } })).toEqual([]);
  });
});

describe("distinctLabels", () => {
  it("returns first-seen unique label names", () => {
    expect(
      distinctLabels([seg(0, 1, "a"), seg(2, 3, "b"), seg(4, 5, "a")]),
    ).toEqual(["a", "b"]);
  });
});
