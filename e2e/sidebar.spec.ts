// e2e/sidebar.spec.ts
//
// Straight-to-editor flow + the collapsible Samples sidebar, with /api/ei/*
// mocked (no key, no network). Covers:
//   - connect (mocked) lands directly in the editor with the Samples sidebar
//     listing the mocked samples
//   - clicking a sample loads it into the editor
//   - the collapse button hides the sidebar to a thin rail; expanding restores it
//
// COOKIE NOTE: the session cookie's Secure; SameSite=None; HttpOnly attributes
// are verified in the vitest route test, not here (plain-http CI cannot persist
// such a cookie). See src/app/api/ei/__tests__/session-route.test.ts.

import { test, expect } from "@playwright/test";
import { mockEdgeImpulse, MOCK_SAMPLES } from "./helpers/ei-mock";

test.describe("Samples sidebar (straight to editor)", () => {
  test("connecting lands in the editor with the sidebar listing samples", async ({
    page,
  }) => {
    await mockEdgeImpulse(page);
    await page.goto("/");

    // Connect via the form (the POST is mocked).
    await page.getByPlaceholder("ei_...").fill("ei_demo_key");
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    // The sidebar appears with its heading and the mocked sample rows.
    const sidebar = page.getByRole("complementary");
    await expect(sidebar.getByText("Samples", { exact: true })).toBeVisible();
    for (const s of MOCK_SAMPLES) {
      await expect(sidebar.getByText(s.filename)).toBeVisible();
    }
  });

  test("clicking a sample loads it into the editor", async ({ page }) => {
    await mockEdgeImpulse(page, { connected: true, projectId: 12345 });
    await page.goto("/");

    const sidebar = page.getByRole("complementary");
    await sidebar.getByText("walk-01.csv").click();

    // The dataset toolbar shows the loaded sample badge.
    await expect(page.getByText("EI #101")).toBeVisible();
  });

  test("collapse hides the sidebar to a rail; expand restores it", async ({
    page,
  }) => {
    await mockEdgeImpulse(page, { connected: true, projectId: 12345 });
    await page.goto("/");

    const sidebar = page.getByRole("complementary");
    await expect(sidebar.getByText("Samples", { exact: true })).toBeVisible();

    // Collapse to the rail.
    await page
      .getByRole("button", { name: "Collapse samples sidebar" })
      .click();
    await expect(sidebar).toHaveCount(0);

    // The rail offers a "show samples" affordance that restores the sidebar.
    await page.getByRole("button", { name: "Show samples sidebar" }).click();
    await expect(
      page.getByRole("complementary").getByText("Samples", { exact: true }),
    ).toBeVisible();
  });
});
