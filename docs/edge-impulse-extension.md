# Registering as an Edge Impulse extension

The Edge Impulse CSV Editor is designed to run as an **Edge Impulse Studio
extension / integration**: Studio embeds the app in an iframe and deep-links to
it with URL parameters so it opens directly on the right project and sample.

This page covers the deep-link URL shape, how the iframe embedding works, and
what the extension actually does.

---

## What the extension does

When opened from inside Edge Impulse Studio for a given sample, the extension:

1. Receives the project id, category, and sample id (and, on first connect, an
   API key) via URL parameters — see [URL parameters](./url-parameters.md).
2. Validates the API key server-side and stores it in the httpOnly `ei_session`
   cookie, then strips the key from the address bar.
3. Loads the sample's time-series through the same-origin proxy
   (`GET /api/ei/sample/{id}` → Edge Impulse `GET /{projectId}/raw-data/{id}`).
   Channel `i` is `payload.values.map(row => row[i])`, named from
   `payload.sensors[i].name`. (The plural `GET /api/ei/samples` is the list
   endpoint only.)
4. Renders the channels as **independent, per-lane charts** so signals with
   different magnitudes are each readable — the core value over Studio's single
   shared y-axis.
5. Lets the user re-group channels into lanes (drag-and-drop), rename channels,
   toggle visibility, and **crop** a time range.
6. Writes the result back to Edge Impulse: either an in-place server-side crop,
   or a brand-new sample uploaded through the **ingestion** proxy.

When embedded, pass `embed=1` so the app's own header and toolbar are hidden and
the lane editor fills the iframe. Pass `mode=viewer` to embed a **read-only**
analysis view — lanes, drag-to-regroup, zoom/pan, the **formula engine** (derive
+ filter, non-destructive), and CSV export remain, while the data-mutating /
write-back controls (crop apply/trim, channel & sample rename, Upload to Edge
Impulse) are hidden. The default `mode=editor` keeps every action available.

---

## Deep-link URL shape

The host (Studio or your own launcher) links to the deployed app with query
parameters. The general shape is:

```
https://<your-deployment>/?apiKey=<ei_…>&project=<id>&category=<training|testing|anomaly>&sample=<id>&embed=1
```

| Part | Purpose |
| --- | --- |
| `apiKey=ei_…` | Edge Impulse API key. Validated and moved into the `ei_session` cookie, then stripped from the URL. Optional once a session cookie already exists. |
| `project=<id>` | Project id to open (alias `eiProject`). |
| `category=…` | Dataset bucket the sample lives in. |
| `sample=<id>` | Sample to auto-open in the editor (alias `sampleId`). |
| `embed=1` | Hide app chrome for iframe embedding. |
| `mode=viewer\|editor` | Optional — `editor` (default) exposes every action; `viewer` is **read-only** (hides crop apply/trim, channel rename, sample label rename, and Upload to Edge Impulse) while keeping all view + analysis, including the formula engine and CSV export. |
| `theme=dark\|light` | Optional — force the theme to match Studio. |
| `studioHost` / `ingestionHost` | Optional — point at a self-hosted / enterprise Edge Impulse instance. |

Example deep link opening training sample `98765` of project `12345`, embedded
and themed to match Studio:

```
https://your-app.example.com/?apiKey=ei_xxxxxxxxxxxxxxxxxxxx&project=12345&category=training&sample=98765&embed=1&theme=dark
```

Once the session cookie is set, subsequent links can omit `apiKey`:

```
https://your-app.example.com/?project=12345&category=training&sample=98765&embed=1
```

---

## Embedding via iframe

Embed the deployed app in Studio (or any host page) with a standard iframe:

```html
<iframe
  src="https://your-app.example.com/?project=12345&category=training&sample=98765&embed=1&theme=dark"
  title="Edge Impulse CSV Editor"
  style="width: 100%; height: 100%; border: 0;"
  allow="clipboard-write"
></iframe>
```

For this to work, three things must line up:

1. **Framing must be allowed.** The app sends a
   `Content-Security-Policy: frame-ancestors` header (configured in
   `next.config.ts`) that permits framing by `'self'` and the specific origin
   `https://studio.edgeimpulse.com`. It does **not** send `X-Frame-Options:
   DENY`, and it does **not** use a `*.edgeimpulse.com` wildcard (which would let
   any subdomain frame the app). To embed in a different known host, add that
   exact origin to `frame-ancestors`.

2. **The session cookie must survive the iframe.** The `ei_session` cookie is
   set with `sameSite: "none"` and `secure: true`, so it is sent on
   same-origin proxy requests even when the app is a cross-site iframe. This
   requires the app to be served over **HTTPS**.

3. **Inherited parameters.** When framed, the app also merges query parameters
   inherited from the parent frame (parent `location.search` when same-origin,
   else `document.referrer`). The app's own URL parameters take precedence.
   **The `apiKey` is never inherited** from the parent/referrer — it is only
   accepted on the app's own URL (so it can be moved into the cookie and then
   stripped from the address bar). Embedders should pass `apiKey` only to the
   app's own iframe `src`, or POST it to `/api/ei/session` directly; never place
   it in the parent page's URL, where it would persist in a URL the embedder
   controls.

See [Deployment](./deployment.md) for the full CSP / cookie / HTTPS requirements.

---

## Connecting without a deep link

The extension also works standalone. With `embed` unset, the app shows its
connect/import panel where a user can:

- Paste an API key and project id to connect (same validation path as the
  `apiKey` URL parameter), then browse and load samples by category / label.
- Import a local CSV file instead of connecting to Edge Impulse.

This is useful for development and for editing data that is not yet in an Edge
Impulse project.
