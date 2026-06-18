# Multi-label (time-series structured labels)

Edge Impulse supports **multi-label** time-series samples: instead of a single
label per sample, a sample is split into contiguous, non-overlapping **segments**
over its sample-index space, each carrying its own label. The editor reads,
visualizes, edits, exports, and uploads these segments.

See the Edge Impulse docs:
[Multi-label](https://docs.edgeimpulse.com/studio/projects/data-acquisition/dataset/multi-label)
and the
[labels acquisition format](https://docs.edgeimpulse.com/reference/data-ingestion/labels-acquisition-format).

---

## The data model

A segment is an **inclusive** sample-index range with a label:

```ts
interface StructuredLabel {
  startIndex: number; // first sample of the segment
  endIndex: number;   // last sample (inclusive)
  label: string;
}
```

A dataset's `labels?: StructuredLabel[]` holds the ordered segments. Edge Impulse
requires the segments of a sample to be **continuous** and **non-overlapping**
over the **full length** of the sample before it can be uploaded as multi-label.

### The `structured_labels.labels` file

On upload, segments travel in a JSON sidecar that maps the data file name to its
segments:

```json
{
  "version": 1,
  "type": "structured-labels",
  "structuredLabels": {
    "my-sample.json": [
      { "startIndex": 0,   "endIndex": 300, "label": "first_label" },
      { "startIndex": 301, "endIndex": 621, "label": "second_label" }
    ]
  }
}
```

The key (`my-sample.json`) **must** match the name of the uploaded data file —
Edge Impulse keys the labels by file name.

---

## In the editor

A collapsible **Labels** panel sits above the lane board (next to **Formula**).
The labeled segments are drawn as translucent **colored bands** across every
lane, aligned to the shared x-axis, with the label name tagged at the top of
each band — so a segment lines up with the signal across all lanes at once.

From the panel you can:

- **Add a label** over an inclusive sample-index range. Adding a label *carves*
  it out of any overlapping segment, so the set always stays non-overlapping.
  Prefill the range from a brushed **crop selection** ("Use selection") — enable
  crop mode, drag across a lane, then label it.
- **Rename** a segment inline (renaming to match a neighbour merges them).
- **Delete** a segment.
- **Fill gaps** — fill every uncovered index with an `unlabeled` segment so the
  labels span the whole sample (the shape Edge Impulse requires).
- See live **validation** badges: *non-overlapping*, *continuous*, *full length*.
- **Export labels** — download the `structured_labels.labels` sidecar.

Crop re-indexes the segments so they stay aligned after the trim. Multi-label
segments are read automatically when a multi-label Edge Impulse sample is opened.

In **viewer** mode the segments are still rendered and exportable, but the
editing controls are hidden (read-only).

---

## Upload

When a dataset has structured labels, **Upload to Edge Impulse** routes through
the multipart `/{category}/files` ingestion endpoint instead of
`/{category}/data`: it posts the acquisition-format data file **and** a generated
`structured_labels.labels` sidecar (both as the `data` form field), all through
the same server-side proxy that keeps the API key out of the browser. The server
re-validates that the segments are continuous and non-overlapping over the full
sample length before forwarding, and rejects them with a 400 otherwise.

> Multi-label is not available on Edge Impulse Community projects.
