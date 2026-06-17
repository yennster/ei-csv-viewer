# URL parameters

The Edge Impulse CSV Editor is configured entirely through URL query parameters.
This is what makes it embeddable: Edge Impulse Studio (or any host page) deep-links
to the app with the right parameters and the editor boots into the correct state.

All parameters are **parsed exactly once at load** and parsing **never throws**:

- Invalid values are silently **dropped** (the app falls back to its default).
- Enum values (`category`, `theme`) are **case-insensitive**.
- Boolean values (`embed`) accept `1` / `true` / `yes` / `on` (true) and
  `0` / `false` / `no` / `off` (false). Anything else is ignored.
- Integers are validated and **clamped** to their documented range.
- The `apiKey` is only accepted when it matches `/^ei_/`.

When the app runs **inside an iframe**, query parameters are also inherited from
the parent frame (read from the parent's `location.search` when same-origin, or
from `document.referrer` otherwise). The app's own query parameters take
precedence over inherited ones.

---

## Parameters

| Parameter | Aliases | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `apiKey` | — | string `ei_…` | — | Edge Impulse API key. Validated, moved into the httpOnly `ei_session` cookie, then **stripped from the URL**. Only accepted when it starts with `ei_`. See the security note below. |
| `category` | — | enum | — | Which dataset bucket to list / load from: `training`, `testing`, or `anomaly`. Case-insensitive. |
| `labels` | — | comma list | — | Filter the sample list to these labels, e.g. `labels=idle,walk,run`. Whitespace is trimmed and empty entries are dropped. |
| `sample` | `sampleId` | integer ≥ 1 | — | Id of the sample to auto-open in the editor on load. |
| `limit` | — | integer 1–1000 | `200` | Page size for the sample list. Clamped to the `1..1000` range. |
| `offset` | — | integer ≥ 0 | `0` | Page offset for the sample list. Negative values are clamped to `0`. |
| `theme` | — | enum | _(system)_ | Force the UI theme: `dark` or `light`. Case-insensitive. |
| `embed` | — | boolean | `false` | When true, strips the app chrome (header + toolbar) for iframe embedding while keeping the lane editor fully functional. |
| `mode` | — | enum | `editor` | `editor` (default) or `viewer`. In `viewer` mode the app is **read-only**: data-mutating / write-back controls are hidden (crop apply/trim, channel rename, sample label rename, and Upload to Edge Impulse). All view + analysis stays available — the samples sidebar, lanes + drag-to-regroup, zoom/pan, the **formula engine** (derive + filter are non-destructive), and CSV export. A small **Read-only** badge is shown. Composes with `embed=1`. Case-insensitive; invalid values fall back to `editor`. |
| `studioHost` | — | URL | `https://studio.edgeimpulse.com/v1/api` | Override the Edge Impulse Studio API base URL (must start with `http://` or `https://`). |
| `ingestionHost` | — | URL | `https://ingestion.edgeimpulse.com/api` | Override the Edge Impulse Ingestion API base URL (must start with `http://` or `https://`). |

> Host overrides can also be set globally on the server via the `EI_STUDIO_HOST`
> and `EI_INGESTION_HOST` environment variables. A per-session URL override takes
> precedence over the environment default.

---

## Examples

Open a specific training sample in a project:

```
https://your-app.example.com/?category=training&sample=98765
```

Connect with an API key (the key is moved into the session cookie and removed
from the address bar after load):

```
https://your-app.example.com/?apiKey=ei_xxxxxxxxxxxxxxxxxxxx&sample=98765
```

List only specific labels, with a larger page size:

```
https://your-app.example.com/?category=testing&labels=idle,walk,run&limit=500
```

Embed in an iframe with chrome stripped and a forced dark theme:

```
https://your-app.example.com/?sample=98765&embed=1&theme=dark
```

Open a sample **read-only** for analysis (no crop / rename / upload), embedded:

```
https://your-app.example.com/?sample=98765&mode=viewer&embed=1
```

Point at a self-hosted / enterprise Edge Impulse instance:

```
https://your-app.example.com/?studioHost=https://studio.acme-ei.com/v1/api&ingestionHost=https://ingestion.acme-ei.com/api
```

---

## Security note — the API key never stays in the URL

When the app loads with an `apiKey` parameter:

1. The key is **POSTed to `/api/ei/session`**, where the server validates it by
   fetching project info from Edge Impulse Studio.
2. On success it is stored **only** in an **httpOnly**, `secure`,
   `sameSite: "none"`, `path: "/"` cookie named **`ei_session`**. Because the
   cookie is httpOnly it is **never readable from client JavaScript**, and it is
   never written to `localStorage`.
3. The `apiKey` parameter is then **removed from the address bar**
   (`history.replaceState`) before the editor renders, so the key does not
   linger in browser history, bookmarks, or referrer headers.

Every subsequent Edge Impulse request goes through the same-origin proxy routes
under `src/app/api/ei/*`, which read the cookie server-side and attach the
`x-api-key` header. The browser never sees the key again.

Avoid putting a real `apiKey` in a URL you intend to share or paste somewhere
persistent. Prefer connecting through the in-app connect form, or rely on the
short-lived deep links generated by the Edge Impulse extension flow.
