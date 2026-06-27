"use strict";
(() => {
  // src/types.ts
  function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function getString(value, key) {
    const item = value?.[key];
    return typeof item === "string" ? item : void 0;
  }
  function getNumber(value, key) {
    const item = value?.[key];
    return typeof item === "number" ? item : void 0;
  }
  function getBoolean(value, key) {
    const item = value?.[key];
    return typeof item === "boolean" ? item : void 0;
  }
  function getObject(value, key) {
    const item = value?.[key];
    return isJsonObject(item) ? item : void 0;
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
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
  function shouldBlockNavigation(url, tabId, agentTabIds2) {
    if (!agentTabIds2.has(tabId)) return { block: false };
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

  // src/background.ts
  var WS_URL = "ws://127.0.0.1:9817";
  var RECONNECT_BASE_DELAY = 1e3;
  var RECONNECT_MAX_DELAY = 1e4;
  var ws = null;
  var reconnectAttempts = 0;
  var reconnectTimer = null;
  var authenticated = false;
  var agentTabIds = /* @__PURE__ */ new Set();
  browser.tabs.onRemoved.addListener((tabId) => {
    agentTabIds.delete(tabId);
  });
  async function getAuthToken() {
    try {
      const result = await browser.storage.local.get("brpAuthToken");
      const token = result.brpAuthToken;
      return typeof token === "string" ? token : null;
    } catch (error) {
      console.warn("[BRP] Could not read stored token:", errorMessage(error));
      return null;
    }
  }
  async function sendToContentScript(tabId, message, timeoutMs = 15e3) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (isRestrictedUrl(tab.url)) {
        return {
          error: `Cannot interact with restricted page: ${tab.url ?? ""}`,
          errorCode: "BRP_RESTRICTED_PAGE",
          retriable: false,
          recoveryHint: "Navigate to a regular web page first"
        };
      }
    } catch (_error) {
    }
    const response = await Promise.race([
      browser.tabs.sendMessage(tabId, message),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Content script timed out (15s)")), timeoutMs);
      })
    ]);
    return isJsonValue(response) ? response : null;
  }
  function isJsonRpcRequest(value) {
    if (!isJsonObject(value)) return false;
    const id = value.id;
    const method = value.method;
    const params = value.params;
    const error = value.error;
    const jsonrpc = value.jsonrpc;
    const hasValidId = id === void 0 || id === null || typeof id === "string" || typeof id === "number";
    const hasValidMethod = method === void 0 || method === null || typeof method === "string";
    const hasValidParams = params === void 0 || params === null || isJsonObject(params);
    const hasValidError = error === void 0 || error === null || isJsonObject(error);
    const hasValidJsonrpc = jsonrpc === void 0 || jsonrpc === null || jsonrpc === "2.0";
    return hasValidId && hasValidMethod && hasValidParams && hasValidError && hasValidJsonrpc;
  }
  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }
    console.log("[BRP] Connecting to bridge at", WS_URL);
    ws = new WebSocket(WS_URL);
    ws.onopen = async () => {
      console.log("[BRP] Connected to bridge");
      reconnectAttempts = 0;
      authenticated = false;
      let token = null;
      try {
        token = await getAuthToken();
      } catch (error) {
        console.warn("[BRP] Token lookup error:", error);
      }
      let browserName = "unknown";
      try {
        const info = await browser.runtime.getBrowserInfo();
        browserName = (info.name || "Firefox").toLowerCase();
      } catch (_error) {
        browserName = navigator.userAgent.includes("Zen") ? "zen" : "firefox";
      }
      const registerMsg = JSON.stringify({
        jsonrpc: "2.0",
        method: "register",
        params: {
          browserId: browserName,
          token: token || "",
          userAgent: navigator.userAgent,
          extensionVersion: "0.3.0"
        }
      });
      ws?.send(registerMsg);
      console.log("[BRP] Registering as:", browserName, token ? "(with token)" : "(no token \u2014 Origin-only auth)");
    };
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (!isJsonRpcRequest(parsed)) return;
        const msg = parsed;
        if (!authenticated && isJsonObject(msg.error)) {
          console.error("[BRP] Bridge rejected registration:", getString(msg.error, "message"));
          ws?.close(4001, "Auth failed");
          return;
        }
        authenticated = true;
        console.log("[BRP] \u2190 ", msg.method || msg.id);
        void handleRequest(msg);
      } catch (error) {
        console.error("[BRP] Parse error:", error);
      }
    };
    ws.onclose = (event) => {
      const authFailed = event.code === 4001;
      console.warn("[BRP] Disconnected (code=%d%s)", event.code, authFailed ? ", auth failed" : "");
      ws = null;
      scheduleReconnect(authFailed);
    };
    ws.onerror = () => {
      console.error("[BRP] WebSocket error");
    };
  }
  function scheduleReconnect(authFailed = false) {
    if (reconnectTimer) return;
    let delay = authFailed ? Math.min(RECONNECT_BASE_DELAY * 5 * Math.pow(2, reconnectAttempts), 3e4) : Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), RECONNECT_MAX_DELAY);
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    delay = Math.round(delay + jitter);
    reconnectAttempts++;
    console.log("[BRP] Reconnect in %dms (attempt %d%s)", delay, reconnectAttempts, authFailed ? ", auth failed" : "");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }
  function sendToBridge(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(msg);
      console.log("[BRP] \u2192 ", "method" in msg ? msg.method : msg.id || "notification");
      ws.send(json);
    } else {
      console.warn("[BRP] Not connected, dropping:", msg);
    }
  }
  async function handleRequest(msg) {
    if (msg.id === void 0 || msg.id === null || !msg.method) return;
    const id = msg.id;
    const method = msg.method;
    const params = msg.params ?? void 0;
    try {
      let result;
      switch (method) {
        case "initialize":
          result = handleInitialize2(params);
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
              data: { errorCode: "BRP_METHOD_NOT_FOUND", retriable: false }
            }
          });
          return;
      }
      sendToBridge({ jsonrpc: "2.0", id, result });
    } catch (error) {
      sendToBridge({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32e3,
          message: errorMessage(error) || "Internal error",
          data: { errorCode: "BRP_INTERNAL_ERROR", retriable: false }
        }
      });
    }
  }
  function handleInitialize2(params) {
    return handleInitialize(params);
  }
  async function handleShutdown() {
    return {};
  }
  async function handleTabList() {
    const tabs = await browser.tabs.query({});
    return {
      tabs: tabs.map((t) => ({
        tabId: t.id,
        windowId: t.windowId,
        title: t.title,
        url: t.url,
        active: t.active,
        status: t.status
      }))
    };
  }
  async function handleTabOpen(params) {
    const url = getString(params, "url") ?? "about:blank";
    const urlErr = validateUrl(url);
    if (urlErr) throw new Error(urlErr);
    const tab = await browser.tabs.create({ url, active: getBoolean(params, "active") !== false });
    if (typeof tab.id === "number") agentTabIds.add(tab.id);
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url };
  }
  async function handleTabClose(params) {
    const requestedTabId = getNumber(params, "tabId");
    if (requestedTabId !== void 0) {
      await browser.tabs.remove(requestedTabId);
    } else {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (typeof tab?.id === "number") await browser.tabs.remove(tab.id);
    }
    return {};
  }
  async function handleTabSelect(params) {
    let tab;
    const tabId = getNumber(params, "tabId");
    if (tabId !== void 0) {
      tab = await browser.tabs.update(tabId, { active: true });
    } else {
      const pageIdx = getNumber(params, "pageIdx");
      if (pageIdx !== void 0) {
        const tabs = await browser.tabs.query({ currentWindow: true });
        const idx = Math.min(pageIdx, tabs.length - 1);
        const selected = tabs[idx];
        if (typeof selected?.id === "number") tab = await browser.tabs.update(selected.id, { active: true });
      }
    }
    return tab ? { tabId: tab.id, title: tab.title, url: tab.url } : {};
  }
  async function handlePageNavigate(params) {
    const url = getString(params, "uri") ?? getString(params, "url");
    const urlErr = validateUrl(url);
    if (urlErr) throw new Error(urlErr);
    if (url === void 0) throw new Error("URL is required");
    const tabId = getNumber(params, "tabId") ?? await getActiveTabId();
    const tabErr = validateTabId(tabId);
    if (tabErr) throw new Error(tabErr);
    agentTabIds.add(tabId);
    await browser.tabs.update(tabId, { url });
    await waitForNavigation(tabId, 15e3);
    return { uri: url };
  }
  async function handleGetITree(params) {
    const tabId = getNumber(params, "tabId") ?? await getActiveTabId();
    return sendToContentScript(tabId, { action: "getITree" });
  }
  async function handleElementAction(actionType, params) {
    const tabId = getNumber(params, "tabId") ?? await getActiveTabId();
    const tabErr = validateTabId(tabId);
    if (tabErr) throw new Error(tabErr);
    const selector = getObject(params, "selector") ?? getObject(params, "selectors");
    const selErr = validateSelector(selector);
    if (selErr) throw new Error(selErr);
    const text = getString(params, "text");
    if (text !== void 0 && text.length > 65536) throw new Error("Text input too long (max 65536 chars)");
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
      css: params?.css
    });
  }
  async function handleKeyboardPress(params) {
    const tabId = getNumber(params, "tabId") ?? await getActiveTabId();
    const tabErr = validateTabId(tabId);
    if (tabErr) throw new Error(tabErr);
    const key = getString(params, "key");
    if (key !== void 0 && key.length > 64) throw new Error("Key combination too long (max 64 chars)");
    return sendToContentScript(tabId, {
      action: "keyboardPress",
      key,
      selector: getObject(params, "selector"),
      nodeId: params?.nodeId
    });
  }
  async function handleGoBack() {
    const tabId = await getActiveTabId();
    try {
      await browser.tabs.goBack(tabId);
    } catch (_error) {
      await browser.tabs.executeScript(tabId, { code: "history.back()" });
    }
    return { success: true };
  }
  async function handleGoForward() {
    const tabId = await getActiveTabId();
    try {
      await browser.tabs.goForward(tabId);
    } catch (_error) {
      await browser.tabs.executeScript(tabId, { code: "history.forward()" });
    }
    return { success: true };
  }
  async function handleReload() {
    const tabId = await getActiveTabId();
    await browser.tabs.reload(tabId);
    await waitForNavigation(tabId, 15e3);
    return { success: true };
  }
  async function handleScreenshot(params) {
    const format = getString(params, "format") ?? "png";
    const captureVisibleTab = browser.tabs.captureVisibleTab;
    const dataUrl = await captureVisibleTab(null, { format: format === "jpeg" ? "jpeg" : "png" });
    return { dataUrl };
  }
  async function handleScriptExecute(params) {
    const tabId = getNumber(params, "tabId") ?? await getActiveTabId();
    const tabErr = validateTabId(tabId);
    if (tabErr) throw new Error(tabErr);
    const code = getString(params, "code");
    if (!code) throw new Error("code parameter is required and must be a string");
    if (code.length > 1048576) throw new Error("Script code too large (max 1MB)");
    return sendToContentScript(tabId, { action: "executeScript", code });
  }
  async function getActiveTabId() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== "number") throw new Error("No active tab");
    return tab.id;
  }
  function waitForNavigation(tabId, timeoutMs) {
    return new Promise((resolve) => {
      function listener(changedTabId, changeInfo) {
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
  browser.webNavigation.onBeforeNavigate.addListener((details) => {
    const decision = shouldBlockNavigation(details.url, details.tabId, agentTabIds);
    if (!decision.block) return;
    console.warn(`[BRP] Navigation sentinel: BLOCKED ${details.url} in tab ${details.tabId}`);
    void browser.tabs.update(details.tabId, { url: "about:blank" }).catch(() => void 0);
    sendToBridge({
      jsonrpc: "2.0",
      method: "notification/navigationBlocked",
      params: { tabId: details.tabId, url: details.url, reason: decision.reason }
    });
  });
  function getNavigationWindowId(details) {
    if (isJsonObject(details) && typeof details.windowId === "number") return details.windowId;
    return "undefined";
  }
  browser.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId === 0) {
      sendToBridge({
        jsonrpc: "2.0",
        method: "notification/navigationCompleted",
        params: {
          uri: `brp://gecko/default/window-${getNavigationWindowId(details)}/tab-${details.tabId}/frame-0`,
          url: details.url,
          tabId: details.tabId
        }
      });
    }
  });
  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
      sendToBridge({
        jsonrpc: "2.0",
        method: "notification/navigationStarted",
        params: {
          uri: `brp://gecko/default/window-${getNavigationWindowId(details)}/tab-${details.tabId}/frame-0`,
          url: details.url,
          tabId: details.tabId
        }
      });
    }
  });
  browser.runtime.onMessage.addListener((msg, sender) => {
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
        uri: sender.tab ? `brp://gecko/default/window-${sender.tab.windowId}/tab-${sender.tab.id}/frame-0` : void 0
      }
    });
  });
  function isJsonValue(value) {
    if (value === null) return true;
    if (["string", "number", "boolean"].includes(typeof value)) return true;
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (isJsonObject(value)) return Object.values(value).every((item) => item === void 0 || isJsonValue(item));
    return false;
  }
  connect();
})();
