import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30000,
  retries: 1,
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
