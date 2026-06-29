/**
 * Tests for E2 Domain Blacklist.
 */

import { describe, it, expect } from "vitest";
import { isBlacklisted, extractDomain, matchDomainPattern } from "../src/permissions/checker";
import { DEFAULT_CONFIG } from "../src/permissions/config";

describe("extractDomain", () => {
  it("should extract domain from https URL", () => {
    expect(extractDomain("https://example.com/path")).toBe("example.com");
  });
  it("should extract domain from http URL", () => {
    expect(extractDomain("http://sub.example.com")).toBe("sub.example.com");
  });
  it("should return null for non-http(s) scheme", () => {
    expect(extractDomain("about:blank")).toBeNull();
    expect(extractDomain("chrome://settings")).toBeNull();
    expect(extractDomain("file:///etc/passwd")).toBeNull();
  });
  it("should return null for invalid URL", () => {
    expect(extractDomain("not-a-url")).toBeNull();
    expect(extractDomain("")).toBeNull();
  });

  it("should extract domain without port", () => {
    expect(extractDomain("https://example.com:8080/path")).toBe("example.com");
    expect(extractDomain("http://sub.example.com:443")).toBe("sub.example.com");
  });
});

describe("isBlacklisted", () => {
  const blacklist = ["*.bank.com", "evil.com", "*.phishing.net"];

  it("should block exact match", () => {
    expect(isBlacklisted("https://evil.com/page", blacklist)).toBe(true);
  });
  it("should block wildcard match (subdomain)", () => {
    expect(isBlacklisted("https://login.bank.com", blacklist)).toBe(true);
    expect(isBlacklisted("https://www.bank.com", blacklist)).toBe(true);
  });
  it("should not block unrelated domain", () => {
    expect(isBlacklisted("https://google.com", blacklist)).toBe(false);
    expect(isBlacklisted("https://fake-bank.com", blacklist)).toBe(false);
  });
  it("should be case insensitive", () => {
    expect(isBlacklisted("https://EVIL.COM", blacklist)).toBe(true);
    expect(isBlacklisted("https://Login.BANK.COM", blacklist)).toBe(true);
  });
  it("should return false for empty blacklist", () => {
    expect(isBlacklisted("https://anything.com", [])).toBe(false);
  });
  it("should return false for empty URL", () => {
    expect(isBlacklisted("", blacklist)).toBe(false);
  });
  it("should handle invalid URL gracefully", () => {
    expect(isBlacklisted("not-a-url", blacklist)).toBe(false);
  });

  it("should handle URL with port", () => {
    const bl = ["evil.com"];
    expect(isBlacklisted("https://evil.com:8080/path", bl)).toBe(true);
  });

  it("should not block subdomain of exact-match (no wildcard)", () => {
    const bl = ["evil.com"];
    expect(isBlacklisted("https://notevil.com", bl)).toBe(false);
    expect(isBlacklisted("https://sub.evil.com", bl)).toBe(false);
  });
});

describe("matchDomainPattern (E1 reuse)", () => {
  it("should be functional for E2 domain patterns", () => {
    expect(matchDomainPattern("*.bank.com", "https://login.bank.com")).toBe(true);
    expect(matchDomainPattern("evil.com", "https://evil.com")).toBe(true);
    expect(matchDomainPattern("*.bank.com", "https://google.com")).toBe(false);
  });
});

describe("DEFAULT_CONFIG", () => {
  it("should have empty domainBlacklist by default", () => {
    expect(DEFAULT_CONFIG.domainBlacklist).toEqual([]);
  });
});
