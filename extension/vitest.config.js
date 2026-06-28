import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests live in tests/ directory
    include: ["tests/**/*.test.ts"],

    // DOM tests (precondition.test.ts) use jsdom directly via import.
    // Handler tests remain pure logic, no DOM env needed.
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
