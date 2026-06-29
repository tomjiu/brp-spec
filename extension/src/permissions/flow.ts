/**
 * E1 Permission Gating — Flow Logic
 *
 * Orchestrates permission checks: loads config, calls checker,
 * handles dialog display, timeout, and response.
 *
 * Separated from background.ts for testability.
 */

import { shouldGate, isAllowlisted, isBlacklisted } from "./checker";
import { loadConfig, type PermissionGateConfig } from "./config";
import type { JsonObject, MessageId } from "../types";

const PERMISSION_TIMEOUT = 60000; // 60s

interface PendingPermission {
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  dialogTabId?: number;
}

const pendingPermissions = new Map<string, PendingPermission>();

/**
 * Reference to background.ts's controllableTabs Set.
 * Injected via registerControllableTabs() at module load time.
 */
let controllableTabsRef: ReadonlySet<number> = new Set();

/**
 * Register the background script's controllableTabs for dialog tab selection.
 * Call once from background.ts module top-level.
 */
export function registerControllableTabs(ref: ReadonlySet<number>): void {
  controllableTabsRef = ref;
}

export async function getPermConfig(): Promise<PermissionGateConfig> {
  return await loadConfig();
}

/**
 * Check permissions before executing a request.
 * Returns null if allowed, or a JSON-RPC error object if denied/ask-then-denied.
 */
export async function checkPermission(
  id: MessageId,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<JsonObject | null> {
  const config = await getPermConfig();
  const decision = shouldGate(method, params || {}, config);

  if (decision === "allow") return null;

  if (decision === "deny") {
    return {
      code: -32001,
      message: `Permission denied for action: ${method}`,
      data: { errorCode: "BRP_PERMISSION_DENIED", retriable: false },
    };
  }

  // "ask" — show dialog and await user response
  const allowed = await requestUserPermission(method, params || {});
  if (!allowed) {
    return {
      code: -32001,
      message: `User denied permission for: ${method}`,
      data: { errorCode: "BRP_PERMISSION_DENIED", retriable: false },
    };
  }
  return null;
}

async function requestUserPermission(
  method: string,
  params: Record<string, unknown>,
): Promise<boolean> {
  const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { title, description, details } = formatPermissionPrompt(method, params);

  let dialogTabId: number | undefined;

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(requestId);
      // Notify content script to close dialog
      if (dialogTabId !== undefined) {
        browser.tabs.sendMessage(dialogTabId, {
          action: "__brp_permission_dialog_close__",
          requestId,
        }).catch(() => {});
      }
      resolve(false); // timeout → auto-deny
    }, PERMISSION_TIMEOUT);

    pendingPermissions.set(requestId, {
      resolve,
      timer,
      ...(dialogTabId !== undefined ? { dialogTabId } : {}),
    });

    sendDialogToActiveTab(requestId, title, description, details)
      .then((tabId) => {
        dialogTabId = tabId;
        const entry = pendingPermissions.get(requestId);
        if (entry) {
          pendingPermissions.set(requestId, { ...entry, dialogTabId: tabId });
        }
      })
      .catch((err) => {
        console.warn("[BRP] Permission dialog injection failed, denying:", err);
        clearTimeout(timer);
        pendingPermissions.delete(requestId);
        resolve(false); // fail-closed: dialog failure = deny
      });
  });
}

/**
 * Check domain blacklist (E2). Hard-blocks navigation to blacklisted domains.
 * Returns null if allowed, or a JSON-RPC error object if blocked.
 *
 * NOTE: Only checks page.navigate here. element.click <a> href check
 * is done in content.ts (where DOM is accessible).
 */
/**
 * v0.5.1: Check if URL is in domain allowlist.
 * Allowlisted URLs skip E2 blacklist and E1 permission gate entirely.
 * Returns true if URL is allowlisted (skip E1/E2).
 */
export async function checkAllowlist(
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<boolean> {
  if (method !== "page.navigate") return false;

  const url = (params?.url || params?.uri) as string | undefined;
  if (!url) return false;

  const config = await getPermConfig();
  return isAllowlisted(url, config.domainAllowlist);
}

export async function checkBlacklist(
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<JsonObject | null> {
  if (method !== "page.navigate") return null;

  const url = (params?.url || params?.uri) as string | undefined;
  if (!url) return null;

  const config = await getPermConfig();
  if (isBlacklisted(url, config.domainBlacklist)) {
    return {
      code: -32002,
      message: `Domain blocked by user blacklist: ${url}`,
      data: {
        errorCode: "BRP_USER_BLOCKED_DOMAIN",
        retriable: false,
      },
    };
  }
  return null;
}

/**
 * Resolve a pending permission request (called from onMessage listener).
 */
export function resolvePermission(requestId: string, decision: string): void {
  const entry = pendingPermissions.get(requestId);
  if (!entry) return;

  clearTimeout(entry.timer);
  pendingPermissions.delete(requestId);
  entry.resolve(decision === "allow");
}

async function sendDialogToActiveTab(
  requestId: string,
  title: string,
  description: string,
  details?: string,
): Promise<number> {
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  let targetTabId: number | undefined;

  // 1. Priority: active tab is in controllableTabs (AI-controlled tab)
  if (activeTab?.id !== undefined && controllableTabsRef.has(activeTab.id)) {
    targetTabId = activeTab.id;
  }
  // 2. Fallback: any AI-controlled tab
  else if (controllableTabsRef.size > 0) {
    targetTabId = [...controllableTabsRef][0];
  }
  // 3. Last resort: current active tab (even if not AI-controlled)
  else if (activeTab?.id !== undefined) {
    targetTabId = activeTab.id;
  }

  if (!targetTabId) throw new Error("No active tab for permission dialog");

  await browser.tabs.sendMessage(targetTabId, {
    action: "__brp_permission_dialog__",
    requestId,
    title,
    description,
    details,
  });

  return targetTabId;
}

export function formatPermissionPrompt(method: string, params: Record<string, unknown>): {
  title: string;
  description: string;
  details?: string;
} {
  switch (method) {
    case "script.execute": {
      const code = (params.code || params.script) as string | undefined;
      return {
        title: "AI is attempting to execute a script",
        description: "This could modify page content or access sensitive data.",
        ...(code ? { details: code.slice(0, 200) } : {}),
      };
    }
    case "page.navigate": {
      const url = (params.url || params.uri) as string || "unknown";
      return {
        title: "AI is navigating to a sensitive domain",
        description: "The target URL matches a sensitive domain in your permission settings.",
        details: url,
      };
    }
    case "element.click": {
      const selector = params.selector as { value?: unknown } | undefined;
      const detailValue = selector?.value ? String(selector.value) : undefined;
      return {
        title: "AI is attempting to click a sensitive button",
        description: "The button text matches a sensitive pattern (e.g. payment, delete).",
        ...(detailValue ? { details: detailValue } : {}),
      };
    }
    default:
      return {
        title: `AI requested: ${method}`,
        description: "This action requires your confirmation.",
      };
  }
}

// ─── v0.5.2 Tab Permission ───

/** Methods that require tab controllable check before execution. */
export const TAB_SCOPED_METHODS: ReadonlySet<string> = new Set([
  "page.navigate", "page.getInteractionTree", "page.screenshot",
  "page.goBack", "page.goForward", "page.reload", "page.waitForSelector",
  "element.click", "element.type", "element.fill", "element.scroll",
  "element.hover", "element.select", "element.getAttribute",
  "keyboard.press", "script.execute",
  "tab.close", "tab.select",
]);

/**
 * Check if a method is allowed on the given tab.
 * Returns true if:
 * - method is not tab-scoped (initialize, tab.list, tab.open, etc.)
 * - tabId is null/undefined (no tab context — e.g. no active tab)
 * - tab is in controllableTabs
 */
export function checkTabControllable(
  method: string,
  tabId: number | null | undefined,
  controllableTabs: ReadonlySet<number>,
): boolean {
  if (!TAB_SCOPED_METHODS.has(method)) return true;
  if (tabId === null || tabId === undefined) return true;
  return controllableTabs.has(tabId);
}

/**
 * Determine if a tab should be auto-demoted based on error code.
 * Only demotes on BRP_PERMISSION_DENIED (user E1 denial).
 * Does NOT demote on E2 blacklist, normal errors, or bridge errors.
 */
export function shouldDemoteTab(
  errorCode: string | undefined,
  method: string,
  tabId: number | null | undefined,
  controllableTabs: ReadonlySet<number>,
): boolean {
  if (errorCode !== "BRP_PERMISSION_DENIED") return false;
  if (!TAB_SCOPED_METHODS.has(method)) return false;
  if (tabId === null || tabId === undefined) return false;
  return controllableTabs.has(tabId);
}

// ─── v0.5.2 History Access ───

export function checkHistoryAccessError(permissionGranted: boolean): JsonObject | null {
  if (permissionGranted) return null;
  return {
    code: -32004,
    message: "History access not granted. Enable in extension options.",
    data: {
      errorCode: "BRP_HISTORY_PERMISSION_NOT_GRANTED",
      retriable: false,
      recoveryHint: "Enable history access in BRP Bridge extension options",
    },
  };
}

export function formatHistoryResults(
  items: Array<{ id?: string | undefined; url?: string | undefined; title?: string | undefined; lastVisitTime?: number | undefined; visitCount?: number | undefined }>,
): Array<{ id: string; url: string; title: string; lastVisitTime: number; visitCount: number }> {
  return items.map((h) => ({
    id: h.id ?? "",
    url: h.url ?? "",
    title: h.title ?? "",
    lastVisitTime: h.lastVisitTime ?? 0,
    visitCount: h.visitCount ?? 0,
  }));
}
