/**
 * Tests for E1 Permission Gating — flow logic.
 *
 * Tests checkPermission orchestrator, formatPermissionPrompt, and
 * tab selection priority. Uses minimal mocking for browser.storage.
 */

import { describe, it, expect, vi } from "vitest";
import { formatPermissionPrompt, checkPermission } from "../src/permissions/flow";
import { DEFAULT_CONFIG } from "../src/permissions/config";

// Mock browser.storage.local for getPermConfig
const storageMock: Record<string, unknown> = {
  brpPermissionConfig: {
    ...DEFAULT_CONFIG,
    permissionGates: { ...DEFAULT_CONFIG.permissionGates },
  },
};

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
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
});

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
});
