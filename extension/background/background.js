/**
 * BRP Background Script
 *
 * Connects to the Rust Bridge via WebSocket (ws://127.0.0.1:9817).
 * Receives JSON-RPC requests, routes them to content scripts, and sends back responses.
 * Forwards DOM/navigation events as notifications to the Bridge.
 */

(function () {
  "use strict";

  const WS_URL = "ws://127.0.0.1:9817";
  const TOKEN_URL = "http://127.0.0.1:9818/token";
  const RECONNECT_BASE_DELAY = 1000;
  const RECONNECT_MAX_DELAY = 10000;

  let ws = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let authenticated = false;

  // ─── Auth Token ───

  async function fetchAuthToken() {
    try {
      const resp = await fetch(TOKEN_URL, { cache: "no-store" });
      if (resp.ok) {
        const token = (await resp.text()).trim();
        if (token) {
          console.log("[BRP] Auth token fetched");
          return token;
        }
      }
    } catch (e) {
      console.warn("[BRP] Could not fetch auth token:", e.message || e);
    }
    return null;
  }

  // ─── Safe Content Script Messaging ───

  const RESTRICTED_URL_PREFIXES = [
    "about:", "chrome:", "moz-extension:", "resource:",
    "view-source:", "blob:", "data:", "javascript:"
  ];

  function isRestrictedUrl(url) {
    if (!url) return true;
    return RESTRICTED_URL_PREFIXES.some(prefix => url.startsWith(prefix));
  }

  async function sendToContentScript(tabId, message, timeoutMs = 15000) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (isRestrictedUrl(tab.url)) {
        return {
          error: `Cannot interact with restricted page: ${tab.url}`,
          errorCode: "BRP_RESTRICTED_PAGE",
          retriable: false,
          recoveryHint: "Navigate to a regular web page first"
        };
      }
    } catch (e) {
      // Tab may have closed; continue and let sendMessage handle it
    }

    return Promise.race([
      browser.tabs.sendMessage(tabId, message),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Content script timed out (15s)")),
          timeoutMs
        )
      )
    ]);
  }

  // ─── WebSocket Connection ───

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

      // Fetch auth token from Bridge's token HTTP server
      let token = null;
      try {
        token = await fetchAuthToken();
      } catch (e) {
        console.warn("[BRP] Token fetch error:", e);
      }

      if (!token) {
        console.error("[BRP] No auth token — bridge will reject connection");
      }

      // Detect browser and register with bridge
      let browserName = "unknown";
      try {
        const info = await browser.runtime.getBrowserInfo();
        browserName = (info.name || "Firefox").toLowerCase();
      } catch (e) {
        // Fallback: check userAgent for Zen
        if (navigator.userAgent.includes("Zen")) browserName = "zen";
        else browserName = "firefox";
      }

      const registerMsg = JSON.stringify({
        jsonrpc: "2.0",
        method: "register",
        params: {
          browserId: browserName,
          token: token || "",
          userAgent: navigator.userAgent,
          extensionVersion: "0.2.0"
        }
      });
      ws.send(registerMsg);
      console.log("[BRP] Registering as:", browserName);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Check for auth rejection (bridge sends error immediately after register)
        if (!authenticated && msg.error) {
          console.error("[BRP] Bridge rejected registration:", msg.error.message);
          ws.close(4001, "Auth failed");
          return;
        }

        authenticated = true;
        console.log("[BRP] ← ", msg.method || msg.id);
        handleRequest(msg);
      } catch (e) {
        console.error("[BRP] Parse error:", e);
      }
    };

    ws.onclose = (event) => {
      const authFailed = event.code === 4001;
      console.warn("[BRP] Disconnected (code=%d%s)", event.code, authFailed ? ", auth failed" : "");
      ws = null;
      scheduleReconnect(authFailed);
    };

    ws.onerror = (event) => {
      console.error("[BRP] WebSocket error");
      // onclose will fire after onerror
    };
  }

  function scheduleReconnect(authFailed = false) {
    if (reconnectTimer) return;

    let delay;
    if (authFailed) {
      // Auth failure: token file may not be ready yet (bridge just started)
      delay = Math.min(
        RECONNECT_BASE_DELAY * 5 * Math.pow(2, reconnectAttempts),
        30000
      );
    } else {
      delay = Math.min(
        RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts),
        RECONNECT_MAX_DELAY
      );
    }

    // Add jitter: +/- 25%
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    delay = Math.round(delay + jitter);

    reconnectAttempts++;
    console.log("[BRP] Reconnect in %dms (attempt %d%s)",
      delay, reconnectAttempts, authFailed ? ", auth failed" : "");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function sendToBridge(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(msg);
      console.log("[BRP] → ", msg.method || msg.id || "notification");
      ws.send(json);
    } else {
      console.warn("[BRP] Not connected, dropping:", msg);
    }
  }

  // ─── Request Handling ───

  async function handleRequest(msg) {
    if (msg.id === undefined || !msg.method) return;

    const { id, method, params } = msg;

    try {
      let result;

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
          result = await handleElementAction("click", params);
          break;
        case "element.type":
          result = await handleElementAction("type", params);
          break;
        case "element.fill":
          result = await handleElementAction("fill", params);
          break;
        case "element.scroll":
          result = await handleElementAction("scroll", params);
          break;
        case "element.hover":
          result = await handleElementAction("hover", params);
          break;
        case "element.select":
          result = await handleElementAction("select", params);
          break;
        case "element.getAttribute":
          result = await handleElementAction("getAttribute", params);
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
    } catch (err) {
      sendToBridge({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err.message || "Internal error",
          data: { errorCode: "BRP_INTERNAL_ERROR", retriable: false },
        },
      });
    }
  }

  // ─── Action Handlers ───

  function handleInitialize(params) {
    return {
      sessionId: "ext-" + Math.random().toString(36).slice(2, 8),
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
        status: t.status,
      })),
    };
  }

  async function handleTabOpen(params) {
    const tab = await browser.tabs.create({
      url: params?.url || "about:blank",
      active: params?.active !== false,
    });
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url };
  }

  async function handleTabClose(params) {
    if (params?.tabId) {
      await browser.tabs.remove(params.tabId);
    } else {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab) await browser.tabs.remove(tab.id);
    }
    return {};
  }

  async function handleTabSelect(params) {
    let tab;
    if (params?.tabId) {
      tab = await browser.tabs.update(params.tabId, { active: true });
    } else if (params?.pageIdx !== undefined) {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const idx = Math.min(params.pageIdx, tabs.length - 1);
      tab = await browser.tabs.update(tabs[idx].id, { active: true });
    }
    return tab ? { tabId: tab.id, title: tab.title, url: tab.url } : {};
  }

  async function handlePageNavigate(params) {
    const tabId = params?.tabId || (await getActiveTabId());
    await browser.tabs.update(tabId, { url: params?.uri || params?.url });

    await waitForNavigation(tabId, 15000);
    return { uri: params?.uri || params?.url };
  }

  async function handleGetITree(params) {
    const tabId = params?.tabId || (await getActiveTabId());
    return await sendToContentScript(tabId, { action: "getITree" });
  }

  async function handleElementAction(actionType, params) {
    const tabId = params?.tabId || (await getActiveTabId());
    return await sendToContentScript(tabId, {
      action: actionType,
      selector: params?.selector || params?.selectors,
      text: params?.text,
      nodeId: params?.nodeId,
      value: params?.value,
      values: params?.values,
      attribute: params?.attribute,
      key: params?.key,
      timeout: params?.timeout,
      css: params?.css,
    });
  }

  async function handleKeyboardPress(params) {
    const tabId = params?.tabId || (await getActiveTabId());
    return await sendToContentScript(tabId, {
      action: "keyboardPress",
      key: params?.key,
      selector: params?.selector,
      nodeId: params?.nodeId,
    });
  }

  async function handleGoBack() {
    const tabId = await getActiveTabId();
    // Firefox doesn't have tabs.goBack, use history API
    await browser.tabs.goBack(tabId).catch(() => {
      // Fallback: execute history.back in page
      return browser.tabs.executeScript(tabId, { code: "history.back()" });
    });
    return { success: true };
  }

  async function handleGoForward() {
    const tabId = await getActiveTabId();
    await browser.tabs.goForward(tabId).catch(() => {
      return browser.tabs.executeScript(tabId, { code: "history.forward()" });
    });
    return { success: true };
  }

  async function handleReload() {
    const tabId = await getActiveTabId();
    await browser.tabs.reload(tabId);
    await waitForNavigation(tabId, 15000);
    return { success: true };
  }

  async function handleScreenshot(params) {
    const dataUrl = await browser.tabs.captureVisibleTab(null, {
      format: params?.format || "png",
    });
    return { dataUrl };
  }

  async function handleScriptExecute(params) {
    const tabId = params?.tabId || (await getActiveTabId());
    return await sendToContentScript(tabId, {
      action: "executeScript",
      code: params?.code,
    });
  }

  // ─── Helpers ───

  async function getActiveTabId() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab");
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

  // ─── Event Forwarding ───

  browser.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId === 0) {
      sendToBridge({
        jsonrpc: "2.0",
        method: "notification/navigationCompleted",
        params: {
          uri: `brp://gecko/default/window-${details.windowId}/tab-${details.tabId}/frame-0`,
          url: details.url,
          tabId: details.tabId,
        },
      });
    }
  });

  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
      sendToBridge({
        jsonrpc: "2.0",
        method: "notification/navigationStarted",
        params: {
          uri: `brp://gecko/default/window-${details.windowId}/tab-${details.tabId}/frame-0`,
          url: details.url,
          tabId: details.tabId,
        },
      });
    }
  });

  // Forward events from content scripts
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === "brp-event") {
      sendToBridge({
        jsonrpc: "2.0",
        method: `notification/${msg.event}`,
        params: {
          ...msg.params,
          tabId: sender.tab?.id,
          uri: sender.tab
            ? `brp://gecko/default/window-${sender.tab.windowId}/tab-${sender.tab.id}/frame-0`
            : undefined,
        },
      });
    }
  });

  // ─── Init ───
  connect();
})();
