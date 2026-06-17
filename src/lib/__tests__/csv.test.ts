import { describe, it, expect } from "vitest";
import {
  parseCsv,
  parseCsvString,
  serializeCsv,
} from "@/lib/csv";
import type { Dataset } from "@/lib/types";

describe("parseCsv / parseCsvString", () => {
  it("parses a header + leading timestamp column into time and channels", () => {
    const csv = ["timestamp,accX,accY", "0,1,4", "10,2,5", "20,3,6"].join("\n");
    const ds = parseCsvString(csv);

    expect(ds.source).toBe("csv");
    expect(ds.time).toEqual([0, 10, 20]);
    expect(ds.channels).toHaveLength(2);
    expect(ds.channels.map((c) => c.name)).toEqual(["accX", "accY"]);
    expect(ds.channels[0].values).toEqual([1, 2, 3]);
    expect(ds.channels[1].values).toEqual([4, 5, 6]);
  });

  it("detects a non-time-named numeric first column when monotonic with multiple channels", () => {
    const csv = ["idx,a,b", "0,5,9", "1,6,8", "2,7,7"].join("\n");
    const ds = parseCsvString(csv);
    expect(ds.time).toEqual([0, 1, 2]);
    expect(ds.channels.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("does NOT treat a single numeric column as a time axis", () => {
    const csv = ["signal", "0", "1", "2"].join("\n");
    const ds = parseCsvString(csv);
    expect(ds.time).toBeUndefined();
    expect(ds.channels).toHaveLength(1);
    expect(ds.channels[0].name).toBe("signal");
    expect(ds.channels[0].values).toEqual([0, 1, 2]);
  });

  it("treats all columns as channels when the first column is not monotonic", () => {
    const csv = ["a,b", "5,1", "1,2", "9,3"].join("\n");
    const ds = parseCsvString(csv);
    expect(ds.time).toBeUndefined();
    expect(ds.channels).toHaveLength(2);
    expect(ds.channels[0].values).toEqual([5, 1, 9]);
  });

  it("parses a headerless numeric grid (no time, channels named by position)", () => {
    const csv = ["3,1", "1,2", "9,3"].join("\n");
    const ds = parseCsvString(csv);
    expect(ds.time).toBeUndefined();
    expect(ds.channels.map((c) => c.name)).toEqual(["channel 1", "channel 2"]);
    expect(ds.channels[0].values).toEqual([3, 1, 9]);
  });

  it("coerces non-numeric and empty cells to NaN gracefully", () => {
    const csv = ["t,x", "0,1", "1,abc", "2,", "3,4"].join("\n");
    const ds = parseCsvString(csv);
    const x = ds.channels[0].values;
    expect(x[0]).toBe(1);
    expect(Number.isNaN(x[1])).toBe(true); // "abc"
    expect(Number.isNaN(x[2])).toBe(true); // empty
    expect(x[3]).toBe(4);
  });

  it("pads ragged rows with NaN to the widest row", () => {
    const csv = ["t,x,y", "0,1,2", "1,3", "2,4,5,6"].join("\n");
    const ds = parseCsvString(csv);
    // width = 4 -> time + 3 channels
    expect(ds.channels).toHaveLength(3);
    // row "1,3" is missing y -> NaN
    expect(Number.isNaN(ds.channels[1].values[1])).toBe(true);
    // row "2,4,5,6" has an extra column 6 -> third channel
    expect(ds.channels[2].values[2]).toBe(6);
    // earlier rows lacked the 4th column -> NaN
    expect(Number.isNaN(ds.channels[2].values[0])).toBe(true);
  });

  it("returns an empty dataset for empty input", () => {
    const ds = parseCsvString("");
    expect(ds.channels).toHaveLength(0);
    expect(ds.time).toBeUndefined();
    expect(ds.source).toBe("csv");
  });

  it("handles a header-only file (no data rows)", () => {
    const ds = parseCsvString("timestamp,a,b");
    // No data rows: width comes from the header, channels have empty values.
    expect(ds.channels.map((c) => c.name)).toEqual(["a", "b"]);
    expect(ds.channels[0].values).toEqual([]);
  });

  it("assigns stable colors and deterministic ids", () => {
    const csv = ["t,a,b", "0,1,2"].join("\n");
    const ds = parseCsvString(csv);
    expect(ds.channels[0].id).toBe("ch_0");
    expect(ds.channels[1].id).toBe("ch_1");
    expect(ds.channels[0].color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(ds.channels[0].color).not.toBe(ds.channels[1].color);
    // Deterministic: parsing the same text twice yields identical colors/ids.
    const ds2 = parseCsvString(csv);
    expect(ds2.channels[0].color).toBe(ds.channels[0].color);
    expect(ds2.channels[0].id).toBe(ds.channels[0].id);
  });

  it("honors a custom idFactory and name", () => {
    const csv = ["t,a", "0,1"].join("\n");
    const ds = parseCsvString(csv, {
      name: "my.csv",
      idFactory: (i, n) => `${n}-${i}`,
    });
    expect(ds.name).toBe("my.csv");
    expect(ds.channels[0].id).toBe("a-0");
  });

  it("forces presence/absence of a time column via hasTimeColumn", () => {
    const noForce = parseCsvString(["a,b", "5,1", "1,2"].join("\n"));
    expect(noForce.time).toBeUndefined();
    const forced = parseCsvString(["a,b", "5,1", "1,2"].join("\n"), {
      hasTimeColumn: true,
    });
    expect(forced.time).toEqual([5, 1]);
    expect(forced.channels).toHaveLength(1);
    expect(forced.channels[0].name).toBe("b");
  });

  it("parses from a File/Blob asynchronously, using the file name", async () => {
    const csv = ["t,a", "0,1", "1,2"].join("\n");
    const file = new File([csv], "data.csv", { type: "text/csv" });
    const ds = await parseCsv(file);
    expect(ds.name).toBe("data.csv");
    expect(ds.time).toEqual([0, 1]);
    expect(ds.channels[0].values).toEqual([1, 2]);
  });

  it("parses from a plain string via the async entry point too", async () => {
    const ds = await parseCsv("t,a\n0,9\n1,8");
    expect(ds.channels[0].values).toEqual([9, 8]);
  });
});

describe("serializeCsv", () => {
  it("writes a timestamp column then one column per channel", () => {
    const ds: Dataset = {
      source: "csv",
      name: "x",
      lanes: [],
      time: [0, 1, 2],
      channels: [
        { id: "a", name: "accX", values: [1, 2, 3], color: "#000", visible: true },
        { id: "b", name: "accY", values: [4, 5, 6], color: "#111", visible: true },
      ],
    };
    const out = serializeCsv(ds);
    expect(out).toBe(
      ["timestamp,accX,accY", "0,1,4", "1,2,5", "2,3,6"].join("\n"),
    );
  });

  it("omits the timestamp column when there is no time axis", () => {
    const ds: Dataset = {
      source: "csv",
      name: "x",
      lanes: [],
      channels: [
        { id: "a", name: "x", values: [1, 2], color: "#000", visible: true },
      ],
    };
    const out = serializeCsv(ds);
    expect(out).toBe(["x", "1", "2"].join("\n"));
  });

  it("writes empty cells for NaN / missing values", () => {
    const ds: Dataset = {
      source: "csv",
      name: "x",
      lanes: [],
      time: [0, 1, 2],
      channels: [
        { id: "a", name: "x", values: [1, NaN, 3], color: "#000", visible: true },
        { id: "b", name: "y", values: [4, 5], color: "#111", visible: true },
      ],
    };
    const out = serializeCsv(ds);
    const lines = out.split("\n");
    expect(lines[0]).toBe("timestamp,x,y");
    expect(lines[2]).toBe("1,,5"); // NaN -> empty
    expect(lines[3]).toBe("2,3,"); // y shorter -> empty
  });

  it("respects a custom time header and visibleOnly", () => {
    const ds: Dataset = {
      source: "csv",
      name: "x",
      lanes: [],
      time: [0, 1],
      channels: [
        { id: "a", name: "x", values: [1, 2], color: "#000", visible: true },
        { id: "b", name: "y", values: [3, 4], color: "#111", visible: false },
      ],
    };
    const out = serializeCsv(ds, { timeHeader: "t", visibleOnly: true });
    expect(out.split("\n")[0]).toBe("t,x");
    expect(out.split("\n")[1]).toBe("0,1");
  });

  it("round-trips: parse -> serialize -> parse preserves numeric data", () => {
    const original = ["timestamp,a,b", "0,1.5,10", "10,2.5,20", "20,3.5,30"].join(
      "\n",
    );
    const ds = parseCsvString(original);
    const text = serializeCsv(ds);
    const reparsed = parseCsvString(text);

    expect(reparsed.time).toEqual(ds.time);
    expect(reparsed.channels.map((c) => c.name)).toEqual(
      ds.channels.map((c) => c.name),
    );
    expect(reparsed.channels[0].values).toEqual(ds.channels[0].values);
    expect(reparsed.channels[1].values).toEqual(ds.channels[1].values);
  });

  it("round-trips a headerless channel-only grid", () => {
    const ds = parseCsvString(["3,1", "1,2", "9,3"].join("\n"));
    const text = serializeCsv(ds);
    const reparsed = parseCsvString(text);
    expect(reparsed.channels[0].values).toEqual([3, 1, 9]);
    expect(reparsed.channels[1].values).toEqual([1, 2, 3]);
  });
});
