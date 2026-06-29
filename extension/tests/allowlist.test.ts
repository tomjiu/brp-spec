/**
 * Tests for v0.5.1 Domain Allowlist.
 */
import { describe, it, expect } from "vitest";
import { isAllowlisted } from "../src/permissions/checker";

describe("isAllowlisted", () => {
  it("should match exact domain", () => {
    expect(isAllowlisted("https://github.com/repo", ["github.com"])).toBe(true);
  });

  it("should match wildcard subdomain", () => {
    expect(isAllowlisted("https://sub.github.com/page", ["*.github.com"])).toBe(true);
  });

  it("should not match unrelated domain", () => {
    expect(isAllowlisted("https://evil.com", ["github.com"])).toBe(false);
  });

  it("should be case insensitive", () => {
    expect(isAllowlisted("https://GITHUB.COM/repo", ["github.com"])).toBe(true);
  });

  it("should return false for empty allowlist", () => {
    expect(isAllowlisted("https://github.com", [])).toBe(false);
  });

  it("should return false for empty URL", () => {
    expect(isAllowlisted("", ["github.com"])).toBe(false);
  });

  it("should match subdomain with wildcard only", () => {
    expect(isAllowlisted("https://api.dev.example.com", ["*.dev.example.com"])).toBe(true);
  });

  it("should not match parent domain with child wildcard", () => {
    expect(isAllowlisted("https://example.com", ["*.dev.example.com"])).toBe(false);
  });
});
