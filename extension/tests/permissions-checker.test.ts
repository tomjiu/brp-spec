/**
 * Tests for E1 Permission Gating — checker logic.
 */

import { describe, it, expect } from "vitest";
import { shouldGate, matchDomainPattern } from "../src/permissions/checker";
import { DEFAULT_CONFIG, type PermissionGateConfig } from "../src/permissions/config";

const defaultConfig = { ...DEFAULT_CONFIG, _autoApprovePermissions: false };

describe("matchDomainPattern", () => {
  it("should match exact domain", () => {
    expect(matchDomainPattern("bank.com", "https://bank.com/login")).toBe(true);
  });

  it("should match wildcard prefix", () => {
    expect(matchDomainPattern("*.bank.com", "https://login.bank.com")).toBe(true);
    expect(matchDomainPattern("*.bank.com", "https://www.bank.com")).toBe(true);
  });

  it("should not match unrelated domain with wildcard", () => {
    expect(matchDomainPattern("*.bank.com", "https://evil.com")).toBe(false);
    expect(matchDomainPattern("*.bank.com", "https://fake-bank.com")).toBe(false);
  });

  it("should be case insensitive", () => {
    expect(matchDomainPattern("*.Bank.Com", "https://login.BANK.COM")).toBe(true);
  });

  it("should handle invalid URL gracefully", () => {
    expect(matchDomainPattern("*.bank.com", "not-a-url")).toBe(false);
  });
});

describe("shouldGate", () => {
  it("should allow non-sensitive methods", () => {
    expect(shouldGate("tab.list", {}, defaultConfig)).toBe("allow");
    expect(shouldGate("element.fill", {}, defaultConfig)).toBe("allow");
    expect(shouldGate("page.getInteractionTree", {}, defaultConfig)).toBe("allow");
  });

  describe("script.execute", () => {
    it("should ask when gate is 'ask'", () => {
      const config: PermissionGateConfig = {
        ...defaultConfig,
        permissionGates: { ...defaultConfig.permissionGates, scriptExecute: "ask" },
      };
      expect(shouldGate("script.execute", {}, config)).toBe("ask");
    });

    it("should deny when gate is 'always'", () => {
      const config: PermissionGateConfig = {
        ...defaultConfig,
        permissionGates: { ...defaultConfig.permissionGates, scriptExecute: "always" },
      };
      expect(shouldGate("script.execute", {}, config)).toBe("deny");
    });

    it("should allow when gate is 'never'", () => {
      const config: PermissionGateConfig = {
        ...defaultConfig,
        permissionGates: { ...defaultConfig.permissionGates, scriptExecute: "never" },
      };
      expect(shouldGate("script.execute", {}, config)).toBe("allow");
    });
  });

  describe("page.navigate", () => {
    it("should allow non-sensitive domain", () => {
      expect(shouldGate("page.navigate", { url: "https://google.com" }, defaultConfig)).toBe("allow");
    });

    it("should ask for sensitive domain", () => {
      expect(shouldGate("page.navigate", { url: "https://login.bank.com" }, defaultConfig)).toBe("ask");
    });

    it("should deny when gate is 'always'", () => {
      const config: PermissionGateConfig = {
        ...defaultConfig,
        permissionGates: { ...defaultConfig.permissionGates, navigateSensitiveDomains: "always" },
      };
      expect(shouldGate("page.navigate", { url: "https://www.paypal.com" }, config)).toBe("deny");
    });
  });

  describe("element.click", () => {
    it("should allow normal button click", () => {
      expect(shouldGate("element.click", { selector: { type: "css", value: "#login-btn" } }, defaultConfig)).toBe("allow");
    });

    it("should ask for sensitive button click", () => {
      expect(shouldGate("element.click", {
        selector: { type: "css", value: "confirm payment" },
      }, defaultConfig)).toBe("ask");
    });

    it("should ask for Chinese sensitive pattern", () => {
      expect(shouldGate("element.click", {
        selector: { type: "text", value: "确认支付" },
      }, defaultConfig)).toBe("ask");
    });

    it("should deny when gate is 'always'", () => {
      const config: PermissionGateConfig = {
        ...defaultConfig,
        permissionGates: { ...defaultConfig.permissionGates, clickSensitiveButtons: "always" },
      };
      expect(shouldGate("element.click", {
        selector: { type: "css", value: "delete" },
      }, config)).toBe("deny");
    });

    it("should scan multi-selector values", () => {
      expect(shouldGate("element.click", {
        selectors: [
          { type: "css", value: "#btn" },
          { type: "text", value: "submit order" },
        ],
      }, defaultConfig)).toBe("ask");
    });
  });

  describe("_autoApprovePermissions", () => {
    it("should allow everything when flag is set", () => {
      const config = { ...defaultConfig, _autoApprovePermissions: true };
      expect(shouldGate("script.execute", {}, config)).toBe("allow");
      expect(shouldGate("page.navigate", { url: "https://www.bank.com" }, config)).toBe("allow");
      expect(shouldGate("element.click", { selector: { type: "text", value: "delete" } }, config)).toBe("allow");
    });
  });
});
