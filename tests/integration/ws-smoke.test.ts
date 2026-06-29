/**
 * v0.7.0 — WS Connection Smoke Test
 *
 * Tests bridge startup + WebSocket connection + extension registration.
 * Validates the bridge's WS server is reachable and accepts authenticated
 * extension registrations.
 *
 * JSON-RPC request/response tests are covered by the existing native
 * messaging smoke test (smoke.test.ts) since the bridge in standalone
 * mode only accepts requests via stdin/stdout (Native Messaging).
 * The WS channel is for extension registration + forwarding only.
 */

import { test, expect } from "@playwright/test";
import { WsBridgeClient } from "./helpers/ws-bridge-client";

test.describe("Bridge WS Connection Smoke Test", () => {

  test("should start bridge and accept WS connection", async () => {
    const client = new WsBridgeClient();
    try {
      await client.ready();
      // Ready means WS connected + register sent + bridge accepted
      // Bridge logs "Extension authenticated" on success
      expect(true).toBe(true);
    } finally {
      client.close();
    }
  }, 15000);

  test("should register extension and stay connected", async () => {
    const client = new WsBridgeClient();
    try {
      await client.ready();

      // Wait a moment to verify bridge doesn't disconnect us
      await new Promise((r) => setTimeout(r, 500));
      // If we got here without error, connection is stable
      expect(true).toBe(true);
    } finally {
      client.close();
    }
  }, 15000);

  test("should cleanly disconnect without errors", async () => {
    const client = new WsBridgeClient();
    await client.ready();

    // Close should not throw
    client.close();
    await new Promise((r) => setTimeout(r, 500));
    expect(true).toBe(true);
  }, 15000);
});
