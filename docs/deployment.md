# Deployment

The Edge Impulse CSV Editor is a standard Next.js (App Router) app. The
recommended host is **Vercel**, but any platform that can run a Next.js server
build over HTTPS will work. HTTPS is **required** because the session cookie is
`secure` + `sameSite: "none"` so it can be embedded inside the Studio iframe.

---

## Deploying to Vercel

### 1. Import the project

Push the repository to GitHub / GitLab / Bitbucket and import it in the Vercel
dashboard, or use the CLI:

```bash
pnpm install -g vercel
vercel            # first run: link the project
vercel --prod     # deploy to production
```

Vercel auto-detects Next.js. The relevant build settings:

| Setting | Value |
| --- | --- |
| Framework preset | Next.js |
| Install command | `pnpm install` |
| Build command | `pnpm build` (`next build`) |
| Output | _(managed by the Next.js adapter)_ |
| Node.js version | 22.x |

The package manager is pnpm (pnpm 11); Vercel reads `pnpm-lock.yaml`
automatically.

### 2. Environment variables

No secrets are required — the Edge Impulse API key is supplied at runtime by the
user and stored only in the `ei_session` cookie. The only environment variables
are the **optional** Edge Impulse host overrides (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `EI_STUDIO_HOST` | `https://studio.edgeimpulse.com/v1/api` | Default Studio API base. |
| `EI_INGESTION_HOST` | `https://ingestion.edgeimpulse.com/api` | Default Ingestion API base. |

Set these in **Project → Settings → Environment Variables** only if you target a
self-hosted / enterprise Edge Impulse instance and want it to be the default for
all sessions. Per-session overrides (`studioHost` / `ingestionHost` URL params)
take precedence over these.

```bash
# optional, only for enterprise / self-hosted Edge Impulse
vercel env add EI_STUDIO_HOST production
vercel env add EI_INGESTION_HOST production
```

### 3. Custom subdomain

Add a domain under **Project → Settings → Domains**, e.g.
`csv-editor.your-org.com`, and point a CNAME at Vercel as instructed. Vercel
provisions a TLS certificate automatically, so the deployment is served over
HTTPS — which the `secure` session cookie requires.

Use this domain as the iframe `src` and as the base of the
[deep-link URL](./edge-impulse-extension.md).

---

## Embedding requirements (iframe / CSP / cookies)

To embed the app inside Edge Impulse Studio, the deployment must satisfy all of
the following. The repo is already configured for the Edge Impulse origins.

### HTTPS

The app **must** be served over HTTPS. The `ei_session` cookie is `secure`, so
browsers will not send it over plain HTTP, and an embedded `sameSite: "none"`
cookie is invalid without `secure`.

### Framing (CSP `frame-ancestors`)

`next.config.ts` sends a `Content-Security-Policy` header on every route that
allows the app to be framed:

```
Content-Security-Policy: frame-ancestors 'self' https://studio.edgeimpulse.com https://*.edgeimpulse.com;
```

This is the modern replacement for `X-Frame-Options`. The app intentionally does
**not** send `X-Frame-Options: DENY`, which would block all framing.

To embed in a **different** host (e.g. a self-hosted Studio at a custom origin),
add that origin to the `frame-ancestors` list in `next.config.ts` and redeploy:

```ts
const FRAME_ANCESTORS = [
  "'self'",
  "https://studio.edgeimpulse.com",
  "https://*.edgeimpulse.com",
  "https://studio.your-ei-instance.com", // <- add your host
].join(" ");
```

### Cross-site cookie (`sameSite: "none"`)

The `ei_session` cookie is set by `/api/ei/session` with:

```
httpOnly: true
secure:   true
sameSite: "none"
path:     "/"
```

`sameSite: "none"` is required so the browser sends the cookie on the
same-origin proxy requests (`/api/ei/*`) made by the app **while it is running
as a cross-site iframe inside Studio**. With the default `sameSite: "lax"`, the
cookie would be withheld in the third-party iframe context and every Edge Impulse
call would fail with "not connected".

Because the cookie is `httpOnly`, it is never exposed to client JavaScript, so
the API key it carries cannot be read from the page.

### Browser third-party cookie settings

Some browsers block third-party cookies by default, which can prevent the
`sameSite: "none"` session cookie from being stored in the Studio iframe. If
connecting works standalone but fails when embedded, check that third-party
cookies are permitted for the app's domain in the user's browser.

---

## Verifying a deployment

After deploying, sanity-check the build and the embedding headers:

```bash
# Build locally the same way the platform does
pnpm install
pnpm build
pnpm start            # serves the production build on :3000

# Confirm the framing + caching headers are present
curl -sI https://your-app.example.com/ | grep -i content-security-policy
```

You should see the `frame-ancestors` directive listing the Edge Impulse origins.
Then load a deep link with `embed=1` inside an iframe on an allowed origin and
confirm the lane editor renders with the app chrome hidden and the session cookie
set (DevTools → Application → Cookies → `ei_session`, marked `HttpOnly`,
`Secure`, `SameSite=None`).
