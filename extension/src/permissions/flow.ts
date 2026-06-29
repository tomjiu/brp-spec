/**
 * E1 Permission Gating — Flow Logic
 *
 * Orchestrates permission checks: loads config, calls checker,
 * handles dialog display, timeout, and response.
 *
 * Separated from background.ts for testability.
 */

import { shouldGate } from "./checker";
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
 * Reference to background.ts's agentTabIds Set.
 * Injected via registerAgentTabIds() at module load time.
 */
let agentTabIdsRef: ReadonlySet<number> = new Set();

/**
 * Register the background script's agentTabIds for dialog tab selection.
 * Call once from background.ts module top-level.
 */
export function registerAgentTabIds(ref: ReadonlySet<number>): void {
  agentTabIdsRef = ref;
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

  // 1. Priority: active tab is in agentTabIds (AI-controlled tab)
  if (activeTab?.id !== undefined && agentTabIdsRef.has(activeTab.id)) {
    targetTabId = activeTab.id;
  }
  // 2. Fallback: any AI-controlled tab
  else if (agentTabIdsRef.size > 0) {
    targetTabId = [...agentTabIdsRef][0];
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
