/**
 * Tests for E1 Permission Gating — flow logic.
 *
 * Tests checkPermission orchestrator, formatPermissionPrompt,
 * and tab selection. Uses minimal mocking for browser.storage/tabs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatPermissionPrompt, checkPermission, checkAllowlist, checkBlacklist, resolvePermission, registerControllableTabs } from "../src/permissions/flow";
import { DEFAULT_CONFIG } from "../src/permissions/config";

// Mutable storage for mocking
const storageMock: Record<string, unknown> = {
  brpPermissionConfig: DEFAULT_CONFIG,
};

let sendMessageMock = vi.fn().mockResolvedValue(undefined);

function setupBrowserMock(overrides: { sendMessageRejects?: boolean } = {}) {
  sendMessageMock = overrides.sendMessageRejects
    ? vi.fn().mockRejectedValue(new Error("No tab"))
    : vi.fn().mockResolvedValue(undefined);

  vi.stubGlobal("browser", {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          if (key === "brpPermissionConfig") {
            return { brpPermissionConfig: storageMock.brpPermissionConfig };
          }
          return {};
        }),
        set: vi.fn(),
      },
      onChanged: { addListener: vi.fn() },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, active: true }]),
      sendMessage: sendMessageMock,
    },
  });
}

describe("formatPermissionPrompt", () => {
  it("should format script.execute prompt", () => {
    const result = formatPermissionPrompt("script.execute", { code: "alert(1)" });
    expect(result.title).toContain("script");
    expect(result.details).toBe("alert(1)");
  });

  it("should truncate long script code", () => {
    const longCode = "x".repeat(300);
    const result = formatPermissionPrompt("script.execute", { code: longCode });
    expect(result.details?.length).toBe(200);
  });

  it("should format page.navigate prompt with URL", () => {
    const result = formatPermissionPrompt("page.navigate", { url: "https://bank.com" });
    expect(result.title).toContain("sensitive domain");
    expect(result.details).toBe("https://bank.com");
  });

  it("should format element.click prompt with selector value", () => {
    const result = formatPermissionPrompt("element.click", {
      selector: { type: "css", value: "confirm payment" },
    });
    expect(result.title).toContain("sensitive button");
    expect(result.details).toBe("confirm payment");
  });

  it("should return generic prompt for unknown method", () => {
    const result = formatPermissionPrompt("unknown.method", {});
    expect(result.title).toContain("AI requested");
  });
});

describe("checkPermission", () => {
  beforeEach(() => {
    setupBrowserMock();
    registerControllableTabs(new Set([1]));
  });

  it("should return null for allow decision (non-gated method)", async () => {
    storageMock.brpPermissionConfig = DEFAULT_CONFIG;
    const result = await checkPermission(1, "tab.list", {});
    expect(result).toBeNull();
  });

  it("should return error for deny decision (gate=always)", async () => {
    storageMock.brpPermissionConfig = {
      ...DEFAULT_CONFIG,
      permissionGates: {
        ...DEFAULT_CONFIG.permissionGates,
        scriptExecute: "always",
      },
    };
    const result = await checkPermission(2, "script.execute", {});
    expect(result).not.toBeNull();
    if (result) {
      expect(result.code).toBe(-32001);
      expect(result.data).toHaveProperty("errorCode", "BRP_PERMISSION_DENIED");
    }
  });

  it("should deny on dialog injection failure (fail-closed)", async () => {
    setupBrowserMock({ sendMessageRejects: true });
    registerControllableTabs(new Set([1]));
    storageMock.brpPermissionConfig = DEFAULT_CONFIG;

    const result = await checkPermission(5, "script.execute", { code: "test" });
    // fail-closed: dialog injection fails → deny
    expect(result).not.toBeNull();
    if (result) {
      expect(result.code).toBe(-32001);
    }
  });
});

describe("checkPermission ask path", () => {
  beforeEach(() => {
    setupBrowserMock();
    registerControllableTabs(new Set([1]));
    storageMock.brpPermissionConfig = DEFAULT_CONFIG;
  });

  it("should resolve null when user clicks Allow", async () => {
    const promise = checkPermission(10, "script.execute", { code: "test" });

    // Wait for sendDialogToActiveTab to call tabs.sendMessage
    await new Promise(r => setTimeout(r, 50));

    // Extract requestId from sendMessage call
    const sendCalls = sendMessageMock.mock.calls;
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    const requestId = sendCalls[0][1].requestId;

    resolvePermission(requestId, "allow");

    const result = await promise;
    expect(result).toBeNull(); // Allow → passes through
  });

  it("should return BRP_PERMISSION_DENIED when user clicks Deny", async () => {
    const promise = checkPermission(11, "script.execute", { code: "test" });

    await new Promise(r => setTimeout(r, 50));

    const sendCalls = sendMessageMock.mock.calls;
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    const requestId = sendCalls[0][1].requestId;

    resolvePermission(requestId, "deny");

    const result = await promise;
    expect(result).not.toBeNull();
    if (result) {
      expect(result.code).toBe(-32001);
      expect(result.data).toHaveProperty("errorCode", "BRP_PERMISSION_DENIED");
    }
  });

  it("should deny on 60s timeout", async () => {
    vi.useFakeTimers();

    const promise = checkPermission(12, "script.execute", { code: "test" });

    // Advance past the 60s dialog timeout
    await vi.advanceTimersByTimeAsync(60001);

    const result = await promise;
    expect(result).not.toBeNull();
    if (result) {
      expect(result.code).toBe(-32001);
    }
    vi.useRealTimers();
  });
});

describe("checkBlacklist", () => {
  beforeEach(() => {
    setupBrowserMock();
    registerControllableTabs(new Set([1]));
  });

  it("should block page.navigate to blacklisted domain", async () => {
    storageMock.brpPermissionConfig = {
      ...DEFAULT_CONFIG,
      domainBlacklist: ["*.bank.com"],
    };
    const result = await checkBlacklist("page.navigate", { url: "https://login.bank.com" });
    expect(result).not.toBeNull();
    if (result) {
      expect(result.code).toBe(-32002);
      expect(result.data).toHaveProperty("errorCode", "BRP_USER_BLOCKED_DOMAIN");
    }
  });

  it("should allow page.navigate to non-blacklisted domain", async () => {
    storageMock.brpPermissionConfig = {
      ...DEFAULT_CONFIG,
      domainBlacklist: ["*.bank.com"],
    };
    const result = await checkBlacklist("page.navigate", { url: "https://google.com" });
    expect(result).toBeNull();
  });

  it("should not check non-navigate methods", async () => {
    storageMock.brpPermissionConfig = {
      ...DEFAULT_CONFIG,
      domainBlacklist: ["*.bank.com"],
    };
    expect(await checkBlacklist("element.click", { selector: { value: "..." } })).toBeNull();
    expect(await checkBlacklist("script.execute", { code: "..." })).toBeNull();
    expect(await checkBlacklist("tab.list", {})).toBeNull();
  });

  it("should allow when blacklist is empty", async () => {
    storageMock.brpPermissionConfig = DEFAULT_CONFIG;
    const result = await checkBlacklist("page.navigate", { url: "https://anything.com" });
    expect(result).toBeNull();
  });

  it("should handle uri param (not just url)", async () => {
    storageMock.brpPermissionConfig = {
      ...DEFAULT_CONFIG,
      domainBlacklist: ["evil.com"],
    };
    const result = await checkBlacklist("page.navigate", { uri: "https://evil.com" });
    expect(result).not.toBeNull();
    if (result) {
      expect(result.code).toBe(-32002);
    }
  });
});

describe("E1/E2 interaction order", () => {
  beforeEach(() => {
    setupBrowserMock();
    registerControllableTabs(new Set([1]));
  });

  it("E2 should block before E1 asks (blacklist + sensitive domain)", async () => {
    storageMock.brpPermissionConfig = {
      ...DEFAULT_CONFIG,
      domainBlacklist: ["*.bank.com"],
      sensitiveDomains: ["*.bank.com"],
    };
    const result = await checkBlacklist("page.navigate", { url: "https://login.bank.com" });
    expect(result).not.toBeNull();
    expect(result?.code).toBe(-32002);
  });
});

describe("Allowlist/Blacklist interaction", () => {
  beforeEach(() => {
    setupBrowserMock();
    registerControllableTabs(new Set([1]));
    storageMock.brpPermissionConfig = {
      ...DEFAULT_CONFIG,
      domainAllowlist: ["*.trusted.com"],
      domainBlacklist: ["*.bank.com"],
    };
  });

  it("checkAllowlist returns true for matched page.navigate", async () => {
    const result = await checkAllowlist("page.navigate", {
      url: "https://sub.trusted.com/page",
    });
    expect(result).toBe(true);
  });

  it("checkAllowlist returns false for blacklisted but not allowlisted", async () => {
    const result = await checkAllowlist("page.navigate", {
      url: "https://login.bank.com",
    });
    expect(result).toBe(false);
  });

  it("checkAllowlist returns false for non-navigate methods", async () => {
    const result = await checkAllowlist("element.click", {
      selector: { type: "css", value: "#btn" },
    });
    expect(result).toBe(false);
  });
});

