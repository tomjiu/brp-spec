/**
 * BRP Pure Logic Module
 *
 * Extracted testable functions from background.js.
 * No browser.* API dependencies — all functions are pure or operate on
 * injected state (e.g. agentTabIds Set).
 *
 * Loaded as a background script (MV2) via manifest.json, exposing `BRP` global.
 * Also exports via CommonJS for Vitest testing.
 */
var BRP = (function () {
  "use strict";

  // ─── Constants ───

  const RESTRICTED_URL_PREFIXES = [
    "about:", "chrome:", "moz-extension:", "resource:",
    "view-source:", "blob:", "data:", "javascript:"
  ];

  // Complete method routing table (mirrors the switch in background.js handleRequest)
  const METHOD_ROUTES = {
    "initialize":              { type: "direct",       handler: "handleInitialize" },
    "shutdown":                { type: "direct",       handler: "handleShutdown" },
    "tab.list":                { type: "direct",       handler: "handleTabList" },
    "tab.open":                { type: "direct",       handler: "handleTabOpen" },
    "tab.close":               { type: "direct",       handler: "handleTabClose" },
    "tab.select":              { type: "direct",       handler: "handleTabSelect" },
    "page.navigate":           { type: "direct",       handler: "handlePageNavigate" },
    "page.getInteractionTree": { type: "direct",       handler: "handleGetITree" },
    "page.screenshot":         { type: "direct",       handler: "handleScreenshot" },
    "element.click":           { type: "elementAction", action: "click" },
    "element.type":            { type: "elementAction", action: "type" },
    "element.fill":            { type: "elementAction", action: "fill" },
    "element.scroll":          { type: "elementAction", action: "scroll" },
    "element.hover":           { type: "elementAction", action: "hover" },
    "element.select":          { type: "elementAction", action: "select" },
    "element.getAttribute":    { type: "elementAction", action: "getAttribute" },
    "keyboard.press":          { type: "direct",       handler: "handleKeyboardPress" },
    "page.goBack":             { type: "direct",       handler: "handleGoBack" },
    "page.goForward":          { type: "direct",       handler: "handleGoForward" },
    "page.reload":             { type: "direct",       handler: "handleReload" },
    "page.waitForSelector":    { type: "elementAction", action: "waitForSelector" },
    "script.execute":          { type: "direct",       handler: "handleScriptExecute" },
  };

  // ─── Input Validation ───

  /**
   * Validate URL scheme for navigation. Only http(s) and about:blank are allowed.
   * Returns null if valid, or an error message if invalid.
   */
  function validateUrl(url) {
    if (!url || typeof url !== "string") return "URL is required";
    if (url.length > 8192) return "URL too long (max 8192 chars)";
    try {
      const parsed = new URL(url);
      const scheme = parsed.protocol.toLowerCase();
      if (scheme !== "http:" && scheme !== "https:" && url !== "about:blank") {
        return `Blocked URL scheme: ${scheme} (only http(s) and about:blank allowed)`;
      }
      return null;
    } catch (e) {
      return `Invalid URL: ${e.message}`;
    }
  }

  /**
   * Validate a selector object. Returns null if valid, error message otherwise.
   */
  function validateSelector(selector) {
    if (!selector) return null; // optional in some contexts
    if (typeof selector === "object" && selector.value) {
      if (typeof selector.value !== "string") return "Selector value must be a string";
      if (selector.value.length > 4096) return "Selector too long (max 4096 chars)";
    }
    return null;
  }

  /**
   * Validate tabId parameter. Returns null if valid, error message otherwise.
   */
  function validateTabId(tabId) {
    if (tabId === undefined || tabId === null) return null; // optional
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) {
      return "tabId must be a non-negative integer";
    }
    return null;
  }

  // ─── URL Classification ───

  /**
   * Check if a URL is a restricted browser URL (about:, chrome:, etc.)
   * that content scripts cannot be injected into.
   */
  function isRestrictedUrl(url) {
    if (!url) return true;
    return RESTRICTED_URL_PREFIXES.some(prefix => url.startsWith(prefix));
  }

  // ─── Navigation Sentinel ───

  /**
   * Determine whether a navigation should be blocked by the sentinel.
   *
   * Only agent-controlled tabs are restricted. The user's own browsing
   * (file:// PDFs, blob: URLs, etc.) is untouched.
   *
   * @param {string} url - The URL being navigated to
   * @param {number} tabId - The tab being navigated
   * @param {Set<number>} agentTabIds - Set of agent-controlled tab IDs
   * @returns {{ block: boolean, reason?: string }}
   */
  function shouldBlockNavigation(url, tabId, agentTabIds) {
    // Not an agent tab — always allow
    if (!agentTabIds.has(tabId)) return { block: false };

    // No URL — allow (let browser handle it)
    if (!url) return { block: false };

    // about:blank is always allowed
    if (url === "about:blank") return { block: false };

    try {
      const parsed = new URL(url);
      const scheme = parsed.protocol.toLowerCase();
      if (scheme === "http:" || scheme === "https:") return { block: false };
    } catch (e) {
      // Invalid URL — let the browser handle it
      return { block: false };
    }

    // Block dangerous schemes (file:, javascript:, data:, blob:, etc.)
    return {
      block: true,
      reason: "Blocked by BRP navigation sentinel (non-http(s) scheme)",
    };
  }

  // ─── Tab Tracker ───

  /**
   * Create a tab tracker that maintains a Set of agent-controlled tab IDs.
   * Provides a clean interface for adding/removing/checking tabs.
   */
  function createTabTracker() {
    const tabIds = new Set();
    return {
      /** Mark a tab as agent-controlled */
      add(tabId) { tabIds.add(tabId); },
      /** Remove a tab from tracking (called on tab close) */
      remove(tabId) { return tabIds.delete(tabId); },
      /** Check if a tab is agent-controlled */
      has(tabId) { return tabIds.has(tabId); },
      /** Get a copy of all tracked tab IDs */
      getAll() { return new Set(tabIds); },
      /** Number of tracked tabs */
      get size() { return tabIds.size; },
      /** Remove all tracked tabs */
      clear() { tabIds.clear(); },
    };
  }

  // ─── Message Routing ───

  /**
   * Look up the route for a JSON-RPC method name.
   * Returns { type, handler/action } or null if the method is unknown.
   *
   * - type "direct": call the named handler function
   * - type "elementAction": call handleElementAction with the given action string
   */
  function routeMethod(method) {
    return METHOD_ROUTES[method] || null;
  }

  /**
   * Return a list of all known method names.
   */
  function getKnownMethods() {
    return Object.keys(METHOD_ROUTES);
  }

  // ─── Initialize Handler (pure) ───

  /**
   * Produce the initialize response. Pure function — no browser APIs.
   */
  function handleInitialize(params) {
    return {
      sessionId: "ext-" + (params?._testSeed || Math.random().toString(36).slice(2, 8)),
      protocolVersion: params?.protocolVersion || "0.1.0",
      negotiatedVersion: "0.1.0",
      serverInfo: { name: "brp-extension-gecko", version: "0.1.0" },
      capabilities: {
        features: ["interactionTree", "events", "screenshot"],
        actions: [
          "page.navigate", "page.getInteractionTree", "page.screenshot",
          "page.goBack", "page.goForward", "page.reload", "page.waitForSelector",
          "tab.list", "tab.open", "tab.close", "tab.select",
          "element.click", "element.type", "element.fill", "element.scroll",
          "element.hover", "element.select", "element.getAttribute",
          "keyboard.press",
          "script.execute",
        ],
        treeDeltaSupported: false,
        multiSession: false,
      },
    };
  }

  // ─── Exports ───

  return {
    // Constants
    RESTRICTED_URL_PREFIXES,
    METHOD_ROUTES,

    // Validation
    validateUrl,
    validateSelector,
    validateTabId,

    // URL classification
    isRestrictedUrl,

    // Navigation sentinel
    shouldBlockNavigation,

    // Tab tracking
    createTabTracker,

    // Message routing
    routeMethod,
    getKnownMethods,

    // Handlers
    handleInitialize,
  };
})();

// CommonJS export for Vitest / Node.js
if (typeof module !== "undefined" && module.exports) {
  module.exports = BRP;
}
