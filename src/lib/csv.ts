// src/lib/csv.ts — CSV import/export engine for the Edge Impulse CSV Editor.
//
// parseCsv(textOrFile): detect a header row, detect an optional leading
//   timestamp/index column, and turn the remaining columns into Channels.
//   Non-numeric cells, ragged rows, empty cells, and NaN are handled
//   gracefully (coerced to NaN / padded as needed).
//
// serializeCsv(dataset): produce a CSV string with the timestamp column
//   first (when the dataset has an explicit time axis) followed by one column
//   per channel in the dataset's current channel order.
//
// Everything here is pure and deterministic: colors are assigned by index and
// channel ids are produced by an injectable id factory (default deterministic).

import Papa from "papaparse";
import type { Channel, Dataset } from "@/lib/types";
import { makeChannelColor } from "@/lib/timeseries";

/** Options for {@link parseCsv}. All optional. */
export interface ParseCsvOptions {
  /** Dataset name (e.g. the file name). Defaults to "imported.csv". */
  name?: string;
  /**
   * Deterministic channel id factory. Receives the 0-based channel index and
   * the channel name. Defaults to `ch_<index>` so library logic stays pure.
   */
  idFactory?: (index: number, name: string) => string;
  /**
   * Force whether the first column is treated as a timestamp/index column.
   * When omitted the column is auto-detected.
   */
  hasTimeColumn?: boolean;
}

const DEFAULT_NAME = "imported.csv";
const defaultIdFactory = (index: number): string => `ch_${index}`;

/** Header tokens that strongly imply the first column is a time/index axis. */
const TIME_HEADER_RE =
  /^(time|timestamp|t|ts|sec|secs|second|seconds|ms|millis|millisecond|milliseconds|index|idx|sample|samples|sample_?index|x|elapsed)$/i;

/**
 * Parse `null`/`undefined`/empty/whitespace -> NaN, otherwise the float value.
 * Non-numeric strings also become NaN. Booleans and other types -> NaN.
 */
function toNumber(cell: unknown): number {
  if (cell === null || cell === undefined) return NaN;
  if (typeof cell === "number") return cell;
  if (typeof cell === "string") {
    const trimmed = cell.trim();
    if (trimmed === "") return NaN;
    // Number() is stricter than parseFloat ("12px" -> NaN), which is what we
    // want for "skip non-numeric gracefully".
    const n = Number(trimmed);
    return Number.isNaN(n) ? NaN : n;
  }
  return NaN;
}

/** True when the trimmed string parses as a finite number. */
function looksNumeric(cell: unknown): boolean {
  if (typeof cell === "number") return Number.isFinite(cell);
  if (typeof cell !== "string") return false;
  const trimmed = cell.trim();
  if (trimmed === "") return false;
  return Number.isFinite(Number(trimmed));
}

/**
 * Decide whether the parsed grid has a header row. Heuristic: if any cell in
 * the first row is non-numeric while the second row's corresponding cell is
 * numeric, the first row is a header. A grid whose first row is entirely
 * non-numeric is also treated as a header.
 */
function detectHeader(rows: unknown[][]): boolean {
  if (rows.length === 0) return false;
  const first = rows[0];
  const firstNonNumeric = first.some((c) => c !== "" && c != null && !looksNumeric(c));
  if (!firstNonNumeric) return false;
  if (rows.length === 1) return true; // header-only file
  // Confirm the second row is "more numeric" than the first.
  const second = rows[1];
  const firstNumericCount = first.filter((c) => looksNumeric(c)).length;
  const secondNumericCount = second.filter((c) => looksNumeric(c)).length;
  return secondNumericCount >= firstNumericCount;
}

/**
 * Decide whether the first column is a timestamp/index axis.
 * Triggers when the header token matches {@link TIME_HEADER_RE}, OR when the
 * first column is numeric, monotonically non-decreasing, and there is more than
 * one data column (so a single-column file stays a channel, not a time axis).
 */
function detectTimeColumn(
  header: string[] | null,
  columns: number[][],
): boolean {
  if (columns.length < 2) return false; // need at least time + 1 channel
  if (header && header.length > 0 && TIME_HEADER_RE.test(header[0].trim())) {
    return true;
  }
  const first = columns[0];
  const finite = first.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return false;
  // Monotonically non-decreasing and strictly increasing overall (an index).
  let nonDecreasing = true;
  for (let i = 1; i < finite.length; i++) {
    if (finite[i] < finite[i - 1]) {
      nonDecreasing = false;
      break;
    }
  }
  const strictlyIncreasing = finite[finite.length - 1] > finite[0];
  return nonDecreasing && strictlyIncreasing;
}

/** Transpose a ragged row grid into fixed-length numeric columns (NaN-padded). */
function toColumns(rows: unknown[][], width: number): number[][] {
  const columns: number[][] = Array.from({ length: width }, () => []);
  for (const row of rows) {
    for (let c = 0; c < width; c++) {
      columns[c].push(toNumber(row[c]));
    }
  }
  return columns;
}

/** Read text out of a File/Blob (browser + jsdom). */
async function readFileText(file: Blob): Promise<string> {
  // Blob.text() exists in modern browsers and jsdom; fall back to FileReader.
  if (typeof file.text === "function") return file.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * Core synchronous parser shared by string + File entry points.
 */
function parseCsvText(text: string, options: ParseCsvOptions): Dataset {
  const idFactory = options.idFactory ?? defaultIdFactory;
  const name = options.name ?? DEFAULT_NAME;

  const result = Papa.parse<unknown[]>(text, {
    header: false,
    skipEmptyLines: "greedy",
    dynamicTyping: false, // we coerce ourselves for full control over NaN
  });

  const rows = (result.data as unknown[][]).filter(
    (r) => Array.isArray(r) && r.length > 0,
  );

  if (rows.length === 0) {
    return {
      channels: [],
      lanes: [],
      source: "csv",
      name,
    };
  }

  const hasHeader = detectHeader(rows);
  const header = hasHeader ? rows[0].map((c) => String(c ?? "").trim()) : null;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  // Width = widest row so ragged rows don't drop trailing columns.
  let width = 0;
  for (const r of dataRows) width = Math.max(width, r.length);
  if (header) width = Math.max(width, header.length);
  if (width === 0) {
    return { channels: [], lanes: [], source: "csv", name };
  }

  const columns = toColumns(dataRows, width);

  const hasTime =
    options.hasTimeColumn !== undefined
      ? options.hasTimeColumn && width >= 2
      : detectTimeColumn(header, columns);

  let time: number[] | undefined;
  let channelColumns: number[][];
  let channelHeaders: (string | undefined)[];

  if (hasTime) {
    time = columns[0];
    channelColumns = columns.slice(1);
    channelHeaders = header ? header.slice(1) : [];
  } else {
    channelColumns = columns;
    channelHeaders = header ? header.slice() : [];
  }

  const channels: Channel[] = channelColumns.map((values, i) => {
    const rawName = channelHeaders[i];
    const channelName =
      rawName && rawName.length > 0 ? rawName : `channel ${i + 1}`;
    return {
      id: idFactory(i, channelName),
      name: channelName,
      values,
      color: makeChannelColor(i),
      visible: true,
    };
  });

  return {
    channels,
    lanes: [],
    time,
    source: "csv",
    name,
  };
}

/**
 * Parse CSV from a string or a File/Blob into a {@link Dataset}.
 * - Detects an optional header row (column names).
 * - Detects an optional leading timestamp/index column -> Dataset.time.
 * - Remaining columns become channels (numeric; non-numeric -> NaN).
 * - Ragged rows are NaN-padded to the widest row.
 *
 * Returns a Promise so the same entry point handles both strings and Files.
 */
export async function parseCsv(
  input: string | Blob,
  options: ParseCsvOptions = {},
): Promise<Dataset> {
  let text: string;
  let name = options.name;
  if (typeof input === "string") {
    text = input;
  } else {
    text = await readFileText(input);
    // Prefer an explicit name; else use File.name when present.
    if (name === undefined && "name" in input) {
      const fileName = (input as File).name;
      if (fileName) name = fileName;
    }
  }
  return parseCsvText(text, { ...options, name });
}

/**
 * Synchronous string-only parser, convenient for tests and pure pipelines.
 */
export function parseCsvString(
  text: string,
  options: ParseCsvOptions = {},
): Dataset {
  return parseCsvText(text, options);
}

/** Options for {@link serializeCsv}. */
export interface SerializeCsvOptions {
  /**
   * Header label for the leading time column when `dataset.time` is present.
   * Defaults to "timestamp".
   */
  timeHeader?: string;
  /**
   * When true, only channels with `visible !== false` are written. Defaults to
   * false (export everything; visibility is a view concern).
   */
  visibleOnly?: boolean;
}

/** Render one numeric cell. NaN/Infinity/undefined -> empty cell. */
function cell(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return String(value);
}

/**
 * Serialize a {@link Dataset} back to CSV text.
 * - If `dataset.time` is present, a timestamp column is written first.
 * - One column per channel, in the dataset's current channel order.
 * - Row count = max length across time + channels (short columns -> empty).
 */
export function serializeCsv(
  dataset: Dataset,
  options: SerializeCsvOptions = {},
): string {
  const timeHeader = options.timeHeader ?? "timestamp";
  const channels = options.visibleOnly
    ? dataset.channels.filter((c) => c.visible !== false)
    : dataset.channels;

  const hasTime = Array.isArray(dataset.time);
  const headerRow: string[] = [];
  if (hasTime) headerRow.push(timeHeader);
  for (const ch of channels) headerRow.push(ch.name);

  // Determine row count from the longest column.
  let rowCount = 0;
  if (hasTime) rowCount = Math.max(rowCount, dataset.time!.length);
  for (const ch of channels) rowCount = Math.max(rowCount, ch.values.length);

  const data: string[][] = [headerRow];
  for (let r = 0; r < rowCount; r++) {
    const row: string[] = [];
    if (hasTime) row.push(cell(dataset.time![r]));
    for (const ch of channels) row.push(cell(ch.values[r]));
    data.push(row);
  }

  // Papa.unparse handles quoting/escaping deterministically.
  return Papa.unparse(data, { newline: "\n" });
}
