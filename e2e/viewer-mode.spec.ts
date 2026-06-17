// e2e/viewer-mode.spec.ts
//
// VIEWER MODE (mode=viewer): a read-only analysis surface. It HIDES the
// data-mutating / write-back controls (crop toggle, channel rename, Edge Impulse
// upload) while KEEPING all view + analysis affordances (lanes + presets, zoom,
// the formula engine, CSV export). /api/ei/* is mocked (no key, no network).
//
// We deep-link a sample so the editor opens straight onto a dataset, then assert
// the presence/absence of the relevant controls.

import { test, expect } from "@playwright/test";
import { mockEdgeImpulse } from "./helpers/ei-mock";

async function openViewer(page: import("@playwright/test").Page) {
  await mockEdgeImpulse(page, { connected: true, projectId: 12345 });
  await page.goto("/?apiKey=ei_demo&project=12345&sample=101&mode=viewer");
  // Wait for the sample to load into the editor.
  await expect(page.getByText("EI #101")).toBeVisible();
}

async function openEditor(page: import("@playwright/test").Page) {
  await mockEdgeImpulse(page, { connected: true, projectId: 12345 });
  await page.goto("/?apiKey=ei_demo&project=12345&sample=101");
  await expect(page.getByText("EI #101")).toBeVisible();
}

test.describe("viewer mode", () => {
  test("hides the Upload (write-back) control", async ({ page }) => {
    await openViewer(page);
    await expect(page.getByRole("button", { name: "Upload" })).toHaveCount(0);
  });

  test("hides the crop (data-mutating) toggle", async ({ page }) => {
    await openViewer(page);
    // The crop toggle (label "Crop") is absent in viewer mode.
    await expect(page.getByRole("button", { name: "Crop" })).toHaveCount(0);
  });

  test("shows the read-only indicator", async ({ page }) => {
    await openViewer(page);
    await expect(page.getByText("Read-only")).toBeVisible();
  });

  test("keeps CSV export available", async ({ page }) => {
    await openViewer(page);
    await expect(
      page.getByRole("button", { name: "Export CSV" }),
    ).toBeVisible();
  });

  test("keeps the lane presets (lanes + zoom) available", async ({ page }) => {
    await openViewer(page);
    // The lane toolbar segmented control stays in viewer mode.
    await expect(
      page.getByRole("button", { name: /Auto group/ }),
    ).toBeVisible();
  });

  test("keeps the formula engine reachable", async ({ page }) => {
    await openViewer(page);
    await expect(
      page.getByRole("button", { name: /Formula/ }),
    ).toBeVisible();
  });

  test("editor mode (default) DOES expose Upload + Crop for contrast", async ({
    page,
  }) => {
    await openEditor(page);
    await expect(page.getByRole("button", { name: "Upload" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Crop" })).toBeVisible();
    // No read-only badge in editor mode.
    await expect(page.getByText("Read-only")).toHaveCount(0);
  });
});
