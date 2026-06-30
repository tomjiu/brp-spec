/**
 * v0.7.0 — Playwright config for E2E extension tests.
 *
 * These tests require Firefox with the BRP extension loaded.
 * Run them separately from the bridge-only smoke tests:
 *
 *   npx playwright test --config=playwright.e2e.config.ts
 *
 * Requires:
 *   1. Bridge binary built: cd bridge && cargo build --release
 *   2. Firefox with extension: npx web-ext run --source-dir ../../extension
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "e2e-*.spec.ts",
  timeout: 60000,
  retries: 0,
  globalTimeout: 180000,
  use: {
    browserName: "firefox",
    // Note: headless Firefox may not load extensions properly.
    // For CI, use xvfb-run with real Firefox.
    headless: false,
  },
});
