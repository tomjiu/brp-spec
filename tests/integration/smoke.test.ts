/**
 * Phase 1 Smoke Test — Bridge Native Messaging + JSON-RPC
 *
 * Spawns bridge and communicates via stdin/stdout Native Messaging format,
 * the same protocol used by the MCP adapter.
 */

import { test, expect } from "@playwright/test";
import { McpClient } from "./helpers/mcp-client";

let client: McpClient;

test.beforeAll(async () => {
  client = new McpClient();
  // Give bridge a moment to start
  await new Promise((r) => setTimeout(r, 2000));
});

test.afterAll(async () => {
  client?.close();
});

test.describe("Bridge Smoke Test (Native Messaging)", () => {

  test("should respond to initialize handshake", async () => {
    const response = await client.send("initialize", {
      protocolVersion: "0.1.0",
      clientInfo: { name: "brp-integration-test", version: "0.4.2" },
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
    // Bridge forwards tab.list to extension; no extension → error
    expect(response.error).toBeDefined();
    expect(response.jsonrpc).toBe("2.0");
  }, 10000);

  test("should reject invalid method", async () => {
    const response = await client.send("invalid.fake.method", {});
    expect(response.error).toBeDefined();
    const error = response.error as Record<string, unknown>;
    expect(error.code).toBe(-32601);
  }, 10000);
});
