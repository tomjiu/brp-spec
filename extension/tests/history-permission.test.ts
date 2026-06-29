/**
 * Tests for v0.5.2 History Access.
 *
 * Tests import real code from flow.ts — not copies.
 */
import { describe, it, expect } from "vitest";
import { checkHistoryAccessError, formatHistoryResults } from "../src/permissions/flow";

describe("checkHistoryAccessError", () => {
  it("should return null when permission granted", () => {
    expect(checkHistoryAccessError(true)).toBeNull();
  });

  it("should return error object when permission not granted", () => {
    const err = checkHistoryAccessError(false);
    expect(err).not.toBeNull();
    expect(err!.code).toBe(-32004);
    expect(err!.data).toHaveProperty("errorCode", "BRP_HISTORY_PERMISSION_NOT_GRANTED");
  });

  it("should include recovery hint", () => {
    const err = checkHistoryAccessError(false);
    expect(err!.data).toHaveProperty("recoveryHint");
    expect((err!.data as Record<string, unknown>).recoveryHint).toBeTruthy();
  });
});

describe("formatHistoryResults", () => {
  it("should format search results correctly", () => {
    const raw = [{ id: "1", url: "https://example.com", title: "Example", lastVisitTime: 1700000000000, visitCount: 5 }];
    const formatted = formatHistoryResults(raw);
    expect(formatted[0].url).toBe("https://example.com");
    expect(formatted[0].visitCount).toBe(5);
  });

  it("should handle missing fields with defaults", () => {
    const raw = [{ id: "1" }];
    const formatted = formatHistoryResults(raw);
    expect(formatted[0].url).toBe("");
    expect(formatted[0].title).toBe("");
    expect(formatted[0].lastVisitTime).toBe(0);
    expect(formatted[0].visitCount).toBe(0);
  });

  it("should handle empty array", () => {
    expect(formatHistoryResults([])).toEqual([]);
  });
});
