/**
 * v0.5.1 Status Indicator — Extension icon state management.
 *
 * 4 states: disconnected (gray) / idle (blue) / active (green) / error (red)
 * Badge: shows controllable tab count.
 */

/// <reference types="firefox-webext-browser" />

type BridgeStatus = "disconnected" | "idle" | "active" | "error";

const ICON_PATHS: Record<BridgeStatus, string> = {
  disconnected: "icons/gray-32.png",
  idle: "icons/blue-32.png",
  active: "icons/green-32.png",
  error: "icons/red-32.png",
};

let currentStatus: BridgeStatus = "disconnected";
let errorResetTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;
const ERROR_THRESHOLD = 3;
const ERROR_RESET_MS = 5000;

// internal: connected flag for error recovery
let connected = false;

/** Update the extension icon based on status. */
export function setStatus(status: BridgeStatus): void {
  if (currentStatus === status) return;
  currentStatus = status;

  const base = ICON_PATHS[status];
  browser.browserAction.setIcon({
    path: {
      16: base.replace("32", "16"),
      32: base,
      48: base.replace("32", "48"),
    },
  }).catch(() => {});

  // error 状态 5s 后自动恢复
  if (status === "error") {
    if (errorResetTimer) clearTimeout(errorResetTimer);
    errorResetTimer = setTimeout(() => {
      errorResetTimer = null;
      setStatus(connected ? "idle" : "disconnected");
    }, ERROR_RESET_MS);
  } else {
    if (errorResetTimer) {
      clearTimeout(errorResetTimer);
      errorResetTimer = null;
    }
  }
}

/** Update badge with controllable tab count. */
export function updateBadge(tabCount: number): void {
  const text = tabCount > 0 ? String(tabCount) : "";
  browser.browserAction.setBadgeText({ text }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ color: "#0060df" }).catch(() => {});
}

/** Called when a request starts. */
export function onRequestStart(): void {
  setStatus("active");
}

/** Called when a request ends. */
export function onRequestEnd(success: boolean): void {
  if (success) {
    consecutiveFailures = 0;
    setStatus("idle");
  } else {
    consecutiveFailures++;
    if (consecutiveFailures >= ERROR_THRESHOLD) {
      setStatus("error");
    } else {
      setStatus("idle");
    }
  }
}

/** Called when bridge WS connects. */
export function onBridgeConnect(): void {
  consecutiveFailures = 0;
  setConnected(true);
  setStatus("idle");
}

/** Called when bridge WS disconnects. */
export function onBridgeDisconnect(): void {
  setConnected(false);
  setStatus("disconnected");
}

export function setConnected(c: boolean): void {
  connected = c;
}

// ─── export for testing ───
export function _resetForTest(): void {
  currentStatus = "disconnected";
  consecutiveFailures = 0;
  connected = false;
  if (errorResetTimer) {
    clearTimeout(errorResetTimer);
    errorResetTimer = null;
  }
}
