/**
 * v0.7.0 — WS Smoke Test
 *
 * Tests bridge startup + WebSocket connection + JSON-RPC handshake.
 * This uses the same WS protocol as the MCP adapter, validating the
 * bridge's primary communication channel.
 *
 * Does NOT require Firefox or the extension — bridge-only test.
 * Extension-in-Firefox tests come in PR #58.
 */

import { test, expect } from "@playwright/test";
import { WsBridgeClient } from "./helpers/ws-bridge-client";

let client: WsBridgeClient;

test.beforeAll(async () => {
  client = new WsBridgeClient();
  await client.ready();
});

test.afterAll(async () => {
  client?.close();
});

test.describe("Bridge WS Smoke Test", () => {

  test("should respond to initialize handshake", async () => {
    const response = await client.send("initialize", {
      protocolVersion: "0.1.0",
      clientInfo: { name: "brp-integration-test", version: "0.7.0" },
    });
    expect(response.jsonrpc).toBe("2.0");
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.sessionId).toMatch(/^session-/);
    expect(result.protocolVersion).toBeDefined();
    expect(result.serverInfo).toBeDefined();
  }, 10000);

  test("should return empty browser list (no extension connected)", async () => {
    const response = await client.send("browser.list", {});
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(Array.isArray(result.browsers)).toBe(true);
    expect(result.browsers).toHaveLength(0);
    expect(result.count).toBe(0);
  }, 10000);

  test("should return error for tab.list (no extension)", async () => {
    const response = await client.send("tab.list", {});
    expect(response.error).toBeDefined();
    expect(response.jsonrpc).toBe("2.0");
  }, 10000);

  test("should reject invalid method with -32601", async () => {
    const response = await client.send("invalid.fake.method", {});
    expect(response.error).toBeDefined();
    const error = response.error as Record<string, unknown>;
    expect(error.code).toBe(-32601);
  }, 10000);

  test("should respond to shutdown", async () => {
    const response = await client.send("shutdown", {});
    expect(response.result).toBeDefined();
  }, 10000);
});
