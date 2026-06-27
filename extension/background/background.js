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
  const RECONNECT_BASE_DELAY = 1000;
  const RECONNECT_MAX_DELAY = 10000;

  let ws = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  // ─── WebSocket Connection ───

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    console.log("[BRP] Connecting to bridge at", WS_URL);
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("[BRP] Connected to bridge");
      reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log("[BRP] ← ", msg.method || msg.id);
        handleRequest(msg);
      } catch (e) {
        console.error("[BRP] Parse error:", e);
      }
    };

    ws.onclose = (event) => {
      console.warn("[BRP] Disconnected (code=%d)", event.code);
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = (event) => {
      console.error("[BRP] WebSocket error");
      // onclose will fire after onerror
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts),
      RECONNECT_MAX_DELAY
    );
    reconnectAttempts++;
    console.log("[BRP] Reconnect in %dms (attempt %d)", delay, reconnectAttempts);
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
          "tab.list", "tab.open", "tab.close", "tab.select",
          "element.click", "element.type", "element.fill", "element.scroll",
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
    return await browser.tabs.sendMessage(tabId, { action: "getITree" });
  }

  async function handleElementAction(actionType, params) {
    const tabId = params?.tabId || (await getActiveTabId());
    return await browser.tabs.sendMessage(tabId, {
      action: actionType,
      selector: params?.selector || params?.selectors,
      text: params?.text,
      nodeId: params?.nodeId,
    });
  }

  async function handleScreenshot(params) {
    const dataUrl = await browser.tabs.captureVisibleTab(null, {
      format: params?.format || "png",
    });
    return { dataUrl };
  }

  async function handleScriptExecute(params) {
    const tabId = params?.tabId || (await getActiveTabId());
    return await browser.tabs.sendMessage(tabId, {
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
