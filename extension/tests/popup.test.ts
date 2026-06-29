/**
 * Tests for v0.5.2 Popup logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal mock for popup logic testing
const tabsQueryMock = vi.fn();
const sendMessageMock = vi.fn();

let controllableSet: Set<number>;

function isControllable(tabId: number): boolean {
  return controllableSet.has(tabId);
}

function toggleControllable(tabId: number, make: boolean): void {
  if (make) {
    controllableSet.add(tabId);
  } else {
    controllableSet.delete(tabId);
  }
}

describe("popup controllable toggle", () => {
  beforeEach(() => {
    controllableSet = new Set([1, 3]);
  });

  it("should report controllable for tab in set", () => {
    expect(isControllable(1)).toBe(true);
    expect(isControllable(3)).toBe(true);
  });

  it("should report not controllable for tab not in set", () => {
    expect(isControllable(2)).toBe(false);
    expect(isControllable(99)).toBe(false);
  });

  it("should add tab on toggle on", () => {
    toggleControllable(5, true);
    expect(isControllable(5)).toBe(true);
  });

  it("should remove tab on toggle off", () => {
    toggleControllable(1, false);
    expect(isControllable(1)).toBe(false);
  });

  it("should support empty set", () => {
    controllableSet.clear();
    expect(controllableSet.size).toBe(0);
    expect(isControllable(1)).toBe(false);
  });
});
