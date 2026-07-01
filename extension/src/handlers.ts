/**
 * BRP Pure Logic Module.
 *
 * Contains testable functions from the background worker without direct
 * browser.* dependencies.
 */
import type {
  GeneratedInitializeResult,
  JsonObject,
  MethodRoute,
  NavigationDecision,
  SelectorObject,
  TabTracker,
} from "./types";
import { isJsonObject } from "./types";

export const RESTRICTED_URL_PREFIXES = [
  "about:",
  "chrome:",
  "moz-extension:",
  "resource:",
  "view-source:",
  "blob:",
  "data:",
  "javascript:",
] as const;

export const METHOD_ROUTES = {
  initialize: { type: "direct", handler: "handleInitialize" },
  shutdown: { type: "direct", handler: "handleShutdown" },
  "tab.list": { type: "direct", handler: "handleTabList" },
  "tab.open": { type: "direct", handler: "handleTabOpen" },
  "tab.close": { type: "direct", handler: "handleTabClose" },
  "tab.select": { type: "direct", handler: "handleTabSelect" },
  "tab.setControllable": { type: "direct", handler: "handleTabSetControllable" },
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
  "script.execute": { type: "direct", handler: "handleScriptExecute" },
  "history.search": { type: "direct", handler: "handleHistorySearch" },
  "history.delete": { type: "direct", handler: "handleHistoryDelete" },
} as const satisfies Record<string, MethodRoute>;

export function validateUrl(url: unknown): string | null {
  if (!url || typeof url !== "string") return "URL is required";
  if (url.length > 8192) return "URL too long (max 8192 chars)";
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.toLowerCase();
    if (scheme !== "http:" && scheme !== "https:" && url !== "about:blank") {
      return `Blocked URL scheme: ${scheme} (only http(s) and about:blank allowed)`;
    }
    return null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `Invalid URL: ${message}`;
  }
}

export function validateSelector(selector: unknown): string | null {
  if (!selector) return null;
  if (isJsonObject(selector) && "value" in selector) {
    const typedSelector: SelectorObject = selector;
    if (typeof typedSelector.value !== "string") return "Selector value must be a string";
    if (typedSelector.value.length > 4096) return "Selector too long (max 4096 chars)";
  }
  return null;
}

export function validateTabId(tabId: unknown): string | null {
  if (tabId === undefined || tabId === null) return null;
  if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) {
    return "tabId must be a non-negative integer";
  }
  return null;
}

export function isRestrictedUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length === 0) return true;
  return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function shouldBlockNavigation(
  url: string | undefined,
  tabId: number,
  controllableTabs: ReadonlySet<number>,
): NavigationDecision {
  if (!controllableTabs.has(tabId)) return { block: false };
  if (!url) return { block: false };
  if (url === "about:blank") return { block: false };

  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.toLowerCase();
    if (scheme === "http:" || scheme === "https:") return { block: false };
  } catch (_error: unknown) {
    return { block: false };
  }

  return {
    block: true,
    reason: "Blocked by BRP navigation sentinel (non-http(s) scheme)",
  };
}

export function createTabTracker(): TabTracker {
  const tabIds = new Set<number>();
  return {
    add(tabId: number): void {
      tabIds.add(tabId);
    },
    remove(tabId: number): boolean {
      return tabIds.delete(tabId);
    },
    has(tabId: number): boolean {
      return tabIds.has(tabId);
    },
    getAll(): Set<number> {
      return new Set(tabIds);
    },
    get size(): number {
      return tabIds.size;
    },
    clear(): void {
      tabIds.clear();
    },
  };
}

export function routeMethod(method: string): MethodRoute | null {
  return METHOD_ROUTES[method as keyof typeof METHOD_ROUTES] ?? null;
}

export function getKnownMethods(): string[] {
  return Object.keys(METHOD_ROUTES);
}

export function handleInitialize(params?: JsonObject): GeneratedInitializeResult {
  const testSeed = params?._testSeed;
  const protocolVersion = params?.protocolVersion;
  return {
    sessionId: "ext-" + (typeof testSeed === "string" ? testSeed : Math.random().toString(36).slice(2, 8)),
    protocolVersion: typeof protocolVersion === "string" ? protocolVersion : "0.1.0",
    negotiatedVersion: "0.1.0",
    serverInfo: { name: "brp-extension-gecko", version: "0.1.0" },
    lastSequence: 0n,
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
        "tab.setControllable",
        "element.click",
        "element.type",
        "element.fill",
        "element.scroll",
        "element.hover",
        "element.select",
        "element.getAttribute",
        "keyboard.press",
        "script.execute",
        "history.search",
        "history.delete",
      ],
      treeDeltaSupported: false,
      multiSession: false,
      maxRequestSize: null,
    },
  };
}
