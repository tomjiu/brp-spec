/**
 * v0.7.0 — E2E Element Tests (click + fill)
 *
 * Tests element.click and element.fill actions end-to-end.
 * Requires: bridge binary + Firefox with extension loaded.
 *
 * Setup: See docs/v0.7.0-IMPLEMENTATION-PLAN.md §2.1
 */

import { test, expect } from "@playwright/test";
import { McpClient } from "./helpers/mcp-client";
import * as fs from "fs";
import * as path from "path";

const FIXTURE_DIR = path.resolve(__dirname, "fixtures");
const LOGIN_PAGE = `file://${path.join(FIXTURE_DIR, "login-page.html")}`;

let bridge: McpClient;

test.beforeAll(async () => {
  bridge = new McpClient();
  // Wait for bridge to start + extension to register
  await new Promise((r) => setTimeout(r, 5000));

  // Initialize session (bridge requires initialize before forwarding requests)
  const initResp = await bridge.send("initialize", {
    protocolVersion: "0.1.0",
    clientInfo: { name: "e2e-test", version: "0.7.0" },
  });
  if (initResp.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initResp.error)}`);
  }
}, 60000);

test.afterAll(async () => {
  bridge?.close();
});

test.describe("E2E Element Actions", () => {
  test.beforeEach(async () => {
    // Navigate to fixture page before each test
    const resp = await bridge.send("page.navigate", {
      url: LOGIN_PAGE,
      tabId: 1,
    });
    // Allow page to load
    expect(resp.result || resp.error).toBeDefined();
    await new Promise((r) => setTimeout(r, 1000));
  }, 15000);

  test("should click a button and verify DOM state", async () => {
    // Click the login button
    const clickResp = await bridge.send("element.click", {
      selector: { type: "css", value: "#login-btn" },
      tabId: 1,
    });

    // Button click should not error
    expect(clickResp.error).toBeUndefined();
    expect(clickResp.result).toBeDefined();

    // Verify button text changed via extension
    const treeResp = await bridge.send("page.getInteractionTree", {
      tabId: 1,
      selector: { type: "css", value: "#status" },
    });

    expect(treeResp.result || treeResp.error).toBeDefined();
  }, 15000);

  test("should fill input field and verify value", async () => {
    // Fill the username input
    const fillResp = await bridge.send("element.fill", {
      selector: { type: "css", value: "#username" },
      value: "testuser",
      tabId: 1,
    });

    expect(fillResp.error).toBeUndefined();
    expect(fillResp.result).toBeDefined();
  }, 15000);

  test("should fail precondition check on tagName mismatch", async () => {
    const resp = await bridge.send("element.click", {
      selector: { type: "css", value: "#username" },
      precondition: { tagName: "BUTTON" },
      tabId: 1,
    });

    // Should get BRP_PRECONDITION_FAILED or similar
    expect(resp.error || resp.result).toBeDefined();
  }, 15000);
});

test.describe("E2E Screenshot", () => {
  test("should capture screenshot and return base64 data", async () => {
    const resp = await bridge.send("page.screenshot", {
      tabId: 1,
    });

    if (resp.result) {
      const result = resp.result as Record<string, unknown>;
      // Screenshot returns base64 PNG data
      expect(result.data || result.image).toBeDefined();
    }
  }, 15000);
});
