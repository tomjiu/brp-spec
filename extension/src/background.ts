/** BRP Background Script. */
import {
  handleInitialize as handleInitializePure,
  isRestrictedUrl,
  shouldBlockNavigation,
  validateSelector,
  validateTabId,
  validateUrl,
} from "./handlers";
import { releaseBridge, startBridge } from "./native";
import type { BridgeMessage, JsonObject, JsonRpcRequest, JsonValue, MessageId } from "./types";
import { errorMessage, getBoolean, getNumber, getObject, getString, isJsonObject } from "./types";

const WS_URL = "ws://127.0.0.1:9817";
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 10000;

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let authenticated = false;
const agentTabIds = new Set<number>();

browser.tabs.onRemoved.addListener((tabId: number): void => {
  agentTabIds.delete(tabId);
});

async function getAuthToken(): Promise<string | null> {
  try {
    const result = await browser.storage.local.get("brpAuthToken");
    const token = result.brpAuthToken;
    return typeof token === "string" ? token : null;
  } catch (error: unknown) {
    console.warn("[BRP] Could not read stored token:", errorMessage(error));
    return null;
  }
}

async function sendToContentScript(
  tabId: number,
  message: JsonObject,
  timeoutMs = 15000,
): Promise<JsonValue> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (isRestrictedUrl(tab.url)) {
      return {
        error: `Cannot interact with restricted page: ${tab.url ?? ""}`,
        errorCode: "BRP_RESTRICTED_PAGE",
        retriable: false,
        recoveryHint: "Navigate to a regular web page first",
      };
    }
  } catch (_error: unknown) {
    // Tab may have closed; preserve previous behavior and let sendMessage report it.
  }

  const response = await Promise.race<unknown>([
    browser.tabs.sendMessage(tabId, message),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Content script timed out (15s)")), timeoutMs);
    }),
  ]);
  return isJsonValue(response) ? response : null;
}

function isJsonRpcMessage(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) return false;
  const id = value.id;
  const method = value.method;
  const params = value.params;
  const error = value.error;
  const jsonrpc = value.jsonrpc;
  // A valid JSON-RPC 2.0 message has a "2.0" jsonrpc field (if present)
  const hasValidJsonrpc = jsonrpc === undefined || jsonrpc === "2.0";
  // It either has a method (request/notification) or an id with result/error (response)
  const hasValidMethod = typeof method === "string";
  const hasValidId = typeof id === "string" || typeof id === "number";
  const hasValidParams = params === undefined || params === null || isJsonObject(params);
  const hasValidError = error === undefined || error === null || isJsonObject(error);
  // Must have at least method or id to be a meaningful message
  return hasValidJsonrpc && ((hasValidMethod && hasValidParams) || (hasValidId && hasValidError));
}

async function connect(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  // ── B1 Auto-Link (connectNative) ──
  try {
    console.log("[BRP] Trying B1 auto-link via connectNative...");
    ws = await startBridge();
    console.log("[BRP] B1 auto-link succeeded");
    setupConnection(ws);
    return;
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn("[BRP] B1 auto-link failed, falling back to manual config:", detail);
  }

  // ── Fallback: manual WebSocket (v0.3.x behavior) ──
  console.log("[BRP] Connecting to bridge at", WS_URL);
  ws = new WebSocket(WS_URL);
  setupConnection(ws);
}

function setupConnection(socket: WebSocket): void {
  const registerExtension = async (): Promise<void> => {
    console.log("[BRP] Connected to bridge");
    reconnectAttempts = 0;
    authenticated = false;

    let token: string | null = null;
    try {
      token = await getAuthToken();
    } catch (error: unknown) {
      console.warn("[BRP] Token lookup error:", error);
    }

    let browserName = "unknown";
    try {
      const info = await browser.runtime.getBrowserInfo();
      browserName = (info.name || "Firefox").toLowerCase();
    } catch (_error: unknown) {
      browserName = navigator.userAgent.includes("Zen") ? "zen" : "firefox";
    }

    const registerMsg = JSON.stringify({
      jsonrpc: "2.0",
      method: "register",
      params: {
        browserId: browserName,
        token: token || "",
        userAgent: navigator.userAgent,
        extensionVersion: "0.4.1",
      },
    });
    socket.send(registerMsg);
    console.log("[BRP] Registering as:", browserName, token ? "(with token)" : "(no token — Origin-only auth)");
  };

  socket.onopen = (): void => {
    void registerExtension();
  };

  socket.onmessage = (event: MessageEvent<string>): void => {
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!isJsonRpcMessage(parsed)) return;
      const msg: JsonObject = parsed;

      // Check for auth rejection error response before treating as a request
      if (!authenticated && isJsonObject(msg.error)) {
        console.error("[BRP] Bridge rejected registration:", getString(msg.error, "message"));
        socket.close(4001, "Auth failed");
        return;
      }

      // Extract Request fields (validated by isJsonRpcMessage)
      if (msg.id === undefined || msg.id === null || typeof msg.method !== "string") {
        return; // Notification or invalid — skip
      }
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: msg.id as MessageId,
        method: msg.method,
        ...(isJsonObject(msg.params) ? { params: msg.params } : {}),
      };

      authenticated = true;
      console.log("[BRP] ← ", req.method);
      void handleRequest(req);
    } catch (error: unknown) {
      console.error("[BRP] Parse error:", error);
    }
  };

  socket.onclose = (event: CloseEvent): void => {
    const authFailed = event.code === 4001;
    console.warn("[BRP] Disconnected (code=%d%s)", event.code, authFailed ? ", auth failed" : "");
    releaseBridge(); // kill bridge, release single-instance lock
    ws = null;
    scheduleReconnect(authFailed);
  };

  socket.onerror = (): void => {
    console.error("[BRP] WebSocket error");
  };

  // B1 auto-link: socket may already be open when setupConnection is called.
  // onopen won't fire for already-open sockets, so trigger registration manually.
  if (socket.readyState === WebSocket.OPEN) {
    void registerExtension();
  }
}

function scheduleReconnect(authFailed = false): void {
  if (reconnectTimer) return;

  let delay = authFailed
    ? Math.min(RECONNECT_BASE_DELAY * 5 * Math.pow(2, reconnectAttempts), 30000)
    : Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), RECONNECT_MAX_DELAY);

  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  delay = Math.round(delay + jitter);

  reconnectAttempts++;
  console.log("[BRP] Reconnect in %dms (attempt %d%s)", delay, reconnectAttempts, authFailed ? ", auth failed" : "");
  reconnectTimer = setTimeout((): void => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function sendToBridge(msg: BridgeMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const json = JSON.stringify(msg);
    console.log("[BRP] → ", "method" in msg ? msg.method : msg.id || "notification");
    ws.send(json);
  } else {
    console.warn("[BRP] Not connected, dropping:", msg);
  }
}

async function handleRequest(msg: JsonRpcRequest): Promise<void> {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params;

  try {
    let result: JsonValue;
    switch (method) {
      case "initialize":
        result = handleInitialize(params);
        break;
      case "shutdown":
        result = await handleShutdown();
        break;
      case "tab.list":
        result = await handleTabList();
        break;
      case "tab.open":
        result = await handleTabOpen(params);
        break;
      case "tab.close":
        result = await handleTabClose(params);
        break;
      case "tab.select":
        result = await handleTabSelect(params);
        break;
      case "page.navigate":
        result = await handlePageNavigate(params);
        break;
      case "page.getInteractionTree":
        result = await handleGetITree(params);
        break;
      case "page.screenshot":
        result = await handleScreenshot(params);
        break;
      case "element.click":
      case "element.type":
      case "element.fill":
      case "element.scroll":
      case "element.hover":
      case "element.select":
      case "element.getAttribute":
        result = await handleElementAction(method.slice("element.".length), params);
        break;
      case "keyboard.press":
        result = await handleKeyboardPress(params);
        break;
      case "page.goBack":
        result = await handleGoBack();
        break;
      case "page.goForward":
        result = await handleGoForward();
        break;
      case "page.reload":
        result = await handleReload();
        break;
      case "page.waitForSelector":
        result = await handleElementAction("waitForSelector", params);
        break;
      case "script.execute":
        result = await handleScriptExecute(params);
        break;
      default:
        sendToBridge({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
            data: { errorCode: "BRP_METHOD_NOT_FOUND", retriable: false },
          },
        });
        return;
    }
    sendToBridge({ jsonrpc: "2.0", id, result });
  } catch (error: unknown) {
    sendToBridge({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: errorMessage(error) || "Internal error",
        data: { errorCode: "BRP_INTERNAL_ERROR", retriable: false },
      },
    });
  }
}

function handleInitialize(params?: JsonObject): JsonObject {
  return handleInitializePure(params);
}

async function handleShutdown(): Promise<JsonObject> {
  return {};
}

async function handleTabList(): Promise<JsonObject> {
  const tabs = await browser.tabs.query({});
  return {
    tabs: tabs.map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      title: t.title,
      url: t.url,
      active: t.active,
      status: t.status,
    })),
  };
}

async function handleTabOpen(params?: JsonObject): Promise<JsonObject> {
  const url = getString(params, "url") ?? "about:blank";
  const urlErr = validateUrl(url);
  if (urlErr) throw new Error(urlErr);

  const tab = await browser.tabs.create({ url, active: getBoolean(params, "active") !== false });
  if (typeof tab.id === "number") agentTabIds.add(tab.id);
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url };
}

async function handleTabClose(params?: JsonObject): Promise<JsonObject> {
  const requestedTabId = getNumber(params, "tabId");
  if (requestedTabId !== undefined) {
    await browser.tabs.remove(requestedTabId);
  } else {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id === "number") await browser.tabs.remove(tab.id);
  }
  return {};
}

async function handleTabSelect(params?: JsonObject): Promise<JsonObject> {
  let tab: browser.tabs.Tab | undefined;
  const tabId = getNumber(params, "tabId");
  if (tabId !== undefined) {
    tab = await browser.tabs.update(tabId, { active: true });
  } else {
    const pageIdx = getNumber(params, "pageIdx");
    if (pageIdx !== undefined) {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const idx = Math.min(pageIdx, tabs.length - 1);
      const selected = tabs[idx];
      if (typeof selected?.id === "number") tab = await browser.tabs.update(selected.id, { active: true });
    }
  }
  return tab ? { tabId: tab.id, title: tab.title, url: tab.url } : {};
}

async function handlePageNavigate(params?: JsonObject): Promise<JsonObject> {
  const url = getString(params, "uri") ?? getString(params, "url");
  const urlErr = validateUrl(url);
  if (urlErr) throw new Error(urlErr);
  if (url === undefined) throw new Error("URL is required");

  const tabId = getNumber(params, "tabId") ?? (await getActiveTabId());
  const tabErr = validateTabId(tabId);
  if (tabErr) throw new Error(tabErr);

  agentTabIds.add(tabId);
  await browser.tabs.update(tabId, { url });
  await waitForNavigation(tabId, 15000);
  return { uri: url };
}

async function handleGetITree(params?: JsonObject): Promise<JsonValue> {
  const tabId = getNumber(params, "tabId") ?? (await getActiveTabId());
  return sendToContentScript(tabId, { action: "getITree" });
}

async function handleElementAction(actionType: string, params?: JsonObject): Promise<JsonValue> {
  const tabId = getNumber(params, "tabId") ?? (await getActiveTabId());
  const tabErr = validateTabId(tabId);
  if (tabErr) throw new Error(tabErr);

  const selector = getObject(params, "selector") ?? getObject(params, "selectors");
  const selErr = validateSelector(selector);
  if (selErr) throw new Error(selErr);

  const text = getString(params, "text");
  if (text !== undefined && text.length > 65536) throw new Error("Text input too long (max 65536 chars)");

  const values = params?.values;
  if (Array.isArray(values) && values.length > 100) throw new Error("Values array too large (max 100 items)");

  return sendToContentScript(tabId, {
    action: actionType,
    selector,
    text,
    nodeId: params?.nodeId,
    value: params?.value,
    values,
    attribute: params?.attribute,
    key: params?.key,
    timeout: params?.timeout,
    css: params?.css,
  });
}

async function handleKeyboardPress(params?: JsonObject): Promise<JsonValue> {
  const tabId = getNumber(params, "tabId") ?? (await getActiveTabId());
  const tabErr = validateTabId(tabId);
  if (tabErr) throw new Error(tabErr);

  const key = getString(params, "key");
  if (key !== undefined && key.length > 64) throw new Error("Key combination too long (max 64 chars)");

  return sendToContentScript(tabId, {
    action: "keyboardPress",
    key,
    selector: getObject(params, "selector"),
    nodeId: params?.nodeId,
  });
}

async function handleGoBack(): Promise<JsonObject> {
  const tabId = await getActiveTabId();
  try {
    await browser.tabs.goBack(tabId);
  } catch (_error: unknown) {
    await browser.tabs.executeScript(tabId, { code: "history.back()" });
  }
  return { success: true };
}

async function handleGoForward(): Promise<JsonObject> {
  const tabId = await getActiveTabId();
  try {
    await browser.tabs.goForward(tabId);
  } catch (_error: unknown) {
    await browser.tabs.executeScript(tabId, { code: "history.forward()" });
  }
  return { success: true };
}

async function handleReload(): Promise<JsonObject> {
  const tabId = await getActiveTabId();
  await browser.tabs.reload(tabId);
  await waitForNavigation(tabId, 15000);
  return { success: true };
}

async function handleScreenshot(params?: JsonObject): Promise<JsonObject> {
  const format = getString(params, "format") ?? "png";
  const captureVisibleTab = browser.tabs.captureVisibleTab as unknown as (
    windowId: null,
    options: { format: "jpeg" | "png" },
  ) => Promise<string>;
  const dataUrl = await captureVisibleTab(null, { format: format === "jpeg" ? "jpeg" : "png" });
  return { dataUrl };
}

async function handleScriptExecute(params?: JsonObject): Promise<JsonValue> {
  const tabId = getNumber(params, "tabId") ?? (await getActiveTabId());
  const tabErr = validateTabId(tabId);
  if (tabErr) throw new Error(tabErr);

  const code = getString(params, "code");
  if (!code) throw new Error("code parameter is required and must be a string");
  if (code.length > 1048576) throw new Error("Script code too large (max 1MB)");

  return sendToContentScript(tabId, { action: "executeScript", code });
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.id !== "number") throw new Error("No active tab");
  return tab.id;
}

function waitForNavigation(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    function listener(changedTabId: number, changeInfo: browser.tabs._OnUpdatedChangeInfo): void {
      if (changedTabId === tabId && changeInfo.status === "complete") {
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    browser.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
  });
}

browser.webNavigation.onBeforeNavigate.addListener((details: browser.webNavigation._OnBeforeNavigateDetails): void => {
  const decision = shouldBlockNavigation(details.url, details.tabId, agentTabIds);
  if (!decision.block) return;

  console.warn(`[BRP] Navigation sentinel: BLOCKED ${details.url} in tab ${details.tabId}`);
  void browser.tabs.update(details.tabId, { url: "about:blank" }).catch((): void => undefined);
  sendToBridge({
    jsonrpc: "2.0",
    method: "notification/navigationBlocked",
    params: { tabId: details.tabId, url: details.url, reason: decision.reason },
  });
});

function getNavigationWindowId(details: unknown): number | string {
  if (isJsonObject(details) && typeof details.windowId === "number") return details.windowId;
  return "undefined";
}

browser.webNavigation.onCompleted.addListener((details: browser.webNavigation._OnCompletedDetails): void => {
  if (details.frameId === 0) {
    sendToBridge({
      jsonrpc: "2.0",
      method: "notification/navigationCompleted",
      params: {
        uri: `brp://gecko/default/window-${getNavigationWindowId(details)}/tab-${details.tabId}/frame-0`,
        url: details.url,
        tabId: details.tabId,
      },
    });
  }
});

browser.webNavigation.onCommitted.addListener((details: browser.webNavigation._OnCommittedDetails): void => {
  if (details.frameId === 0) {
    sendToBridge({
      jsonrpc: "2.0",
      method: "notification/navigationStarted",
      params: {
        uri: `brp://gecko/default/window-${getNavigationWindowId(details)}/tab-${details.tabId}/frame-0`,
        url: details.url,
        tabId: details.tabId,
      },
    });
  }
});

browser.runtime.onMessage.addListener((msg: unknown, sender: browser.runtime.MessageSender): void => {
  if (!isJsonObject(msg) || msg.type !== "brp-event") return;
  const event = getString(msg, "event");
  if (!event) return;
  const params = getObject(msg, "params") ?? {};
  sendToBridge({
    jsonrpc: "2.0",
    method: `notification/${event}`,
    params: {
      ...params,
      tabId: sender.tab?.id,
      uri: sender.tab ? `brp://gecko/default/window-${sender.tab.windowId}/tab-${sender.tab.id}/frame-0` : undefined,
    },
  });
});

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isJsonObject(value)) return Object.values(value).every((item) => item === undefined || isJsonValue(item));
  return false;
}

void connect();
