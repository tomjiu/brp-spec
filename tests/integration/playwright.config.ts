import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 60000,
  retries: 1,
  // time to wait for beforeAll/afterAll hooks
  globalTimeout: 120000,
  use: {
    browserName: "firefox",
    headless: true,
  },
  projects: [
    {
      name: "firefox",
      use: { browserName: "firefox" },
    },
  ],
});
