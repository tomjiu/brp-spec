/**
 * Tests for v0.5.2 Tab Permission.
 *
 * Tests import real code from flow.ts — not copies.
 */
import { describe, it, expect } from "vitest";
import {
  checkTabControllable, shouldDemoteTab, TAB_SCOPED_METHODS,
} from "../src/permissions/flow";

describe("checkTabControllable", () => {
  const controllableTabs = new Set<number>([1, 2]);

  it("should reject tab-scoped method on non-controllable tab", () => {
    expect(checkTabControllable("element.click", 5, controllableTabs)).toBe(false);
  });

  it("should allow tab-scoped method on controllable tab", () => {
    expect(checkTabControllable("page.navigate", 1, controllableTabs)).toBe(true);
  });

  it("should not check non-tab-scoped methods", () => {
    expect(checkTabControllable("initialize", 5, controllableTabs)).toBe(true);
    expect(checkTabControllable("tab.list", 5, controllableTabs)).toBe(true);
    expect(checkTabControllable("shutdown", 5, controllableTabs)).toBe(true);
  });

  it("should allow tab.open without controllable check", () => {
    expect(checkTabControllable("tab.open", 5, controllableTabs)).toBe(true);
  });

  it("should skip check when tabId is null", () => {
    expect(checkTabControllable("element.click", null, controllableTabs)).toBe(true);
  });

  it("should skip check when tabId is undefined", () => {
    expect(checkTabControllable("element.click", undefined, controllableTabs)).toBe(true);
  });

  it("should allow tab.setControllable without check", () => {
    expect(checkTabControllable("tab.setControllable", 5, controllableTabs)).toBe(true);
  });
});

describe("shouldDemoteTab", () => {
  const controllableTabs = new Set<number>([1]);

  it("should demote on BRP_PERMISSION_DENIED for tab-scoped method", () => {
    expect(shouldDemoteTab("BRP_PERMISSION_DENIED", "element.click", 1, controllableTabs)).toBe(true);
  });

  it("should NOT demote on BRP_USER_BLOCKED_DOMAIN (E2)", () => {
    expect(shouldDemoteTab("BRP_USER_BLOCKED_DOMAIN", "element.click", 1, controllableTabs)).toBe(false);
  });

  it("should NOT demote on BRP_TAB_NOT_CONTROLLABLE", () => {
    expect(shouldDemoteTab("BRP_TAB_NOT_CONTROLLABLE", "element.click", 1, controllableTabs)).toBe(false);
  });

  it("should NOT demote on undefined errorCode (normal error)", () => {
    expect(shouldDemoteTab(undefined, "element.click", 1, controllableTabs)).toBe(false);
  });

  it("should NOT demote non-tab-scoped method", () => {
    expect(shouldDemoteTab("BRP_PERMISSION_DENIED", "initialize", 1, controllableTabs)).toBe(false);
  });

  it("should NOT demote tab not in controllableTabs", () => {
    expect(shouldDemoteTab("BRP_PERMISSION_DENIED", "element.click", 99, controllableTabs)).toBe(false);
  });

  it("should NOT demote when tabId is null", () => {
    expect(shouldDemoteTab("BRP_PERMISSION_DENIED", "element.click", null, controllableTabs)).toBe(false);
  });
});

describe("TAB_SCOPED_METHODS", () => {
  it("should include all element.* methods", () => {
    expect(TAB_SCOPED_METHODS.has("element.click")).toBe(true);
    expect(TAB_SCOPED_METHODS.has("element.type")).toBe(true);
    expect(TAB_SCOPED_METHODS.has("element.fill")).toBe(true);
  });

  it("should include all page.* methods", () => {
    expect(TAB_SCOPED_METHODS.has("page.navigate")).toBe(true);
    expect(TAB_SCOPED_METHODS.has("page.screenshot")).toBe(true);
  });

  it("should include script.execute", () => {
    expect(TAB_SCOPED_METHODS.has("script.execute")).toBe(true);
  });

  it("should include tab.close and tab.select", () => {
    expect(TAB_SCOPED_METHODS.has("tab.close")).toBe(true);
    expect(TAB_SCOPED_METHODS.has("tab.select")).toBe(true);
  });

  it("should NOT include initialize/shutdown/tab.list/tab.open/tab.setControllable", () => {
    expect(TAB_SCOPED_METHODS.has("initialize")).toBe(false);
    expect(TAB_SCOPED_METHODS.has("shutdown")).toBe(false);
    expect(TAB_SCOPED_METHODS.has("tab.list")).toBe(false);
    expect(TAB_SCOPED_METHODS.has("tab.open")).toBe(false);
    expect(TAB_SCOPED_METHODS.has("tab.setControllable")).toBe(false);
  });
});
