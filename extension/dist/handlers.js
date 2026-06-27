"use strict";
var BRP = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/handlers.ts
  var handlers_exports = {};
  __export(handlers_exports, {
    METHOD_ROUTES: () => METHOD_ROUTES,
    RESTRICTED_URL_PREFIXES: () => RESTRICTED_URL_PREFIXES,
    createTabTracker: () => createTabTracker,
    getKnownMethods: () => getKnownMethods,
    handleInitialize: () => handleInitialize,
    isRestrictedUrl: () => isRestrictedUrl,
    routeMethod: () => routeMethod,
    shouldBlockNavigation: () => shouldBlockNavigation,
    validateSelector: () => validateSelector,
    validateTabId: () => validateTabId,
    validateUrl: () => validateUrl
  });

  // src/types.ts
  function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/handlers.ts
  var RESTRICTED_URL_PREFIXES = [
    "about:",
    "chrome:",
    "moz-extension:",
    "resource:",
    "view-source:",
    "blob:",
    "data:",
    "javascript:"
  ];
  var METHOD_ROUTES = {
    initialize: { type: "direct", handler: "handleInitialize" },
    shutdown: { type: "direct", handler: "handleShutdown" },
    "tab.list": { type: "direct", handler: "handleTabList" },
    "tab.open": { type: "direct", handler: "handleTabOpen" },
    "tab.close": { type: "direct", handler: "handleTabClose" },
    "tab.select": { type: "direct", handler: "handleTabSelect" },
    "page.navigate": { type: "direct", handler: "handlePageNavigate" },
    "page.getInteractionTree": { type: "direct", handler: "handleGetITree" },
    "page.screenshot": { type: "direct", handler: "handleScreenshot" },
    "element.click": { type: "elementAction", action: "click" },
    "element.type": { type: "elementAction", action: "type" },
    "element.fill": { type: "elementAction", action: "fill" },
    "element.scroll": { type: "elementAction", action: "scroll" },
    "element.hover": { type: "elementAction", action: "hover" },
    "element.select": { type: "elementAction", action: "select" },
    "element.getAttribute": { type: "elementAction", action: "getAttribute" },
    "keyboard.press": { type: "direct", handler: "handleKeyboardPress" },
    "page.goBack": { type: "direct", handler: "handleGoBack" },
    "page.goForward": { type: "direct", handler: "handleGoForward" },
    "page.reload": { type: "direct", handler: "handleReload" },
    "page.waitForSelector": { type: "elementAction", action: "waitForSelector" },
    "script.execute": { type: "direct", handler: "handleScriptExecute" }
  };
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Invalid URL: ${message}`;
    }
  }
  function validateSelector(selector) {
    if (!selector) return null;
    if (isJsonObject(selector) && "value" in selector) {
      const typedSelector = selector;
      if (typeof typedSelector.value !== "string") return "Selector value must be a string";
      if (typedSelector.value.length > 4096) return "Selector too long (max 4096 chars)";
    }
    return null;
  }
  function validateTabId(tabId) {
    if (tabId === void 0 || tabId === null) return null;
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) {
      return "tabId must be a non-negative integer";
    }
    return null;
  }
  function isRestrictedUrl(url) {
    if (typeof url !== "string" || url.length === 0) return true;
    return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
  }
  function shouldBlockNavigation(url, tabId, agentTabIds) {
    if (!agentTabIds.has(tabId)) return { block: false };
    if (!url) return { block: false };
    if (url === "about:blank") return { block: false };
    try {
      const parsed = new URL(url);
      const scheme = parsed.protocol.toLowerCase();
      if (scheme === "http:" || scheme === "https:") return { block: false };
    } catch (_error) {
      return { block: false };
    }
    return {
      block: true,
      reason: "Blocked by BRP navigation sentinel (non-http(s) scheme)"
    };
  }
  function createTabTracker() {
    const tabIds = /* @__PURE__ */ new Set();
    return {
      add(tabId) {
        tabIds.add(tabId);
      },
      remove(tabId) {
        return tabIds.delete(tabId);
      },
      has(tabId) {
        return tabIds.has(tabId);
      },
      getAll() {
        return new Set(tabIds);
      },
      get size() {
        return tabIds.size;
      },
      clear() {
        tabIds.clear();
      }
    };
  }
  function routeMethod(method) {
    return METHOD_ROUTES[method] ?? null;
  }
  function getKnownMethods() {
    return Object.keys(METHOD_ROUTES);
  }
  function handleInitialize(params) {
    const testSeed = params?._testSeed;
    const protocolVersion = params?.protocolVersion;
    return {
      sessionId: "ext-" + (typeof testSeed === "string" ? testSeed : Math.random().toString(36).slice(2, 8)),
      protocolVersion: typeof protocolVersion === "string" ? protocolVersion : "0.1.0",
      negotiatedVersion: "0.1.0",
      serverInfo: { name: "brp-extension-gecko", version: "0.1.0" },
      capabilities: {
        features: ["interactionTree", "events", "screenshot"],
        actions: [
          "page.navigate",
          "page.getInteractionTree",
          "page.screenshot",
          "page.goBack",
          "page.goForward",
          "page.reload",
          "page.waitForSelector",
          "tab.list",
          "tab.open",
          "tab.close",
          "tab.select",
          "element.click",
          "element.type",
          "element.fill",
          "element.scroll",
          "element.hover",
          "element.select",
          "element.getAttribute",
          "keyboard.press",
          "script.execute"
        ],
        treeDeltaSupported: false,
        multiSession: false
      }
    };
  }
  return __toCommonJS(handlers_exports);
})();
