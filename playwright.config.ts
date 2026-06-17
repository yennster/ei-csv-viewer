import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Edge Impulse CSV Editor E2E suite.
 *
 * DEDICATED PORT: the app is built and served on 3100 here — never 3001 (a dev
 * server on 3001 corrupted .next once by building while it was serving). The
 * webServer block below makes Playwright OWN the lifecycle: locally it runs
 * `rm -rf .next && next build && next start -p 3100`; in CI (E2E_SKIP_BUILD=1) it
 * only runs `next start -p 3100` against the .next built by the dedicated Build
 * step, then tears the server down. `reuseExistingServer` is allowed locally
 * (faster reruns) but disabled in CI so every run is hermetic.
 *
 * All /api/ei/* traffic is mocked at the network layer inside the specs
 * (page.route), so no Edge Impulse API key and no real network are ever needed.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;

// Set E2E_SKIP_BUILD=1 to serve an already-built .next without rebuilding. CI sets
// this so the e2e job reuses the artifact from the dedicated Build step instead of
// running a SECOND `next build` (which both wastes ~2x time and, more importantly,
// rebuilds over a pre-existing .next — the exact operation that reproduced a
// PageNotFoundError on a dirty tree). When we DO build here (local default), wipe
// .next first so a serve never races a half-written build directory.
const WEBSERVER_CMD =
  process.env.E2E_SKIP_BUILD === "1"
    ? `pnpm exec next start -p ${PORT}`
    : `rm -rf .next && pnpm exec next build && pnpm exec next start -p ${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Keep E2E artifacts out of the source tree.
  outputDir: "./e2e/.output",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // In CI also emit an HTML report into the default `playwright-report/` dir so
  // the "Upload Playwright report" step has something real to upload (previously
  // there was no html reporter, so the artifact was always empty). `open: never`
  // keeps the run non-interactive.
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // Build then serve a production build on the DEDICATED port. Playwright
    // starts and stops this; we never reuse the 3001 dev server.
    command: WEBSERVER_CMD,
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
