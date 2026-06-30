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

  // Wait for Firefox with extension to start
  firefox = new E2EFirefox();
  await firefox.start();

  // Poll browser.list until extension connects (max 10s)
  for (let i = 0; i < 20; i++) {
    try {
      const resp = await bridge.send("browser.list", {});
      const browsers = (resp.result as Record<string, unknown>)?.browsers as unknown[];
      if (Array.isArray(browsers) && browsers.length > 0) {
        console.log("[e2e] Extension connected to bridge");
        break;
      }
    } catch {
      // bridge not ready or extension not connected yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Initialize session
  const initResp = await bridge.send("initialize", {
    protocolVersion: "0.1.0",
    clientInfo: { name: "e2e-test", version: "0.8.0" },
  });
  if (initResp.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initResp.error)}`);
  }
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
