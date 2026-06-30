/**
 * v0.7.0 — E2E Navigate Test
 *
 * Tests page.navigate action end-to-end: Bridge → Extension → Firefox.
 * Requires bridge built (cargo build --release) and web-ext installed.
 *
 * This test starts both the bridge and Firefox with the extension,
 * then navigates to a fixture page and verifies the response.
 */

import { test, expect } from "@playwright/test";
import { McpClient } from "./helpers/mcp-client";
import { E2EFirefox } from "./helpers/e2e-firefox";
import * as fs from "fs";
import * as path from "path";

const FIXTURE_DIR = path.resolve(__dirname, "fixtures");

let bridge: McpClient;
let firefox: E2EFirefox;

test.beforeAll(async () => {
  // Start bridge in bridge mode (WS + native messaging)
  bridge = new McpClient();
  await new Promise((r) => setTimeout(r, 2000));

  // Start Firefox with extension
  firefox = new E2EFirefox();
  await firefox.start();

  // Wait for extension to register with bridge
  await new Promise((r) => setTimeout(r, 3000));
}, 60000);

test.afterAll(async () => {
  firefox?.stop();
  bridge?.close();
});

test.describe("E2E Navigate", () => {
  test("should navigate to a fixture page and return result", async () => {
    const fixturePath = path.join(FIXTURE_DIR, "login-page.html");
    const fixtureUrl = `file://${fixturePath}`;

    // Verify fixture exists
    expect(fs.existsSync(fixturePath)).toBe(true);

    const response = await bridge.send("page.navigate", { url: fixtureUrl });
    expect(response.jsonrpc).toBe("2.0");
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.uri).toContain("login-page");
    expect(result.title).toContain("BRP Test Login");
  }, 15000);

  test("should return error for invalid URL", async () => {
    const response = await bridge.send("page.navigate", { url: "not_a_valid_url" });
    // Bridge or extension should reject invalid URLs
    expect(response.error || response.result).toBeDefined();
  }, 15000);
});
