/**
 * Tests for BRP pure logic module (src/handlers.ts)
 *
 * Covers: input validation, URL classification, navigation sentinel,
 * tab tracking, message routing, and initialize handler.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as BRP from "../src/handlers";

// --- Input Validation ---

describe("validateUrl", () => {
  it("accepts http URLs", () => {
    expect(BRP.validateUrl("http://example.com")).toBeNull();
    expect(BRP.validateUrl("http://localhost:3000/path?q=1")).toBeNull();
  });

  it("accepts https URLs", () => {
    expect(BRP.validateUrl("https://example.com")).toBeNull();
    expect(BRP.validateUrl("https://sub.domain.com/path#hash")).toBeNull();
  });

  it("accepts about:blank", () => {
    expect(BRP.validateUrl("about:blank")).toBeNull();
  });

  it("rejects javascript: URIs", () => {
    const err = BRP.validateUrl("javascript:alert(1)");
    expect(err).not.toBeNull();
    expect(err).toContain("javascript:");
  });

  it("rejects data: URIs", () => {
    const err = BRP.validateUrl("data:text/html,<h1>hi</h1>");
    expect(err).not.toBeNull();
    expect(err).toContain("data:");
  });

  it("rejects file: URIs", () => {
    const err = BRP.validateUrl("file:///etc/passwd");
    expect(err).not.toBeNull();
    expect(err).toContain("file:");
  });

  it("rejects blob: URIs", () => {
    const err = BRP.validateUrl("blob:https://example.com/uuid");
    expect(err).not.toBeNull();
    expect(err).toContain("blob:");
  });

  it("rejects ftp: and other schemes", () => {
    expect(BRP.validateUrl("ftp://files.example.com")).not.toBeNull();
    expect(BRP.validateUrl("mailto:user@example.com")).not.toBeNull();
    expect(BRP.validateUrl("chrome://settings")).not.toBeNull();
  });

  it("rejects null, undefined, and empty string", () => {
    expect(BRP.validateUrl(null)).toBe("URL is required");
    expect(BRP.validateUrl(undefined)).toBe("URL is required");
    expect(BRP.validateUrl("")).toBe("URL is required");
  });

  it("rejects non-string input", () => {
    expect(BRP.validateUrl(42 as unknown as string)).toBe("URL is required");
    expect(BRP.validateUrl({ url: "http://x.com" } as unknown as string)).toBe("URL is required");
  });

  it("rejects URLs that are too long", () => {
    const longUrl = "https://example.com/" + "a".repeat(8200);
    const err = BRP.validateUrl(longUrl);
    expect(err).toContain("too long");
  });

  it("rejects malformed URLs", () => {
    const err = BRP.validateUrl("not a url at all");
    expect(err).toContain("Invalid URL");
  });
});

describe("validateSelector", () => {
  it("returns null for null/undefined (optional parameter)", () => {
    expect(BRP.validateSelector(null)).toBeNull();
    expect(BRP.validateSelector(undefined)).toBeNull();
  });

  it("accepts a valid selector object", () => {
    expect(BRP.validateSelector({ type: "css", value: "#myId" })).toBeNull();
    expect(BRP.validateSelector({ type: "xpath", value: "//div" })).toBeNull();
    expect(BRP.validateSelector({ type: "nodeId", value: "node_42" })).toBeNull();
  });

  it("rejects selector with non-string value", () => {
    const err = BRP.validateSelector({ type: "css", value: 42 as unknown as string });
    expect(err).toContain("string");
  });

  it("rejects selector value that is too long", () => {
    const err = BRP.validateSelector({ type: "css", value: "x".repeat(5000) });
    expect(err).toContain("too long");
  });

  it("accepts selector objects without a value property", () => {
    // Some selector types may not have .value (e.g. coordinate uses {x,y})
    expect(BRP.validateSelector({ type: "coordinate", x: 10, y: 20 })).toBeNull();
  });
});

describe("validateTabId", () => {
  it("returns null for null/undefined (optional parameter)", () => {
    expect(BRP.validateTabId(null)).toBeNull();
    expect(BRP.validateTabId(undefined)).toBeNull();
  });

  it("accepts valid non-negative integers", () => {
    expect(BRP.validateTabId(0)).toBeNull();
    expect(BRP.validateTabId(1)).toBeNull();
    expect(BRP.validateTabId(42)).toBeNull();
    expect(BRP.validateTabId(999999)).toBeNull();
  });

  it("rejects negative integers", () => {
    const err = BRP.validateTabId(-1);
    expect(err).toContain("non-negative integer");
  });

  it("rejects non-integers (floats)", () => {
    expect(BRP.validateTabId(1.5)).toContain("non-negative integer");
    expect(BRP.validateTabId(0.1)).toContain("non-negative integer");
  });

  it("rejects non-number types", () => {
    expect(BRP.validateTabId("42" as unknown as number)).toContain("non-negative integer");
    expect(BRP.validateTabId(true as unknown as number)).toContain("non-negative integer");
    expect(BRP.validateTabId({} as unknown as number)).toContain("non-negative integer");
  });

  it("rejects NaN and Infinity", () => {
    expect(BRP.validateTabId(NaN)).toContain("non-negative integer");
    expect(BRP.validateTabId(Infinity)).toContain("non-negative integer");
    expect(BRP.validateTabId(-Infinity)).toContain("non-negative integer");
  });
});

// --- URL Classification ---

describe("isRestrictedUrl", () => {
  it("returns true for null/undefined/empty", () => {
    expect(BRP.isRestrictedUrl(null)).toBe(true);
    expect(BRP.isRestrictedUrl(undefined)).toBe(true);
    expect(BRP.isRestrictedUrl("")).toBe(true);
  });

  it.each(BRP.RESTRICTED_URL_PREFIXES)(
    "returns true for %s URLs",
    (prefix: string) => {
      expect(BRP.isRestrictedUrl(prefix + "something")).toBe(true);
    }
  );

  it("returns false for http/https URLs", () => {
    expect(BRP.isRestrictedUrl("http://example.com")).toBe(false);
    expect(BRP.isRestrictedUrl("https://example.com")).toBe(false);
  });

  it("returns false for file: URLs (restricted by sentinel, not by content script injection check)", () => {
    // file: is NOT in RESTRICTED_URL_PREFIXES (it's handled by the navigation sentinel)
    expect(BRP.isRestrictedUrl("file:///home/user/doc.html")).toBe(false);
  });
});

// --- Navigation Sentinel ---

describe("shouldBlockNavigation", () => {
  let controllableTabs: Set<number>;

  beforeEach(() => {
    controllableTabs = new Set([10, 20, 30]);
  });

  it("allows all navigations for non-agent tabs", () => {
    expect(BRP.shouldBlockNavigation("file:///etc/passwd", 99, controllableTabs).block).toBe(false);
    expect(BRP.shouldBlockNavigation("javascript:alert(1)", 99, controllableTabs).block).toBe(false);
    expect(BRP.shouldBlockNavigation("data:text/html,hi", 99, controllableTabs).block).toBe(false);
  });

  it("allows http(s) navigations for agent tabs", () => {
    expect(BRP.shouldBlockNavigation("https://example.com", 10, controllableTabs).block).toBe(false);
    expect(BRP.shouldBlockNavigation("http://localhost:3000", 20, controllableTabs).block).toBe(false);
  });

  it("allows about:blank for agent tabs", () => {
    expect(BRP.shouldBlockNavigation("about:blank", 10, controllableTabs).block).toBe(false);
  });

  it("blocks file: for agent tabs", () => {
    const result = BRP.shouldBlockNavigation("file:///etc/passwd", 10, controllableTabs);
    expect(result.block).toBe(true);
    expect(result.reason).toContain("sentinel");
  });

  it("blocks javascript: for agent tabs", () => {
    const result = BRP.shouldBlockNavigation("javascript:alert(1)", 20, controllableTabs);
    expect(result.block).toBe(true);
  });

  it("blocks data: for agent tabs", () => {
    const result = BRP.shouldBlockNavigation("data:text/html,<h1>hi</h1>", 30, controllableTabs);
    expect(result.block).toBe(true);
  });

  it("blocks blob: for agent tabs", () => {
    const result = BRP.shouldBlockNavigation("blob:https://example.com/uuid", 10, controllableTabs);
    expect(result.block).toBe(true);
  });

  it("allows when URL is null or empty", () => {
    expect(BRP.shouldBlockNavigation(null as unknown as string, 10, controllableTabs).block).toBe(false);
    expect(BRP.shouldBlockNavigation("", 10, controllableTabs).block).toBe(false);
  });

  it("allows invalid URLs (let browser handle them)", () => {
    expect(BRP.shouldBlockNavigation("not a url", 10, controllableTabs).block).toBe(false);
  });
});

// --- Tab Tracker ---

describe("createTabTracker", () => {
  let tracker: ReturnType<typeof BRP.createTabTracker>;

  beforeEach(() => {
    tracker = BRP.createTabTracker();
  });

  it("starts empty", () => {
    expect(tracker.size).toBe(0);
    expect(tracker.has(1)).toBe(false);
  });

  it("adds tabs", () => {
    tracker.add(1);
    tracker.add(2);
    expect(tracker.has(1)).toBe(true);
    expect(tracker.has(2)).toBe(true);
    expect(tracker.size).toBe(2);
  });

  it("removes tabs (simulating tab close)", () => {
    tracker.add(1);
    tracker.add(2);
    tracker.remove(1);
    expect(tracker.has(1)).toBe(false);
    expect(tracker.has(2)).toBe(true);
    expect(tracker.size).toBe(1);
  });

  it("handles removing non-existent tabs gracefully", () => {
    expect(tracker.remove(999)).toBe(false);
  });

  it("handles duplicate adds idempotently", () => {
    tracker.add(1);
    tracker.add(1);
    tracker.add(1);
    expect(tracker.size).toBe(1);
  });

  it("returns a copy from getAll (mutations don't affect tracker)", () => {
    tracker.add(1);
    tracker.add(2);
    const all = tracker.getAll();
    all.add(99);
    expect(tracker.has(99)).toBe(false);
  });

  it("clears all tabs", () => {
    tracker.add(1);
    tracker.add(2);
    tracker.add(3);
    tracker.clear();
    expect(tracker.size).toBe(0);
  });

  it("simulates agent tab lifecycle: open, navigate, close", () => {
    // Agent opens a tab
    tracker.add(100);
    expect(tracker.has(100)).toBe(true);

    // Agent navigates the same tab (add is idempotent)
    tracker.add(100);
    expect(tracker.size).toBe(1);

    // Agent opens another tab
    tracker.add(200);
    expect(tracker.size).toBe(2);

    // User closes first tab (onRemoved listener fires)
    tracker.remove(100);
    expect(tracker.has(100)).toBe(false);
    expect(tracker.has(200)).toBe(true);
  });
});

// --- Message Routing ---

describe("routeMethod", () => {
  it("routes all known methods", () => {
    for (const method of BRP.getKnownMethods()) {
      const route = BRP.routeMethod(method);
      expect(route).not.toBeNull();
      expect(route!.type).toMatch(/^(direct|elementAction)$/);
    }
  });

  it("returns null for unknown methods", () => {
    expect(BRP.routeMethod("unknown.method")).toBeNull();
    expect(BRP.routeMethod("")).toBeNull();
    expect(BRP.routeMethod("foo")).toBeNull();
  });

  it("routes element actions correctly", () => {
    const elementMethods = [
      "element.click", "element.type", "element.fill",
      "element.scroll", "element.hover", "element.select",
      "element.getAttribute", "page.waitForSelector",
    ];
    for (const method of elementMethods) {
      const route = BRP.routeMethod(method);
      expect(route!.type).toBe("elementAction");
      expect(route!.action).toBeTruthy();
    }
  });

  it("routes direct handlers correctly", () => {
    const directMethods = [
      "initialize", "shutdown", "tab.list", "tab.open", "tab.close",
      "tab.select", "page.navigate", "page.getInteractionTree",
      "page.screenshot", "keyboard.press", "page.goBack",
      "page.goForward", "page.reload", "script.execute",
    ];
    for (const method of directMethods) {
      const route = BRP.routeMethod(method);
      expect(route!.type).toBe("direct");
      expect(route!.handler).toBeTruthy();
    }
  });

  it("element.click routes to 'click' action", () => {
    expect(BRP.routeMethod("element.click")).toEqual({
      type: "elementAction",
      action: "click",
    });
  });

  it("initialize routes to handleInitialize handler", () => {
    expect(BRP.routeMethod("initialize")).toEqual({
      type: "direct",
      handler: "handleInitialize",
    });
  });

  it("covers exactly 25 routes (all methods from the switch statement)", () => {
    expect(BRP.getKnownMethods().length).toBe(25);
  });
});

// --- Initialize Handler ---

describe("handleInitialize", () => {
  it("returns a valid initialize response", () => {
    const result = BRP.handleInitialize({});
    expect(result.protocolVersion).toBe("0.1.0");
    expect(result.negotiatedVersion).toBe("0.1.0");
    expect(result.serverInfo.name).toBe("brp-extension-gecko");
    expect(result.capabilities.features).toContain("interactionTree");
    expect(result.capabilities.actions).toContain("page.navigate");
    expect(result.capabilities.actions).toContain("element.click");
  });

  it("respects protocolVersion from params", () => {
    const result = BRP.handleInitialize({ protocolVersion: "0.2.0" });
    expect(result.protocolVersion).toBe("0.2.0");
  });

  it("generates a session ID", () => {
    const result = BRP.handleInitialize({});
    expect(result.sessionId).toMatch(/^ext-/);
  });

  it("includes all expected actions in capabilities", () => {
    const result = BRP.handleInitialize({});
    const expectedActions = [
      "page.navigate", "page.getInteractionTree", "page.screenshot",
      "page.goBack", "page.goForward", "page.reload", "page.waitForSelector",
      "tab.list", "tab.open", "tab.close", "tab.select",
      "tab.setControllable",
      "element.click", "element.type", "element.fill", "element.scroll",
      "element.hover", "element.select", "element.getAttribute",
      "keyboard.press", "script.execute",
      "history.search", "history.delete",
    ];
    for (const action of expectedActions) {
      expect(result.capabilities.actions).toContain(action);
    }
  });

  it("should have capabilities.actions matching METHOD_ROUTES keys", () => {
    const result = BRP.handleInitialize({});
    const routes = BRP.getKnownMethods();
    expect(result.capabilities.actions.sort()).toEqual(routes.sort());
  });

  it("should include tab.setControllable in capabilities actions", () => {
    const result = BRP.handleInitialize({});
    expect(result.capabilities.actions).toContain("tab.setControllable");
  });
});
