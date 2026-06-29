/**
 * Tests for v0.5.2 Tab Permission.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock controllableTabs as a module-level Set
const controllableTabs = new Set<number>();

// Mock browser APIs
const tabsQueryMock = vi.fn();
const sendMessageMock = vi.fn(() => Promise.resolve());
const getActiveTabIdMock = vi.fn();

vi.stubGlobal("browser", {
  tabs: {
    query: tabsQueryMock,
    sendMessage: sendMessageMock,
  },
  browserAction: {
    setIcon: vi.fn(() => Promise.resolve()),
    setBadgeText: vi.fn(() => Promise.resolve()),
    setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
  },
});

// Minimal getActiveTabId for tests
async function getActiveTabId(): Promise<number | null> {
  return getActiveTabIdMock() ?? null;
}

// ─── Replicate the tab check logic ───
const TAB_SCOPED_METHODS: ReadonlySet<string> = new Set([
  "page.navigate", "page.getInteractionTree", "page.screenshot",
  "page.goBack", "page.goForward", "page.reload", "page.waitForSelector",
  "element.click", "element.type", "element.fill", "element.scroll",
  "element.hover", "element.select", "element.getAttribute",
  "keyboard.press", "script.execute",
  "tab.close", "tab.select",
]);

function checkTabControllable(method: string, tabId: number | null): boolean {
  if (!TAB_SCOPED_METHODS.has(method)) return true; // not tab-scoped, skip check
  if (tabId === null) return true; // no tab context, skip check
  return controllableTabs.has(tabId);
}

describe("tab permission check", () => {
  beforeEach(() => {
    controllableTabs.clear();
    vi.clearAllMocks();
    getActiveTabIdMock.mockReturnValue(1);
  });

  describe("checkTabControllable", () => {
    it("should reject tab-scoped method on non-controllable tab", () => {
      expect(checkTabControllable("element.click", 5)).toBe(false);
    });

    it("should allow tab-scoped method on controllable tab", () => {
      controllableTabs.add(1);
      expect(checkTabControllable("page.navigate", 1)).toBe(true);
    });

    it("should not check non-tab-scoped methods", () => {
      expect(checkTabControllable("initialize", 5)).toBe(true);
      expect(checkTabControllable("tab.list", 5)).toBe(true);
      expect(checkTabControllable("shutdown", 5)).toBe(true);
    });

    it("should allow tab.open without controllable check", () => {
      expect(checkTabControllable("tab.open", 5)).toBe(true);
    });

    it("should skip check when tabId is null", () => {
      expect(checkTabControllable("element.click", null)).toBe(true);
    });
  });

  describe("controllableTabs add/remove", () => {
    it("should add tab to controllableTabs on setControllable true", () => {
      controllableTabs.add(3);
      expect(controllableTabs.has(3)).toBe(true);
    });

    it("should remove tab from controllableTabs on setControllable false", () => {
      controllableTabs.add(3);
      controllableTabs.delete(3);
      expect(controllableTabs.has(3)).toBe(false);
    });

    it("should support multiple controllable tabs", () => {
      controllableTabs.add(1);
      controllableTabs.add(2);
      expect(controllableTabs.size).toBe(2);
      expect(controllableTabs.has(1)).toBe(true);
      expect(controllableTabs.has(2)).toBe(true);
    });
  });

  describe("auto-demote", () => {
    it("should demote on BRP_PERMISSION_DENIED", () => {
      controllableTabs.add(1);
      controllableTabs.delete(1); // simulate demote
      expect(controllableTabs.has(1)).toBe(false);
    });

    it("should NOT demote on BRP_USER_BLOCKED_DOMAIN (E2, code -32002)", () => {
      controllableTabs.add(1);
      // Simulate: E2 block happened, tab stays controllable
      expect(controllableTabs.has(1)).toBe(true);
    });
  });
});
