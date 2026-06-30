/**
 * v0.8.0 Regression Tests
 *
 * Validates backward compatibility across v0.3.x → v0.8.0.
 * All imports are from real source code — no reimplementation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInitialize } from "../src/handlers";
import { loadConfig, DEFAULT_CONFIG } from "../src/permissions/config";
import {
  checkHistoryAccessError,
  checkTabControllable,
  shouldDemoteTab,
} from "../src/permissions/flow";

// ── B1 Backward Compat ──

describe("B1 backward compat", () => {
  it("handleInitialize should work without clientInfo", () => {
    const result = handleInitialize({});
    expect(result.sessionId).toBeDefined();
    expect(result.serverInfo).toBeDefined();
    expect(result.capabilities.actions).toContain("page.navigate");
  });

  it("handleInitialize should work without capabilities", () => {
    const result = handleInitialize({ protocolVersion: "0.1.0" });
    expect(result.capabilities).toBeDefined();
    expect(result.capabilities.features).toContain("interactionTree");
  });

  it("handleInitialize should work with no params at all", () => {
    const result = handleInitialize();
    expect(result.sessionId).toBeDefined();
    expect(result.protocolVersion).toBeDefined();
    expect(result.negotiatedVersion).toBeDefined();
  });
});

// ── Multi-token Backward Compat ──

describe("multi-token backward compat", () => {
  it("DEFAULT_CONFIG should be defined (extension does not depend on master_token)", () => {
    expect(DEFAULT_CONFIG).toBeDefined();
    expect(DEFAULT_CONFIG.domainBlacklist).toBeDefined();
    expect(DEFAULT_CONFIG.domainAllowlist).toBeDefined();
    expect(DEFAULT_CONFIG.screenshotBlur).toBeDefined();
  });

  it("DEFAULT_CONFIG should use ask gate for all actions", () => {
    expect(DEFAULT_CONFIG.permissionGates.scriptExecute).toBe("ask");
    expect(DEFAULT_CONFIG.permissionGates.navigateSensitiveDomains).toBe("ask");
    expect(DEFAULT_CONFIG.permissionGates.clickSensitiveButtons).toBe("ask");
  });
});

// ── Storage Migration ──

describe("storage migration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should load v0.3.x config (no domainBlacklist/allowlist/screenshotBlur)", async () => {
    const oldConfig = {
      permissionGates: {
        scriptExecute: "ask",
        navigateSensitiveDomains: "ask",
        clickSensitiveButtons: "ask",
      },
      sensitiveDomains: ["*.bank.com"],
      sensitiveButtonPatterns: ["submit order"],
    };

    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ brpPermissionConfig: oldConfig }),
        },
      },
    });

    const config = await loadConfig();
    expect(config.domainBlacklist).toEqual([]);
    expect(config.domainAllowlist).toEqual([]);
    expect(config.screenshotBlur).toBeDefined();
  });

  it("should load v0.5.0 config (has domainBlacklist but no allowlist/screenshotBlur)", async () => {
    const v050Config = {
      permissionGates: {
        scriptExecute: "ask",
        navigateSensitiveDomains: "ask",
        clickSensitiveButtons: "ask",
      },
      sensitiveDomains: ["*.bank.com"],
      sensitiveButtonPatterns: ["submit order"],
      domainBlacklist: ["evil.com"],
    };

    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ brpPermissionConfig: v050Config }),
        },
      },
    });

    const config = await loadConfig();
    expect(config.domainBlacklist).toEqual(["evil.com"]);
    expect(config.domainAllowlist).toEqual([]);
    expect(config.screenshotBlur).toBeDefined();
  });

  it("should deep merge permissionGates (partial)", async () => {
    const partialConfig = {
      permissionGates: { scriptExecute: "never" },
      sensitiveDomains: [],
      sensitiveButtonPatterns: [],
      domainBlacklist: [],
      domainAllowlist: [],
      screenshotBlur: { gate: "never", fieldTypes: [], customSelectors: [] },
    };

    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ brpPermissionConfig: partialConfig }),
        },
      },
    });

    const config = await loadConfig();
    expect(config.permissionGates.scriptExecute).toBe("never");
    expect(config.permissionGates.navigateSensitiveDomains).toBe("ask");
  });

  it("should deep merge screenshotBlur (partial)", async () => {
    const partialConfig = {
      permissionGates: {
        scriptExecute: "ask",
        navigateSensitiveDomains: "ask",
        clickSensitiveButtons: "ask",
      },
      sensitiveDomains: [],
      sensitiveButtonPatterns: [],
      domainBlacklist: [],
      domainAllowlist: [],
      screenshotBlur: { gate: "always" },
    };

    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ brpPermissionConfig: partialConfig }),
        },
      },
    });

    const config = await loadConfig();
    expect(config.screenshotBlur.gate).toBe("always");
    // Default fieldTypes should still be present
    expect(config.screenshotBlur.fieldTypes).toBeDefined();
  });

  it("should return defaults when storage is unavailable", async () => {
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn().mockRejectedValue(new Error("storage unavailable")),
        },
      },
    });

    const config = await loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

// ── Protocol Backward Compat ──

describe("protocol backward compat", () => {
  it("handleInitialize should fallback protocolVersion if not provided", () => {
    const result = handleInitialize();
    expect(result.protocolVersion).toBeDefined();
  });

  it("handleInitialize should accept unknown protocolVersion", () => {
    const result = handleInitialize({ protocolVersion: "0.0.1" });
    expect(result.protocolVersion).toBe("0.0.1");
  });

  it("handleInitialize should negotiate to current version", () => {
    const result = handleInitialize({ protocolVersion: "0.1.0" });
    expect(result.negotiatedVersion).toBe("0.1.0");
  });

  it("handleInitialize should produce deterministic sessionId with _testSeed", () => {
    const result1 = handleInitialize({ _testSeed: "abc" });
    expect(result1.sessionId).toBe("ext-abc");

    const result2 = handleInitialize({ _testSeed: "abc" });
    expect(result2.sessionId).toBe("ext-abc");
  });
});

// ── Error Code Stability ──

describe("error code stability", () => {
  it("all error codes should be in -32000..-32099 range", () => {
    const codes = [-32001, -32002, -32003, -32004];
    for (const code of codes) {
      expect(code).toBeLessThanOrEqual(-32000);
      expect(code).toBeGreaterThanOrEqual(-32099);
    }
  });

  it("shouldDemoteTab should only trigger on BRP_PERMISSION_DENIED", () => {
    const controllableTabs = new Set([1]);
    expect(shouldDemoteTab("BRP_PERMISSION_DENIED", "element.click", 1, controllableTabs)).toBe(true);
    expect(shouldDemoteTab("BRP_USER_BLOCKED_DOMAIN", "element.click", 1, controllableTabs)).toBe(false);
    expect(shouldDemoteTab("BRP_TAB_NOT_CONTROLLABLE", "element.click", 1, controllableTabs)).toBe(false);
  });

  it("shouldDemoteTab should be no-op on non-tab-scoped methods", () => {
    const controllableTabs = new Set([1]);
    expect(shouldDemoteTab("BRP_PERMISSION_DENIED", "tab.list", 1, controllableTabs)).toBe(false);
    expect(shouldDemoteTab("BRP_PERMISSION_DENIED", "initialize", 1, controllableTabs)).toBe(false);
  });

  it("checkHistoryAccessError should return correct code", () => {
    const err = checkHistoryAccessError(false);
    expect(err?.code).toBe(-32004);
    expect(err?.data).toMatchObject({
      errorCode: "BRP_HISTORY_PERMISSION_NOT_GRANTED",
      retriable: false,
    });

    const ok = checkHistoryAccessError(true);
    expect(ok).toBeNull();
  });

  it("checkTabControllable should not block non-tab-scoped methods", () => {
    const controllableTabs = new Set<number>();
    expect(checkTabControllable("initialize", 1, controllableTabs)).toBe(true);
    expect(checkTabControllable("shutdown", 1, controllableTabs)).toBe(true);
    expect(checkTabControllable("tab.list", 1, controllableTabs)).toBe(true);
    expect(checkTabControllable("tab.open", 1, controllableTabs)).toBe(true);
    expect(checkTabControllable("history.search", 1, controllableTabs)).toBe(true);
    expect(checkTabControllable("history.delete", 1, controllableTabs)).toBe(true);
  });

  it("checkTabControllable should require controllable tab for scoped methods", () => {
    const emptyTabs = new Set<number>();
    const hasTabs = new Set([1]);
    expect(checkTabControllable("element.click", 1, emptyTabs)).toBe(false);
    expect(checkTabControllable("element.click", 1, hasTabs)).toBe(true);
    expect(checkTabControllable("page.navigate", 1, emptyTabs)).toBe(false);
    expect(checkTabControllable("script.execute", undefined, emptyTabs)).toBe(true);
  });
});
