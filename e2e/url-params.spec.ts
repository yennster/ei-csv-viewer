// e2e/url-params.spec.ts
//
// URL-parameter behaviour, all with /api/ei/* mocked (no key, no network):
//   - theme=dark applies the `dark` class on <html>
//   - embed=1 strips the app header chrome
//   - apiKey=ei_...&project=... auto-connects, then STRIPS apiKey from the
//     address bar via history.replaceState (it must never linger in the URL)
//   - sample=<id> auto-opens that sample straight in the editor
//
// COOKIE NOTE: the real session is a Secure; SameSite=None; HttpOnly cookie.
// Plain-http CI cannot persist such a cookie, so here the connection is mocked
// at the app layer (page.route on /api/ei/session). The actual cookie
// attributes are asserted in the vitest route test
// src/app/api/ei/__tests__/session-route.test.ts.

import { test, expect } from "@playwright/test";
import { mockEdgeImpulse } from "./helpers/ei-mock";

test.describe("URL params", () => {
  test("theme=dark applies the dark class to <html>", async ({ page }) => {
    await mockEdgeImpulse(page);
    await page.goto("/?theme=dark");
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("theme=light does not apply the dark class", async ({ page }) => {
    await mockEdgeImpulse(page);
    await page.goto("/?theme=light");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test("standalone shows the app header; nothing strips chrome without embed", async ({
    page,
  }) => {
    await mockEdgeImpulse(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Edge Impulse CSV Editor" }),
    ).toBeVisible();
  });

  test("embed=1 strips the app header chrome", async ({ page }) => {
    await mockEdgeImpulse(page);
    await page.goto("/?embed=1");
    // The branded header is gone in embedded mode.
    await expect(
      page.getByRole("heading", { name: "Edge Impulse CSV Editor" }),
    ).toHaveCount(0);
  });

  test("apiKey + project auto-connects then strips apiKey from the address bar", async ({
    page,
  }) => {
    await mockEdgeImpulse(page);
    await page.goto("/?apiKey=ei_secret_demo&project=12345");

    // Connection badge confirms the auto-connect ran.
    await expect(page.getByText(/Connected/)).toBeVisible();

    // The apiKey must be gone from the visible URL (history.replaceState),
    // while the non-secret project param is preserved.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("apiKey"))
      .toBeNull();
    expect(new URL(page.url()).searchParams.get("project")).toBe("12345");
  });

  test("sample=<id> auto-opens that sample straight in the editor", async ({
    page,
  }) => {
    await mockEdgeImpulse(page);
    await page.goto("/?apiKey=ei_secret_demo&project=12345&sample=202");

    // The dataset toolbar shows the loaded EI sample badge for #202.
    await expect(page.getByText("EI #202")).toBeVisible();
  });
});
