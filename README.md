# Edge Impulse CSV Editor

A web app for editing sensor CSV / Edge Impulse time-series data. It runs both
**standalone** and **embedded inside Edge Impulse Studio** as an extension
(iframe).

The package name is `ei-csv-editor`.

---

## The problem it solves

In Edge Impulse Studio, every sensor axis of a sample is plotted on **one
shared chart with a single y-axis**. Whichever signal has the largest magnitude
dominates the scale, so channels with a different range become impossible to
read.

A concrete example: a sample contains a pressure channel in the range
`0..1000` and an accelerometer channel in the range `0.0..1.0`. On a single
shared axis, the `0..1000` channel uses the entire vertical space and the
`0.0..1.0` channel is flattened into a near-invisible line near zero. You can
see that something is there, but you cannot read its shape.

This is the **magnitude-domination problem**, and it is the whole reason this
app exists.

## The fix: lanes

The Edge Impulse CSV Editor splits the view into stacked **lanes**. Each lane is
an independent time-series chart with its **own auto-scaled y-axis**, but
**every lane shares the same x-axis** (time or sample index) and a
**synchronized cursor / crosshair**.

Because each lane scales its y-axis to only the channels it contains, the
`0..1000` pressure channel and the `0.0..1.0` accelerometer channel each get a
readable, full-height plot in their own lane.

### Drag channels between lanes (the centerpiece)

Channels are not pinned to a lane. You **drag a channel chip from one lane to
another**, or drop it onto the **"+ New lane"** strip to spin up a fresh lane
for it. This is how you separate signals with different magnitudes so each one
gets its own y-scale. There is also a non-drag **"Move to…"** menu on every chip
for touch and keyboard use.

Additional editor operations:

- **Import a local CSV** — the first column may be a timestamp / index (it
  becomes the shared x-axis); the remaining columns become channels.
- **Load a sample from Edge Impulse** by id, directly through the proxy.
- **Auto-group channels into lanes** by order-of-magnitude of each channel's
  value range, with one-click presets: *Auto group*, *One lane per channel*,
  *All in one lane*.
- **Per-lane y-axis control** — independent auto-scaling, or a manual min/max
  with a "Fit" prefill and a symmetric-around-zero toggle.
- **Rename channels**, toggle their visibility, rename / add / remove / reorder
  lanes.
- **Crop** a time range with a brush selection (trims the full-resolution data
  for CSV, or calls the Edge Impulse crop endpoint for an Edge Impulse sample).
- **Multi-label** a time series — split a sample into contiguous, non-overlapping
  labeled segments (Edge Impulse's structured-labels format), drawn as colored
  bands across every lane. Add / rename / delete segments, fill gaps, validate
  the continuous + non-overlapping contract, and export the
  `structured_labels.labels` sidecar. See [`docs/multi-label.md`](./docs/multi-label.md).
- **Export** the edited dataset back to CSV.
- **Upload** the edited dataset back to Edge Impulse as a new sample via the
  ingestion proxy. Multi-label samples upload through the multipart `/files`
  endpoint with a generated `structured_labels.labels` sidecar.

Very large series are **downsampled only for rendering** (extremes preserved);
the full-resolution data is always kept for crop, export, and upload.

---

## Formula engine (derive + filter)

A collapsible **Formula** panel above the lane board runs a small
**Python-syntax, numpy-like** expression engine for non-destructive analysis:

- **Derive** an expression into a **new channel** (frozen full-resolution, in its
  own lane; participates in lanes / drag / export like any channel). Example —
  accelerometer magnitude: `sqrt(accX**2 + accY**2 + accZ**2)`; unit convert:
  `accX / 1000`; z-score: `normalize(gyroZ)`.
- **Filter** with a boolean expression into a length-N **mask** that highlights
  matching samples (non-matching ranges are shaded across every lane). **Rows are
  never deleted.** Example anomaly filter:
  `sqrt(accX**2 + accY**2 + accZ**2) > 2.0`. When matches form a contiguous range
  you can **Crop to matches** (editor mode only).

It references channels by name (or `col("Name")`), plus `index` / `t`, and ships
elementwise / reducer / windowed functions. The evaluator is pure and
whitelist-only — **no `eval` / `Function` / global access** — and never throws.
See [`docs/formula.md`](./docs/formula.md) for the full reference and examples.

## Viewer vs. editor mode

The app runs in two modes, selected with the `mode` URL parameter (default
`editor`):

- **`editor`** (default) — every action is available, including the
  data-mutating / write-back ones: crop apply/trim, channel rename, sample label
  rename, and **Upload to Edge Impulse**.
- **`viewer`** — a **read-only** analysis surface. The write-back controls above
  are hidden and a small **Read-only** badge is shown, while everything for
  *looking at* the data stays: the samples sidebar, lanes + drag-to-regroup,
  zoom/pan, the **formula engine** (derive + filter are non-destructive), and
  **CSV export**. Composes with `embed=1`.

See [URL parameters](./docs/url-parameters.md) for the parameter details.

---

## Screenshots

> _Screenshots coming soon._

| Standalone editor | Drag a channel into its own lane | Embedded in Studio |
| --- | --- | --- |
| _`docs/images/standalone.png` (placeholder)_ | _`docs/images/drag-lane.png` (placeholder)_ | _`docs/images/embedded.png` (placeholder)_ |

---

## Local development

This project uses **pnpm** (pnpm 11) on **Node 22**.

```bash
pnpm install      # install dependencies
pnpm dev          # start the dev server (http://localhost:3000)
pnpm build        # production build
pnpm start        # serve the production build
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run (unit tests)
```

Optional Edge Impulse host overrides can be set via environment variables —
see [`.env.example`](./.env.example). No secrets are ever committed; the API key
is supplied at runtime.

---

## How it works

### Stack

- **Next.js** (App Router, TypeScript) — `"use client"` only where needed.
- **Tailwind CSS v4** (`@tailwindcss/postcss`).
- **uPlot** for charts (fast, handles large series; one instance per lane).
- **@dnd-kit** (`core` / `sortable` / `modifiers` / `utilities`) for
  drag-and-drop between lanes.
- **zustand** for editor state (the single source of truth for the dataset,
  shared x-window, cursor, theme, and async status).
- **papaparse** for CSV parsing.
- **lucide-react** for icons, **clsx** + **tailwind-merge** for class helpers.
- **vitest** + **jsdom** for unit tests.

### Lane architecture

Each lane is **one uPlot instance**, not one chart with stacked scales. All lane
charts share a single x scale driven from the store's `xWindow`, and a single
`uPlot` cursor-sync key drives the crosshair. The cursor sync is configured to
sync **only x** (`scales: ['x', null]`) so each lane keeps its own independent,
auto-scaled y-axis — this is what preserves the per-lane scaling that fixes the
magnitude-domination problem.

Channels own the full data; lanes are pure view groupings that reference
channel ids. Dragging a channel just moves an id between lanes — it never moves
or copies the underlying series, and renaming a channel never breaks its lane
membership.

### Edge Impulse integration (server-side proxy + httpOnly cookie)

Edge Impulse blocks browser CORS, and the API key must never reach client JS, so
**all** Edge Impulse calls go through same-origin Next.js Route Handlers under
`src/app/api/ei/*`. These act as a server-side proxy:

1. On connect, the client `POST`s the API key (and optional project id / host
   overrides) to `/api/ei/session`. The route validates the key by fetching
   project info from Studio.
2. On success the validated session (`{ apiKey, projectId, studioHost?,
   ingestionHost? }`) is stored as JSON in an **httpOnly, `secure`,
   `sameSite: "none"`, `path: "/"`** cookie named **`ei_session`**.
   `sameSite: "none"` is required so the cookie is sent when the app runs inside
   the Studio iframe.
3. Every subsequent proxy route reads that cookie server-side, injects the
   `x-api-key` header, calls Studio (`https://studio.edgeimpulse.com/v1/api`) or
   Ingestion (`https://ingestion.edgeimpulse.com/api`), and checks the
   `{ success, error }` envelope on every Studio response.

The API key is **never** placed in `localStorage` or any client JS. When the app
loads with an `apiKey` URL parameter, that key is moved into the cookie and then
**stripped from the address bar** so it is not left in browser history or
referrer headers.

**Large samples.** Loading a big sample used to hit the platform's default
10-second serverless function timeout. The sample-load proxy now **streams the
upstream JSON straight through** instead of parsing the multi-megabyte body into
JS objects and re-serializing it (the upstream shape already matches the client
contract), and the data-heavy routes raise `maxDuration` to 60s — so a large
sample loads well within the window.

The Studio and Ingestion base URLs can be overridden per session
(`studioHost` / `ingestionHost`) or globally via `EI_STUDIO_HOST` /
`EI_INGESTION_HOST`.

---

## Documentation

- [Multi-label](./docs/multi-label.md) — time-series structured labels: data
  model, the `structured_labels.labels` file, editing, and upload.
- [URL parameters](./docs/url-parameters.md) — every supported query parameter.
- [Edge Impulse extension](./docs/edge-impulse-extension.md) — registering the
  app as a Studio extension and the deep-link URL shape.
- [Deployment](./docs/deployment.md) — deploying to Vercel and the iframe / CSP /
  cookie requirements for embedding.
