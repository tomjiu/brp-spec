/**
 * Tests for v0.5.1 Page Indicator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createIndicator, updateIndicator, removeIndicator } from "../src/page-indicator";

describe("page-indicator", () => {
  let dom: JSDOM;

  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>");
    globalThis.document = dom.window.document;
  });

  afterEach(() => {
    vi.useRealTimers();
    removeIndicator();
  });

  it("should create indicator element with correct ID", () => {
    const el = createIndicator();
    expect(el.id).toBe("brp-page-indicator");
    expect(el.style.position).toBe("fixed");
    expect(el.style.zIndex).toBe("2147483647");
  });

  it("should be idempotent — not create duplicates", () => {
    createIndicator();
    createIndicator();
    expect(dom.window.document.querySelectorAll("#brp-page-indicator").length).toBe(1);
  });

  it("should update to active status (green)", () => {
    updateIndicator("active", "github.com");
    const el = dom.window.document.getElementById("brp-page-indicator")!;
    expect(el.style.backgroundColor).toBe("rgb(34, 197, 94)");
    expect(el.textContent).toContain("github.com");
  });

  it("should update to idle status (blue)", () => {
    updateIndicator("idle", "example.com");
    const el = dom.window.document.getElementById("brp-page-indicator")!;
    expect(el.style.backgroundColor).toBe("rgb(0, 96, 223)");
    expect(el.textContent).toContain("example.com");
  });

  it("should remove indicator on hidden status", () => {
    updateIndicator("active", "test.com");
    updateIndicator("hidden");
    expect(dom.window.document.getElementById("brp-page-indicator")).toBeNull();
  });

  it("should auto-fade after 3s", () => {
    updateIndicator("idle");
    vi.advanceTimersByTime(3001);
    const el = dom.window.document.getElementById("brp-page-indicator")!;
    expect(el.style.opacity).toBe("0.3");
  });

  it("should restore opacity on status change", () => {
    updateIndicator("idle");
    vi.advanceTimersByTime(3001);
    updateIndicator("active"); // status change resets
    const el = dom.window.document.getElementById("brp-page-indicator")!;
    expect(el.style.opacity).toBe("1");
  });

  it("should not fade while hovered", () => {
    updateIndicator("idle");
    const el = dom.window.document.getElementById("brp-page-indicator")!;
    el.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
    vi.advanceTimersByTime(5000);
    expect(el.style.opacity).toBe("1"); // still fully visible
  });
});
