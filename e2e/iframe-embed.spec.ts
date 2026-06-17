// e2e/iframe-embed.spec.ts
//
// IFRAME EMBEDDING: a same-origin host page embeds /embed?embed=1 in an <iframe>
// and we assert the framed app actually loads — i.e. the CSP frame-ancestors
// directive allows 'self' and no X-Frame-Options blocks the frame. We also
// confirm the editor renders inside the frame and the header chrome is stripped
// under embed=1.
//
// The host HTML is served from the SAME origin (a page.route-fulfilled path on
// localhost:3100), which is what frame-ancestors 'self' permits. /api/ei/* is
// mocked so the framed app connects with no key and no real network.
//
// COOKIE NOTE: the embedded session relies on a Secure; SameSite=None; HttpOnly
// cookie in real deployments. Plain-http CI cannot persist that cookie, so the
// connection is mocked here and the cookie attributes are asserted in the vitest
// route test (src/app/api/ei/__tests__/session-route.test.ts).

import { test, expect } from "@playwright/test";
import { mockEdgeImpulse } from "./helpers/ei-mock";

const HOST_PATH = "/__e2e_host__";

const HOST_HTML = `<!doctype html>
<html>
  <head><title>E2E host</title></head>
  <body>
    <h1 id="host-heading">Host page</h1>
    <iframe
      id="editor-frame"
      title="embedded editor"
      src="/embed?embed=1"
      style="width: 1000px; height: 700px; border: 0;"
    ></iframe>
  </body>
</html>`;

test.describe("iframe embedding", () => {
  test("the embedded /embed page loads inside a same-origin iframe (not frame-blocked)", async ({
    page,
  }) => {
    await mockEdgeImpulse(page, { connected: true, projectId: 12345 });

    // Serve a same-origin host page that frames /embed?embed=1.
    await page.route(`**${HOST_PATH}`, async (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: HOST_HTML }),
    );

    await page.goto(HOST_PATH);
    await expect(page.locator("#host-heading")).toBeVisible();

    // The frame must have a reachable document — if CSP/XFO had blocked it the
    // frame would have no usable content frame.
    const frameEl = page.locator("#editor-frame");
    const frame = await frameEl.elementHandle().then((h) => h!.contentFrame());
    expect(frame).not.toBeNull();

    // The editor renders inside the frame (lane toolbar is present once a sample
    // could be picked); at minimum the embedded app body mounted.
    await expect(frame!.locator("body")).toBeVisible();
  });

  test("the embedded app strips the header chrome", async ({ page }) => {
    await mockEdgeImpulse(page, { connected: true, projectId: 12345 });

    await page.route(`**${HOST_PATH}`, async (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: HOST_HTML }),
    );

    await page.goto(HOST_PATH);
    const frame = page.frameLocator("#editor-frame");

    // The branded header (standalone-only) must be absent inside the embed.
    await expect(
      frame.getByRole("heading", { name: "Edge Impulse CSV Editor" }),
    ).toHaveCount(0);
  });

  test("the /embed response advertises frame-ancestors 'self' and no X-Frame-Options", async ({
    request,
  }) => {
    // Direct request-level assertion on the security headers that make the
    // iframe load possible.
    const res = await request.get("/embed?embed=1");
    expect(res.status()).toBe(200);
    const headers = res.headers();
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("'self'");
    // X-Frame-Options: DENY would block framing entirely — it must NOT be set.
    expect(headers["x-frame-options"]).toBeUndefined();
  });
});
