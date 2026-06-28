/**
 * Phase 1 Smoke Test — Bridge Startup + WS + Initialize
 *
 * Starts bridge in standalone mode, connects MCP client via WebSocket,
 * verifies bridge process, WS connection, and JSON-RPC initialize handshake.
 *
 * Note: Extension integration (headless Firefox + extension loading) deferred
 * to spike — headless Firefox native messaging compatibility TBD.
 */

import { test, expect } from "@playwright/test";
import { startBridge, stopBridge, type BridgeInfo } from "./helpers/bridge";
import { McpClient } from "./helpers/mcp-client";

let bridge: BridgeInfo;
let client: McpClient;

test.beforeAll(async () => {
  bridge = startBridge();
  // Give bridge time to bind port and start WS server
  await new Promise(r => setTimeout(r, 2000));
  client = new McpClient(bridge.port);
});

test.afterAll(async () => {
  client?.close();
  stopBridge(bridge);
});

test.describe("Bridge Smoke Test", () => {

  test("should start bridge process", () => {
    expect(bridge.process.pid).toBeGreaterThan(0);
    expect(bridge.port).toBe(9817);
  });

  test("should establish WebSocket connection", async () => {
    await client.connect();
  }, 10000);

  test("should respond to initialize handshake", async () => {
    await client.connect();
    const response = await client.initialize();
    expect(response.jsonrpc).toBe("2.0");
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.sessionId).toBeDefined();
    expect(result.protocolVersion).toBeDefined();
    expect(result.serverInfo).toBeDefined();
  }, 10000);

  test("should respond to browser.list", async () => {
    await client.connect();
    const response = await client.send("browser.list", {});
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(Array.isArray(result.browsers)).toBe(true);
  }, 10000);
});
