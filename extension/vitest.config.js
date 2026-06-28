import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests live in tests/ directory
    include: ["tests/**/*.test.ts", "tests/**/*.test.js"],

    // No DOM environment needed — handlers.js is pure logic
    // (no happy-dom needed since we don't test DOM operations)
    environment: "node",

    // Globals off — use explicit imports
    globals: false,

    // Fail fast on first error during development
    bail: 0,

    // Coverage (optional, can enable later)
    coverage: {
      include: ["background/handlers.js"],
    },
  },
});
