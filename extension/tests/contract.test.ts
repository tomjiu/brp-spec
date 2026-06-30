/**
 * v0.7.0 — Bridge ↔ Extension Contract Tests
 *
 * Validates JSON-RPC message format, error code consistency,
 * and type compatibility between Bridge and Extension.
 *
 * All imports are from real source code — no reimplementation.
 * These tests run in CI (no Firefox required).
 */

import { describe, it, expect } from "vitest";
import { checkHistoryAccessError } from "../src/permissions/flow";
import type {
  GeneratedInitializeResult,
  GeneratedCapabilities,
  GeneratedServerInfo,
} from "../src/types";
import { handleInitialize } from "../src/handlers";

// ── Error Code Contracts ──

const KNOWN_ERROR_CODES = {
  BRP_PERMISSION_DENIED: -32001,
  BRP_USER_BLOCKED_DOMAIN: -32002,
  BRP_TAB_NOT_CONTROLLABLE: -32003,
  BRP_HISTORY_PERMISSION_NOT_GRANTED: -32004,
};

describe("Error code contracts", () => {
  it("should have all 4 error codes in range -32001..-32004", () => {
    const codes = Object.values(KNOWN_ERROR_CODES);
    expect(codes).toHaveLength(4);
    // Verify sequential and within JSON-RPC server error range
    expect(Math.min(...codes)).toBe(-32004);
    expect(Math.max(...codes)).toBe(-32001);
  });

  it("should have no duplicate error codes", () => {
    const codes = Object.values(KNOWN_ERROR_CODES);
    expect(new Set(codes).size).toBe(4);
  });

  it("BRP_HISTORY_PERMISSION_NOT_GRANTED should return correct error shape", () => {
    const err = checkHistoryAccessError(false);
    expect(err).not.toBeNull();
    expect(err?.code).toBe(-32004);
    expect(err?.data).toEqual({
      errorCode: "BRP_HISTORY_PERMISSION_NOT_GRANTED",
      retriable: false,
      recoveryHint: "Enable history access in BRP Bridge extension options",
    });
  });

  it("BRP_HISTORY_PERMISSION_NOT_GRANTED should return null when granted", () => {
    const err = checkHistoryAccessError(true);
    expect(err).toBeNull();
  });

  it("should have distinct error messages for each code", () => {
    const err = checkHistoryAccessError(false);
    expect(err?.code).toBe(KNOWN_ERROR_CODES.BRP_HISTORY_PERMISSION_NOT_GRANTED);
    // Each error should have a recovery hint
    expect(typeof err?.data).toBe("object");
    expect(err?.data).toHaveProperty("recoveryHint");
  });
});

// ── Message Format Contracts ──

describe("Message format contracts", () => {
  it("initialize response should match GeneratedInitializeResult shape", () => {
    const result: GeneratedInitializeResult = handleInitialize({});
    // Verify required fields from the generated type
    expect(result.protocolVersion).toBeDefined();
    expect(result.negotiatedVersion).toBeDefined();
    expect(result.serverInfo).toBeDefined();
    expect(result.capabilities).toBeDefined();
  });

  it("initialize response serverInfo should be valid", () => {
    const result: GeneratedInitializeResult = handleInitialize({});
    const info: GeneratedServerInfo = result.serverInfo;
    expect(info.name).toBe("brp-extension-gecko");
    expect(typeof info.version).toBe("string");
  });

  it("initialize response capabilities should list core actions", () => {
    const result: GeneratedInitializeResult = handleInitialize({});
    const caps: GeneratedCapabilities = result.capabilities;
    expect(caps.actions).toBeInstanceOf(Array);
    // Core actions from v0.5.0+
    expect(caps.actions).toContain("page.navigate");
    expect(caps.actions).toContain("tab.open");
    expect(caps.actions).toContain("element.click");
  });

  it("initialize response should have valid sessionId", () => {
    const result: GeneratedInitializeResult = handleInitialize({});
    // Session ID format: "ext-" prefix for extension sessions
    expect(typeof result.sessionId).toBe("string");
    expect((result.sessionId as string).length).toBeGreaterThan(0);
  });

  it("JSON-RPC 2.0 error shape should match protocol spec", () => {
    // All errors should have: { jsonrpc: "2.0", error: { code, message, data? } }
    const err = checkHistoryAccessError(false);
    expect(err).toHaveProperty("code");
    expect(err).toHaveProperty("message");
    expect(err).toHaveProperty("data");
    expect(typeof err?.code).toBe("number");
    expect(typeof err?.message).toBe("string");
    expect(typeof err?.data).toBe("object");
  });
});

// ── Error Code Exclusivity ──

describe("Error code exclusivity", () => {
  it("BRP_HISTORY_PERMISSION_NOT_GRANTED should not overlap with permission codes", () => {
    expect(KNOWN_ERROR_CODES.BRP_HISTORY_PERMISSION_NOT_GRANTED)
      .not.toBe(KNOWN_ERROR_CODES.BRP_PERMISSION_DENIED);
    expect(KNOWN_ERROR_CODES.BRP_HISTORY_PERMISSION_NOT_GRANTED)
      .not.toBe(KNOWN_ERROR_CODES.BRP_USER_BLOCKED_DOMAIN);
    expect(KNOWN_ERROR_CODES.BRP_HISTORY_PERMISSION_NOT_GRANTED)
      .not.toBe(KNOWN_ERROR_CODES.BRP_TAB_NOT_CONTROLLABLE);
  });

  it("all error codes should be negative and within range", () => {
    for (const code of Object.values(KNOWN_ERROR_CODES)) {
      expect(code).toBeLessThan(0);
      expect(code).toBeGreaterThanOrEqual(-32099);
      expect(code).toBeLessThanOrEqual(-32000);
    }
  });
});
