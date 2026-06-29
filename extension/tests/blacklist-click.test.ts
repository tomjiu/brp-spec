/**
 * Tests for E2 Domain Blacklist — doClick <a> href check.
 *
 * Validates that element.click on <a> links to blacklisted domains
 * are blocked before click() is invoked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

// Mock loadConfig to return config with blacklist
const mockLoadConfig = vi.fn();
vi.mock("../src/permissions/config", () => ({
  loadConfig: mockLoadConfig,
  DEFAULT_CONFIG: {
    permissionGates: {
      scriptExecute: "ask",
      navigateSensitiveDomains: "ask",
      clickSensitiveButtons: "ask",
    },
    sensitiveDomains: [],
    sensitiveButtonPatterns: [],
    domainBlacklist: [],
  },
}));

let dom: JSDOM;
let doc: Document;

function setupDom(html: string) {
  dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
    url: "https://example.com",
  });
  doc = dom.window.document;

  // Polyfill JSDOM-missing methods on prototype BEFORE injecting HTML
  (dom.window.HTMLElement.prototype as any).scrollIntoView = vi.fn();
  (dom.window.HTMLElement.prototype as any).getBoundingClientRect = vi.fn(() => ({
    x: 0, y: 0, width: 100, height: 50, top: 0, right: 100, bottom: 50, left: 0,
  }));

  // Inject HTML after polyfills
  doc.body!.innerHTML = html;

  // Stub elementFromPoint (JSDOM doesn't have it)
  (doc as any).elementFromPoint = vi.fn(() => null);

  // Stub globals
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLAnchorElement", dom.window.HTMLAnchorElement);
  vi.stubGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("HTMLSelectElement", dom.window.HTMLSelectElement);
  vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  vi.stubGlobal("HTMLImageElement", dom.window.HTMLImageElement);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);

  // Mock window.__BRP_ITREE__ with a working findElement
  (dom.window as any).__BRP_ITREE__ = {
    findElement(selector?: any, _selectors?: any, nodeId?: string) {
      if (nodeId) return doc.querySelector(`[data-nodeid="${nodeId}"]`);
      if (!selector) return null;
      const value = selector.value as string;
      switch (selector.type) {
        case "css": return doc.querySelector(value);
        case "text": return Array.from(doc.querySelectorAll("*")).find(
          (el) => el.textContent?.includes(value) ?? false,
        ) ?? null;
        default: return null;
      }
    },
    buildInteractionTree: () => { throw new Error("not used"); },
    getRevision: () => 1,
  };

  vi.stubGlobal("setTimeout", vi.fn((fn: Function) => fn()));
  vi.stubGlobal("browser", {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: { get: vi.fn().mockResolvedValue({}) },
    },
  });
}

describe("doClick <a> href blacklist check", () => {
  beforeEach(async () => {
    setupDom("");
    mockLoadConfig.mockResolvedValue({
      permissionGates: {
        scriptExecute: "ask",
        navigateSensitiveDomains: "ask",
        clickSensitiveButtons: "ask",
      },
      sensitiveDomains: [],
      sensitiveButtonPatterns: [],
      domainBlacklist: ["evil.com", "*.bank.com"],
    });
    vi.resetModules();
  });

  it("should block click on <a> to blacklisted domain", async () => {
    setupDom('<a id="link" href="https://evil.com">Evil</a>');
    const link = doc.getElementById("link") as unknown as HTMLAnchorElement;
    const clickSpy = vi.spyOn(link, "click");

    const { doClick } = await import("../src/content");
    const msg = {
      selector: { type: "css", value: "#link" },
      acceptFallback: false,
    } as any;

    const result = await doClick(msg);

    expect(result).toHaveProperty("errorCode", "BRP_USER_BLOCKED_DOMAIN");
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("should allow click on <a> to non-blacklisted domain", async () => {
    setupDom('<a id="link" href="https://ok.com">OK</a>');
    const link = doc.getElementById("link") as unknown as HTMLAnchorElement;
    const clickSpy = vi.spyOn(link, "click");

    const { doClick } = await import("../src/content");
    const msg = {
      selector: { type: "css", value: "#link" },
      acceptFallback: false,
    } as any;

    const result = await doClick(msg);

    expect(result).toHaveProperty("success", true);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("should allow click on <a> when blacklist is empty", async () => {
    mockLoadConfig.mockResolvedValue({
      permissionGates: {
        scriptExecute: "ask",
        navigateSensitiveDomains: "ask",
        clickSensitiveButtons: "ask",
      },
      sensitiveDomains: [],
      sensitiveButtonPatterns: [],
      domainBlacklist: [],
    });

    setupDom('<a id="link" href="https://evil.com">Evil</a>');
    const link = doc.getElementById("link") as unknown as HTMLAnchorElement;
    const clickSpy = vi.spyOn(link, "click");

    const { doClick } = await import("../src/content");
    const msg = {
      selector: { type: "css", value: "#link" },
      acceptFallback: false,
    } as any;

    const result = await doClick(msg);

    expect(result).toHaveProperty("success", true);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("should not check href on non-<a> elements (button)", async () => {
    setupDom('<button id="btn">Click</button>');
    const btn = doc.getElementById("btn") as unknown as HTMLButtonElement;
    const clickSpy = vi.spyOn(btn, "click");

    const { doClick } = await import("../src/content");
    const msg = {
      selector: { type: "css", value: "#btn" },
      acceptFallback: false,
    } as any;

    const result = await doClick(msg);

    expect(result).toHaveProperty("success", true);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("should resolve wildcard blacklist for subdomain <a>", async () => {
    setupDom('<a id="link" href="https://login.bank.com">Bank</a>');
    const link = doc.getElementById("link") as unknown as HTMLAnchorElement;
    const clickSpy = vi.spyOn(link, "click");

    const { doClick } = await import("../src/content");
    const msg = {
      selector: { type: "css", value: "#link" },
      acceptFallback: false,
    } as any;

    const result = await doClick(msg);

    expect(result).toHaveProperty("errorCode", "BRP_USER_BLOCKED_DOMAIN");
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
